# Banksajt med CI/CD (GitHub Actions)

**Publicerad sajt:** http://13.61.15.216:3005
**Workflow:** [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)
**Alla körningar:** [Actions-fliken](https://github.com/Andreas00H/cicd-banksajt/actions)

Banksajten (Next.js + Express + MySQL i Docker Compose) från förra uppgiften, nu med CI/CD. Varje push till `main` kontrolleras automatiskt av GitHub Actions. Om kontrollerna går igenom deployas den nya versionen till AWS EC2, utan att jag behöver logga in på servern.

## Flödet

```
git push till main
  → GitHub Actions (.github/workflows/deploy.yml)
     ├─ Kontrollera frontend: npm ci → npm run lint → npm run build
     └─ Kontrollera backend:  npm ci → node --check
  → Checks passed
  → Deploy till EC2: SSH → git pull → docker compose up -d --build
  → Ny version körs på EC2
```

## Workflowen, jobb för jobb

| Jobb                     | Vad det gör                                                               | När det körs                                                      |
| ------------------------ | ------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **Kontrollera frontend** | `npm ci`, `npm run lint` och `npm run build` i `./frontend`               | Vid push och pull request mot `main`                              |
| **Kontrollera backend**  | `npm ci` och `node --check` på `server.js` och `db.js` (hittar syntaxfel) | Vid push och pull request mot `main`                              |
| **Deploy till EC2**      | Loggar in på servern med SSH och deployar med Docker Compose              | Bara vid push till `main`, och bara om båda kontrollerna är gröna |

- **`working-directory: ./frontend`** används eftersom frontendens `package.json` ligger i `frontend/`, inte i roten.
- **`npm ci`** installerar exakt det som står i `package-lock.json`, vilket ger samma resultat varje gång.
- **Lint körs med `--max-warnings=0`**, så även en varning stoppar pipelinen.
- **`needs: [frontend, backend]`** gör att deployen väntar på kontrollerna. Trasig kod når aldrig servern.
- **`if: github.event_name == 'push' …`** gör att pull requests bara kontrolleras och aldrig deployas.
- **`concurrency`** gör att två deployer aldrig kör samtidigt om man pushar snabbt flera gånger.

## Del 3: CI stoppar trasig kod

I körning **#2** lade jag med flit till `frontend/app/lint-test.tsx` med en `<img>` utan alt-text. ESLint gav två varningar, och med `--max-warnings=0` misslyckades steget **Run frontend lint**. Frontend-jobbet blev rött, backend-jobbet grönt (det påverkades inte), och ingen deploy gjordes. I körning **#3** tog jag bort filen och pipelinen blev grön igen.

[Se den misslyckade körningen](https://github.com/Andreas00H/cicd-banksajt/actions?query=is%3Afailure)

## GitHub Secrets

Skapade under **Settings → Secrets and variables → Actions**:

| Namn       | Innehåll                     |
| ---------- | ---------------------------- |
| `HOST`     | Serverns IP-adress           |
| `USERNAME` | Användaren på servern        |
| `SSH_KEY`  | Privat SSH-nyckel för deploy |

Värdena finns aldrig i koden, i README:n eller i skärmdumpar. GitHub döljer dem även i loggarna och visar `***` i stället.

`SSH_KEY` är en **egen nyckel bara för GitHub Actions** (ed25519), inte min vanliga inloggningsnyckel. Den publika delen ligger i `~/.ssh/authorized_keys` på servern. Om nyckeln skulle läcka kan jag ta bort just den raden, och min egen inloggning fortsätter fungera.

## Deploy-skriptet

Deploy-jobbet använder `appleboy/ssh-action` och kör detta på servern:

```bash
set -e                                  # stoppa direkt om något kommando misslyckas
cd /home/ubuntu/cicd-banksajt           # projektets egen mapp på servern
git pull                                # hämta senaste koden från GitHub
sudo docker compose up -d --build       # bygg om och starta om det som ändrats
sudo docker image prune -f              # ta bort gamla, oanvända images
sudo docker builder prune -f --filter until=24h   # ta bort byggcache äldre än ett dygn
sudo docker compose ps                  # visa i loggen att containrarna körs
```

**Varför `--build`?** `docker compose restart` startar bara om de containrar som redan finns, med den gamla koden. `up -d --build` bygger nya images från den nya koden, så att ändringarna faktiskt kommer med.

**Varför inte `docker compose down` först?** Då skulle sajten vara nere under hela bygget (flera minuter). `up -d --build` bygger först och byter sedan bara ut de containrar som har ändrats.

**Varför städa?** Varje ombygge lämnar kvar gamla images och byggcache. Utan städning skulle disken bli full efter några deployer, och då kan alla sajter på servern sluta fungera.

## Servern (AWS EC2)

- Ubuntu 26.04 på en t3.micro (1 GB RAM) i Europe (Stockholm).
- Projektet ligger i en **egen mapp** (`~/cicd-banksajt`) med **egna portar**, så det krockar inte med mina tidigare inlämningar på samma server (port 80, 3000 och 3002):
  - frontend på port **3005** (öppnad i AWS security group)
  - MySQL på **127.0.0.1:3308** (nås bara inifrån servern)
- Portar och feature flag styrs av en `.env`-fil som bara finns på servern (den står i `.gitignore`):

```
  FRONTEND_PORT=3005
  MYSQL_PORT=127.0.0.1:3308
  FEATURE_SAVINGS=true
```

- Next.js-bygget kräver mer minne än 1 GB, så jag lade till en andra swapfil på 2 GB (totalt 4 GB swap).

## Del 6: Kontroll av deploymenten

1. GitHub Actions är grönt för alla jobb (utom körning #2, som var röd med flit).
2. Next.js-frontenden fungerar på http://13.61.15.216:3005.
3. Express-backenden svarar som tidigare: man kan skapa konto, logga in och sätta in pengar.
4. Den senaste versionen körs på EC2: jag lade till en synlig ruta på startsidan (_"🚀 Den här versionen deployades automatiskt med GitHub Actions"_), pushade, och den dök upp på servern utan att jag loggade in där.

## Köra lokalt

Docker Desktop är det enda som behövs:

```bash
docker compose up -d --build
```

- Sajten: http://localhost:3000
- Vill du se Sparmål-panelen lokalt: skapa en `.env` i roten med `FEATURE_SAVINGS=true` och kör kommandot igen.

Samma kontroller som CI:

```bash
cd frontend && npm ci && npm run lint && npm run build
cd ../backend && npm ci && node --check server.js && node --check db.js
```

## VG: Feature flag, Sparmål

### Funktionen

En **🎯 Sparmål**-panel på kontosidan som visar hur nära man är ett sparmål på 10 000 kr, med förloppsindikator och hur mycket som är kvar.

### Så fungerar flaggan

| Fil                                       | Uppgift                                                                                  |
| ----------------------------------------- | ---------------------------------------------------------------------------------------- |
| `frontend/components/savings-panel.tsx`   | Själva Sparmål-panelen                                                                   |
| `frontend/lib/features.ts`                | Läser flaggan: bara exakt `"true"` räknas som på, allt annat är av                       |
| `frontend/app/account/page.tsx`           | Läser flaggan **på servern vid varje besök** (med `connection()`) och skickar den vidare |
| `frontend/app/account/account-client.tsx` | Kontosidan, som visar panelen bara om flaggan är på                                      |
| `docker-compose.yml`                      | Skickar `FEATURE_SAVINGS` från `.env` in i frontend-containern (standard `false`)        |

Flaggan läses när sidan besöks, inte när sajten byggs. Därför kan funktionen slås på och av **utan att bygga om koden**.

### Deployment är inte samma sak som release

**1. Deployment (flaggan av):** koden pushades med `FEATURE_SAVINGS=false` i serverns `.env`. GitHub Actions byggde och deployade den (körning #6). Koden fanns i produktion, men kontosidan såg ut exakt som förut.

**2. Release (flaggan på):** på servern ändrade jag `.env` till `FEATURE_SAVINGS=true` och körde:

```bash
sudo docker compose up -d
```

Inget nytt bygge och ingen ny push. Docker startade bara om frontend-containern med den nya flaggan, på under 2 sekunder, och Sparmål-panelen blev synlig.

|              | Deployment                  | Release                                         |
| ------------ | --------------------------- | ----------------------------------------------- |
| Vad händer   | Ny kod hamnar i produktion  | Funktionen blir synlig för användaren           |
| Hur          | `git push` → GitHub Actions | Ändra flaggan i `.env` → `docker compose up -d` |
| Byggs något? | Ja                          | Nej                                             |

Blir något fel kan funktionen stängas av direkt genom att sätta flaggan till `false` igen, utan att behöva backa koden.

**Status just nu:** flaggan är **på**, alltså är Sparmål releasad.
