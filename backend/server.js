import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import { initDatabase, query, withTransaction } from "./db.js";
import { validateAmount } from "./src/validateAmount.js";

const app = express();
const port = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Generera engångslösenord
function generateOTP() {
  // Generera en sexsiffrig numerisk OTP
  const otp = Math.floor(100000 + Math.random() * 900000);
  return otp.toString();
}

// Generera ett engångslösenord som ingen annan session redan har.
// Annars skulle två användare kunna få samma token och se varandras konto.
async function generateUniqueOTP() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const token = generateOTP();
    const taken = await query("SELECT id FROM sessions WHERE token = ? LIMIT 1", [token]);
    if (taken.length === 0) return token;
  }
  throw new Error("Kunde inte skapa ett unikt engångslösenord.");
}

// Hämtar token från headern "Authorization: Bearer 123456"
function tokenFromHeader(req) {
  const header = req.get("authorization") ?? "";
  const [scheme, token] = header.split(" ");
  return scheme === "Bearer" && token ? token.trim() : null;
}

// Hjälpfunktion: hitta kontot som hör till en token, eller null
async function findAccountByToken(token) {
  const rows = await query(
    `SELECT accounts.id, accounts.amount
     FROM sessions
     JOIN accounts ON accounts.user_id = sessions.user_id
     WHERE sessions.token = ?
     ORDER BY sessions.id DESC
     LIMIT 1`,
    [String(token ?? "")],
  );
  return rows[0] ?? null;
}

// Skapa användare – Create (INSERT)
app.post("/users", async (req, res) => {
  const { username, password } = req.body ?? {};

  if (typeof username !== "string" || typeof password !== "string" || !username.trim() || !password) {
    return res.status(400).json({ error: "Användarnamn och lösenord krävs." });
  }

  try {
    const result = await query("INSERT INTO users (username, password) VALUES (?, ?)", [
      username.trim(),
      password,
    ]);

    // Varje ny användare får ett bankkonto med 0 kr
    await query("INSERT INTO accounts (user_id, amount) VALUES (?, 0)", [result.insertId]);

    res.status(201).json({ id: result.insertId, username: username.trim() });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ error: "Användarnamnet är redan taget." });
    }
    console.error(error);
    res.status(500).json({ error: "Kunde inte skapa användaren." });
  }
});

// Logga in – Read (SELECT) och Create (INSERT i sessions)
app.post("/sessions", async (req, res) => {
  const { username, password } = req.body ?? {};

  try {
    const users = await query("SELECT id FROM users WHERE username = ? AND password = ?", [
      String(username ?? "").trim(),
      String(password ?? ""),
    ]);

    if (users.length === 0) {
      return res.status(401).json({ error: "Fel användarnamn eller lösenord." });
    }

    const token = await generateUniqueOTP();
    await query("INSERT INTO sessions (user_id, token) VALUES (?, ?)", [users[0].id, token]);

    res.json({ token });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Kunde inte logga in." });
  }
});

// Visa saldo – Read (SELECT)
app.post("/me/accounts", async (req, res) => {
  try {
    const account = await findAccountByToken(req.body?.token);

    if (!account) {
      return res.status(401).json({ error: "Ogiltigt engångslösenord." });
    }

    res.json({ amount: Number(account.amount) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Kunde inte hämta saldot." });
  }
});

// Kontroll att servern och databasen svarar (används av Docker healthcheck)
app.get("/health", async (req, res) => {
  try {
    await query("SELECT 1");
    res.json({ status: "ok" });
  } catch {
    res.status(503).json({ status: "error" });
  }
});

// Sätt in pengar – Update (UPDATE) + Create (INSERT i transactions)
app.post("/me/accounts/transactions", async (req, res) => {
  try {
    const account = await findAccountByToken(req.body?.token);

    if (!account) {
      return res.status(401).json({ error: "Ogiltigt engångslösenord." });
    }

    // Samma funktion som testas med Vitest (src/validateAmount.js)
    const result = validateAmount(req.body?.amount);
    if (!result.ok) {
      return res.status(400).json({ error: result.error });
    }

    // Saldo och transaktion sparas tillsammans. Om något går fel
    // ångras båda, så historiken och saldot kan aldrig visa olika saker.
    const newAmount = await withTransaction(async (tx) => {
      // FOR UPDATE låser kontot tills transaktionen är klar
      await tx("SELECT amount FROM accounts WHERE id = ? FOR UPDATE", [account.id]);
      await tx("UPDATE accounts SET amount = amount + ? WHERE id = ?", [result.amount, account.id]);
      await tx("INSERT INTO transactions (account_id, type, amount) VALUES (?, 'deposit', ?)", [
        account.id,
        result.amount,
      ]);
      const rows = await tx("SELECT amount FROM accounts WHERE id = ?", [account.id]);
      return Number(rows[0].amount);
    });

    res.json({ amount: newAmount });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Insättningen misslyckades." });
  }
});

// Transaktionshistorik – Read (SELECT)
// Kräver headern "Authorization: Bearer <token>". Visar bara den
// inloggade användarens egna transaktioner, senaste först.
app.get("/me/accounts/transactions", async (req, res) => {
  const token = tokenFromHeader(req);

  if (!token) {
    return res.status(401).json({ error: "Du måste vara inloggad för att se transaktioner." });
  }

  try {
    const account = await findAccountByToken(token);

    if (!account) {
      return res.status(401).json({ error: "Ogiltigt engångslösenord. Logga in igen." });
    }

    // UNIX_TIMESTAMP ger tiden i sekunder oberoende av serverns tidszon
    const rows = await query(
      `SELECT id, type, amount, UNIX_TIMESTAMP(created_at) AS created
       FROM transactions
       WHERE account_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT 200`,
      [account.id],
    );

    res.json({
      transactions: rows.map((row) => ({
        id: row.id,
        type: row.type,
        amount: Number(row.amount),
        createdAt: new Date(Number(row.created) * 1000).toISOString(),
      })),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Kunde inte hämta transaktionerna." });
  }
});

// Anslut till databasen först, starta sedan servern
try {
  await initDatabase();
} catch (error) {
  console.error("Kunde inte ansluta till databasen. Är MySQL (t.ex. MAMP) igång?");
  console.error(error.message);
  process.exit(1);
}

app.listen(port, () => {
  console.log(`Bankens backend körs på http://localhost:${port}`);
});
