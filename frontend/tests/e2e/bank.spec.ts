import { expect, test, type Page } from "@playwright/test";

// Unikt användarnamn varje gång, så att testerna fungerar även när de körs flera
// gånger mot samma databas (och när flera tester körs samtidigt).
function uniqueUsername(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const PASSWORD = "hemligt123";

async function register(page: Page, username: string) {
  await page.goto("/register");
  await page.getByLabel("Användarnamn").fill(username);
  await page.getByLabel("Lösenord").fill(PASSWORD);
  await page.getByRole("button", { name: "Skapa användare" }).click();
  await expect(page.getByText("Användaren är skapad!")).toBeVisible();
}

async function login(page: Page, username: string) {
  await page.goto("/login");
  await page.getByLabel("Användarnamn").fill(username);
  await page.getByLabel("Lösenord").fill(PASSWORD);
  await page.getByRole("button", { name: "Logga in" }).click();
  await expect(page.getByRole("heading", { name: "Mitt konto" })).toBeVisible();
}

async function registerAndLogin(page: Page, prefix: string) {
  const username = uniqueUsername(prefix);
  await register(page, username);
  await login(page, username);
  return username;
}

// Kontrollerar hela saldot, t.ex. "Saldo 140 kr" (så att "40 kr" inte räknas som "140 kr")
async function expectBalance(page: Page, text: string) {
  await expect(page.getByRole("region", { name: "Saldo" })).toHaveText(
    new RegExp(`^Saldo\\s*${text}$`),
  );
}

async function deposit(page: Page, amount: string) {
  await page.getByLabel("Belopp att sätta in").fill(amount);
  await page.getByRole("button", { name: "Sätt in" }).click();
}

async function withdraw(page: Page, amount: string) {
  await page.getByLabel("Belopp att ta ut").fill(amount);
  await page.getByRole("button", { name: "Ta ut" }).click();
}

function transactionItems(page: Page) {
  return page.getByRole("list", { name: "Transaktioner" }).getByRole("listitem");
}

async function openHistory(page: Page) {
  await page.getByRole("link", { name: "Visa transaktionshistorik" }).click();
  await expect(page.getByRole("heading", { name: "Transaktioner" })).toBeVisible();
}

test("en besökare utan inloggning kan inte se kontot eller historiken", async ({ page }) => {
  await page.goto("/account");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "Logga in" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Mitt konto" })).not.toBeVisible();

  await page.goto("/transactions");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "Transaktioner" })).not.toBeVisible();
});

test("en ny användare kan registrera sig, logga in, sätta in pengar och se insättningen i historiken", async ({
  page,
}) => {
  await registerAndLogin(page, "ny");
  await expectBalance(page, "0 kr");

  // Tomt läge innan någon insättning finns
  await openHistory(page);
  await expect(page.getByText("Inga transaktioner än")).toBeVisible();
  await page.getByRole("link", { name: "Tillbaka till kontot" }).click();

  await deposit(page, "250");
  await expect(page.getByText("Du satte in 250 kr.")).toBeVisible();
  await expectBalance(page, "250 kr");

  await openHistory(page);
  await expect(transactionItems(page)).toHaveCount(1);
  await expect(transactionItems(page).first()).toContainText("Insättning");
  await expect(transactionItems(page).first()).toContainText("+250 kr");
  await expect(page.getByText("Inga transaktioner än")).not.toBeVisible();
});

test("historiken finns kvar efter omladdning och ny inloggning, senaste först", async ({ page }) => {
  const username = await registerAndLogin(page, "historik");

  await deposit(page, "100");
  await expectBalance(page, "100 kr");
  await deposit(page, "40");
  await expectBalance(page, "140 kr");

  await openHistory(page);
  await expect(transactionItems(page)).toHaveCount(2);
  await expect(transactionItems(page).first()).toContainText("+40 kr");
  await expect(transactionItems(page).last()).toContainText("+100 kr");

  // Omladdning
  await page.reload();
  await expect(transactionItems(page)).toHaveCount(2);
  await expect(transactionItems(page).first()).toContainText("+40 kr");

  // Logga ut och in igen
  await page.getByRole("link", { name: "Tillbaka till kontot" }).click();
  await page.getByRole("button", { name: "Logga ut" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await login(page, username);
  await expectBalance(page, "140 kr");

  await openHistory(page);
  await expect(transactionItems(page)).toHaveCount(2);
});

test("ett ogiltigt belopp ändrar varken saldo eller historik", async ({ page }) => {
  await registerAndLogin(page, "ogiltigt");

  await deposit(page, "100");
  await expectBalance(page, "100 kr");

  await deposit(page, "0");
  await expect(page.getByText("Beloppet måste vara större än noll.")).toBeVisible();

  await deposit(page, "-50");
  await expect(page.getByText("Beloppet måste vara större än noll.")).toBeVisible();

  await deposit(page, "");
  await expect(page.getByText("Beloppet måste vara ett tal.")).toBeVisible();

  await expectBalance(page, "100 kr");

  // Även efter omladdning: samma saldo och bara den giltiga insättningen
  await page.reload();
  await expectBalance(page, "100 kr");
  await openHistory(page);
  await expect(transactionItems(page)).toHaveCount(1);
  await expect(transactionItems(page).first()).toContainText("+100 kr");
});

test("två användare ser bara sin egen historik", async ({ browser }) => {
  // Två separata webbläsarsessioner, som två olika personer
  const annaContext = await browser.newContext();
  const boContext = await browser.newContext();
  const anna = await annaContext.newPage();
  const bo = await boContext.newPage();

  await registerAndLogin(anna, "anna");
  await registerAndLogin(bo, "bo");

  await deposit(anna, "300");
  await expectBalance(anna, "300 kr");
  await deposit(bo, "45");
  await expectBalance(bo, "45 kr");

  await openHistory(anna);
  await expect(transactionItems(anna)).toHaveCount(1);
  await expect(transactionItems(anna).first()).toContainText("+300 kr");

  await openHistory(bo);
  await expect(transactionItems(bo)).toHaveCount(1);
  await expect(transactionItems(bo).first()).toContainText("+45 kr");

  await annaContext.close();
  await boContext.close();
});

// ---------- VG: uttag med skydd mot övertrassering ----------

test("VG: ett lyckat uttag minskar saldot och syns som uttag i historiken, även efter omladdning", async ({
  page,
}) => {
  await registerAndLogin(page, "uttag");

  await deposit(page, "500");
  await expectBalance(page, "500 kr");

  await withdraw(page, "200");
  await expect(page.getByText("Du tog ut 200 kr.")).toBeVisible();
  await expectBalance(page, "300 kr");

  await openHistory(page);
  await expect(transactionItems(page)).toHaveCount(2);
  // Senaste först: uttaget överst, skilt från insättningen
  await expect(transactionItems(page).first()).toContainText("Uttag");
  await expect(transactionItems(page).first()).toContainText("-200 kr");
  await expect(transactionItems(page).last()).toContainText("Insättning");
  await expect(transactionItems(page).last()).toContainText("+500 kr");

  // Efter omladdning finns samma historik och rätt saldo kvar
  await page.reload();
  await expect(transactionItems(page)).toHaveCount(2);
  await expect(transactionItems(page).first()).toContainText("-200 kr");
  await page.getByRole("link", { name: "Tillbaka till kontot" }).click();
  await expectBalance(page, "300 kr");
});

test("VG: ett uttag större än saldot nekas och ändrar varken saldo eller historik", async ({
  page,
}) => {
  await registerAndLogin(page, "nekat");

  await deposit(page, "100");
  await expectBalance(page, "100 kr");

  // Mer än saldot
  await withdraw(page, "150");
  await expect(page.getByText("Du har inte tillräckligt med pengar på kontot.")).toBeVisible();
  await expectBalance(page, "100 kr");

  // Ogiltigt belopp
  await withdraw(page, "0");
  await expect(page.getByText("Beloppet måste vara större än noll.")).toBeVisible();
  await expectBalance(page, "100 kr");

  // Efter omladdning: samma saldo och bara insättningen i historiken
  await page.reload();
  await expectBalance(page, "100 kr");
  await openHistory(page);
  await expect(transactionItems(page)).toHaveCount(1);
  await expect(transactionItems(page).first()).toContainText("Insättning");
  await expect(page.getByText("Uttag")).not.toBeVisible();
});
