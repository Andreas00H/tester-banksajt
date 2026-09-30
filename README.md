# Banksajt med tester och CI/CD (Vitest + Playwright)

**Publicerad sajt:** http://13.61.15.216:3006
**Workflow:** [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)
**Alla körningar:** [Actions-fliken](https://github.com/Andreas00H/tester-banksajt/actions)

Banksajten (Next.js + Express + MySQL i Docker Compose) från de tidigare uppgifterna, nu med transaktionshistorik, uttag, enhetstester med Vitest och E2E-tester med Playwright. GitHub Actions kör alla tester vid varje push och pull request. **Bara om allt är grönt** deployas den nya versionen till AWS EC2.

## Flödet

```
Ändra kod → testa lokalt → push / pull request
  → GitHub Actions
     ├─ Kontrollera frontend:        npm ci → npm run lint → npm run build
     ├─ Kontrollera backend (Vitest): npm ci → node --check → npm test
     └─ E2E-tester (Playwright):     Docker Compose med tom testdatabas → npm run test:e2e
  → deploy endast om ALLT är grönt, och bara vid push till main
  → Deploy till EC2: SSH → git pull → docker compose up -d --build
```

## Del 1: Transaktionshistorik

| Del | Fil | Vad den gör |
| --- | --- | --- |
| Databas | `backend/db.js`, `database/init.sql` | Tabellen `transactions` (konto, typ, belopp, tidpunkt). Backend skapar tabellen om den saknas, så även en databas som redan finns får den (`init.sql` körs bara när en ny databas skapas). |
| Insättning | `POST /me/accounts/transactions` | Saldot och transaktionsraden sparas i **samma databastransaktion** (`withTransaction` i `db.js`). Går något fel ångras båda, så historiken och saldot kan aldrig visa olika saker. |
| Historik | `GET /me/accounts/transactions` | Kräver headern `Authorization: Bearer <token>`. Visar bara den inloggade användarens egna transaktioner, senaste först. Saknad token ger 401 "Du måste vara inloggad…", ogiltig token ger 401 "Ogiltigt engångslösenord…". |
| Sida | `frontend/app/transactions/page.tsx` | Visar belopp och datum (svensk tid), ett tomt läge när det inte finns några transaktioner, och en länk tillbaka till kontot. Utloggade besökare skickas till inloggningen. |
| Länk | `frontend/app/account/account-client.tsx` | "Visa transaktionshistorik" på kontosidan. |

Jag fixade också en säkerhetslucka: engångslösenordet är bara sex siffror, så två användare kunde råka få samma token och då se varandras konto. Nu skapas bara tokens som ingen annan session har (`generateUniqueOTP` i `server.js`).

## Del 2: Enhetstester med Vitest (backend)

Reglerna för belopp ligger i egna filer som både routerna och testerna använder. Testerna testar alltså den riktiga koden, inte en kopia.

```
backend/
  src/validateAmount.js            ← belopp: ändligt tal, större än 0, högst 1 000 000 kr, högst två decimaler
  src/validateWithdrawal.js        ← VG: uttag får inte vara större än saldot
  tests/validateAmount.test.js     ← 12 tester: giltigt belopp, 0, negativt, NaN, Infinity, text, decimaler …
  tests/validateWithdrawal.test.js ← 8 tester (VG)
```

```bash
cd backend && npm ci && npm test      # kör "vitest run" en gång
```

## Del 3: E2E-tester med Playwright (frontend)

`frontend/tests/e2e/bank.spec.ts` öppnar sajten i Chromium och använder den riktiga backenden och databasen i Docker Compose. Testerna använder `getByRole()` och `getByLabel()` och kontrollerar det användaren ser med `expect()`.

| Test | Kontrollerar |
| --- | --- |
| Utan inloggning | `/account` och `/transactions` skickar besökaren till inloggningen |
| Ny användare | registrera → logga in → tomt läge i historiken → sätt in → rätt saldo och samma insättning i historiken |
| Historiken finns kvar | två insättningar, senaste först, kvar efter omladdning och efter utloggning och ny inloggning |
| Ogiltigt belopp | 0, negativt och tomt ger felmeddelande och ändrar varken saldo eller historik |
| Två användare | varje användare ser bara sin egen historik |
| VG: lyckat uttag | saldot minskar, uttaget syns som "Uttag" skilt från insättningen, kvar efter omladdning |
| VG: nekat uttag | för stort uttag och 0 kr nekas, saldo och historik oförändrade efter omladdning |

**Separat testdatabas:** `docker-compose.test.yml` används tillsammans med `docker-compose.yml`. Den ger testmiljön ett eget projektnamn (`bank-test`), en **tom databas som bara ligger i minnet** (tmpfs) och frontend på `127.0.0.1:3100`. Testerna rör alltså aldrig den publicerade sajten eller dess databas. Varje test skapar egna unika användare, så testerna kan köras många gånger och parallellt.

**Ingen fast väntan:** `docker compose up --wait` väntar tills alla tjänster har healthchecks som svarar (MySQL, backendens `/health` och frontendens startsida) innan testerna startar. Inga `waitForTimeout()`.

## Del 4: GitHub Actions

Workflowet är samma som i CI/CD-uppgiften, utökat med testjobb. Ingen ny deploymentväg har lagts till.

- Körs vid **push och pull request till `main`**.
- Jobben `frontend`, `backend` och `e2e` körs parallellt.
- `deploy` har `needs: [frontend, backend, e2e]` och `if: github.event_name == 'push' && github.ref == 'refs/heads/main'`. Deploy sker alltså **bara om alla tester är gröna**, och **aldrig från en pull request**.
- E2E-jobbet installerar Chromium med `npx playwright install --with-deps chromium`, startar hela stacken med en färsk testdatabas och visar containrarnas loggar om något går fel.

### Bevis: ett rött test stoppar deployen

| Körning | Vad jag gjorde | Resultat |
| --- | --- | --- |
| #2 | Ändrade ett förväntat resultat i ett Vitest-test (500 → 5000) | Backend-jobbet **rött**, frontend och Playwright gröna, **Deploy till EC2 hoppades över** |
| #3 | Återställde testet | Alla jobb gröna, deploy kördes |

### GitHub Secrets

| Namn | Innehåll |
| --- | --- |
| `HOST` | Serverns IP-adress |
| `USERNAME` | Användaren på servern |
| `SSH_KEY` | Privat SSH-nyckel som bara används för deploy |

Värdena finns aldrig i koden, i README:n, i loggar eller i skärmdumpar.

## Servern (AWS EC2)

- Ubuntu på en t3.micro (1 GB RAM + 4 GB swap).
- Projektet ligger i en **egen mapp** (`~/tester-banksajt`) med **egna portar**, så mina tidigare inlämningar på samma server (port 80, 3000, 3002 och 3005) inte påverkas:
  - frontend på port **3006** (öppnad i AWS security group)
  - MySQL på **127.0.0.1:3309** (nås bara inifrån servern)
- Portarna sätts i en `.env`-fil som bara finns på servern.
- **Mindre Docker-image:** frontenden byggs i två steg med Next.js `output: "standalone"`. Den färdiga imagen innehåller bara servern, inte alla paket och all källkod, och blev därför ungefär 400 MB i stället för ungefär 1,5 GB. Det spelar roll eftersom servern har begränsat med diskutrymme.
- MySQL körs med `--performance-schema=OFF` och en mindre buffer pool för att dra mindre minne.

## Köra lokalt

Krav: Node 24 och Docker Desktop.

```bash
# Enhetstester (backend)
cd backend && npm ci && npm test

# Lint och build (frontend)
cd ../frontend && npm ci && npm run lint && npm run build

# E2E-tester mot en tom testdatabas i Docker
npx playwright install chromium   # första gången
npm run e2e:up                    # startar testmiljön och väntar tills den svarar
npm run test:e2e                  # kör Playwright
npm run e2e:down                  # stänger testmiljön och tar bort testdatabasen
```

Vanliga sajten lokalt: `docker compose up -d --build` i projektets rot, sedan http://localhost:3000.

## VG: Uttag med skydd mot övertrassering

- **Kontosidan** har ett formulär "Belopp att ta ut" med knappen **Ta ut**.
- **Backend:** `POST /me/accounts/withdrawals` kontrollerar beloppet med `validateAmount` och sedan saldot med `validateWithdrawal`, inuti en databastransaktion där kontot är låst (`SELECT … FOR UPDATE`). Två uttag samtidigt kan därför inte tillsammans ta ut mer än saldot. Jag testade fem samtidiga uttag à 30 kr från 100 kr: exakt tre lyckades och saldot blev 10 kr.
- **Nekade uttag** (ogiltigt belopp eller större än saldot) ger ett tydligt felmeddelande och ändrar **varken saldo eller historik**.
- **Historiken** visar uttag som "Uttag **-200 kr**" i rött, skilt från insättningar som visas som "Insättning **+500 kr**" i grönt.
- **Tester:** 8 Vitest-tester för reglerna (giltigt uttag, hela saldot, för stort uttag, ett öre för mycket, saldo 0, ogiltiga belopp) och 2 Playwright-tester (lyckat uttag och nekat uttag, båda kontrollerade efter omladdning).
- De nya testerna körs i **samma jobb** som redan stoppar deployen, så ett fel i uttagsreglerna skulle också stoppa den.

## Frågor från lektionen

1. **Vad testar Playwright som enhetstester inte testar?** Att hela flödet fungerar för en användare i en riktig webbläsare: att knappar och formulär fungerar, att frontend, backend och databas pratar med varandra och att rätt sak syns på sidan.
2. **Varför behövs `webServer` i Playwright?** Den startar sajten innan testerna körs. Här startar jag i stället hela stacken med Docker Compose i ett eget steg (`e2e:up`), så därför behövs ingen `webServer`.
3. **Skillnaden mellan grönt lokalt och grönt i Actions?** Actions kör på en helt ny dator varje gång, med `npm ci` från lockfilen och en tom databas. Grönt där visar att projektet fungerar för vem som helst, inte bara på min dator.
4. **Rimliga flöden att testa på banksajten:** registrering, inloggning, insättning, uttag, att saldot stämmer och att historiken bara visar ens egna transaktioner.
