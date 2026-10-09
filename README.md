# Northbridge Bank

Full-stack online banking platform: a customer portal (transfers, receipts, security settings) and an administrator panel (customer onboarding, transfer approvals, audit log, system settings), backed by a double-entry ledger.

## Tech stack

| Layer    | Choice                                                          |
| -------- | --------------------------------------------------------------- |
| Server   | Node >= 22.5, Express 4, Zod validation, ESM                     |
| Database | SQLite via Node's built-in `node:sqlite` (no native build step) |
| Client   | React 18, Vite 6, react-router 6 (SPA)                          |
| Mirror   | Optional Firebase Firestore mirror via `firebase-admin`         |

## Features

**Customer portal** — registration, session login, dashboard, money transfers (quote → PIN confirmation → receipt), transaction history, transfer browser with search, profile and avatar upload, password / transfer-PIN changes, active-session review and revocation.

**Admin panel** — customer onboarding (with server-generated transfer PIN), funding and balance adjustments, transfer approval queue (toggleable), bank catalogue management, immutable audit log, system settings (transfer limits, fees, approval requirement), freeze / block account status controls.

**Ledger integrity** — every movement is a ledger entry; balances are reconstructed from entries, negative balances are blocked by a database constraint, and settled rows cannot be deleted or updated.

## Quick start

```bash
git clone https://github.com/urchfundz1-netizen/North-Bridge-.git
cd North-Bridge-
npm install

copy .env.example .env      # Windows: Copy-Item .env.example .env
# edit .env - at minimum keep SESSION_SECRET unique

npm run migrate             # applies schema + reference data (idempotent)
npm run seed:admin          # creates the bootstrap administrator
npm run dev                 # server on :4000, client on :5173
```

Sign in at `http://localhost:5173/admin` with `ADMIN_EMAIL` / `ADMIN_PASSWORD` from `.env` (defaults: `admin@northbridge.bank` / `ChangeMe_Admin#2024` — change them).

## Scripts

| Script                  | What it does                                                     |
| ----------------------- | ---------------------------------------------------------------- |
| `npm run dev`           | Server (watch) + client (Vite) concurrently                      |
| `npm run dev:server`    | API only, `node --watch`                                         |
| `npm run dev:client`    | Vite dev server only                                             |
| `npm run build`         | Production client build into `client/dist`                       |
| `npm start`             | Run the server (serves `client/dist` when `NODE_ENV=production`)  |
| `npm run migrate`       | Idempotent schema migration + reference seed                     |
| `npm run seed`          | Top up settings and bank catalogue (safe to re-run)              |
| `npm run seed:admin`    | Create/refresh the bootstrap administrator                       |
| `npm run firestore:backfill` | Mirror existing SQLite rows into Firestore                   |
| `npm test`              | Server test suite (in-memory SQLite, 75 tests)                   |
| `npm run lint`          | ESLint across server, client and scripts                         |
| `npm run smoke`         | End-to-end HTTP smoke test against a **running** server          |
| `npm run check:svg`     | Validate the bank illustration SVG                               |

`npm run smoke` expects the API at `http://localhost:4000` with seeded admin credentials; override with `SMOKE_BASE`, `SMOKE_ADMIN_EMAIL`, `SMOKE_ADMIN_PASSWORD`.

## Project layout

```
server/
  src/core/        config, crypto (scrypt), errors, money, sessions
  src/db/          connection, schema.sql, migrations, seeds, Firestore backfill
  src/middleware/  auth, CSRF-aware validation, throttling, error handler
  src/routes/      auth, account, transfers + admin/* (customers, transfers, banks, system)
  src/services/    ledger, transfers, receipts, audit, settings, Firestore mirror
  test/            node:test suite against isolated in-memory databases
client/
  src/pages/       public / customer / admin routes
  src/components/  UI primitives, layout, icons
  src/api/         fetch wrapper with cookie + CSRF handling
scripts/           smoke test, SVG checker
firestore.rules    Firestore security rules for the optional mirror
Dockerfile         multi-stage image (build SPA, then run the server)
docker-compose.yml app + Caddy stack with a persistent data volume
Caddyfile          reverse proxy + automatic TLS
```

## Environment

All configuration lives in `.env` (never committed) — see `.env.example` for the annotated full list. Highlights:

- `CLIENT_ORIGIN` — must match the real client origin; the server refuses to boot in production while it is still a loopback address (silent CORS failures otherwise).
- `REQUIRE_TRANSFER_APPROVAL` — `1` keeps transfers Pending until an admin approves them; `0` settles immediately.
- `TRANSFER_FEE_CENTS`, `MIN_TRANSFER_CENTS`, `MAX_TRANSFER_CENTS` — fee and guard rails.
- `FIREBASE_ENABLED=0` (default) turns the Firestore mirror off entirely; SQLite stays the source of truth.

## Deploying (Docker + Oracle Cloud Always Free)

The app is a single Node process that serves the API and the built SPA from one origin, so it deploys as one container. `docker-compose.yml` runs it behind Caddy, which terminates TLS and reverse-proxies to the app. SQLite and avatar uploads live on a named volume, so they survive redeploys and reboots.

**Why Oracle Cloud**: the *Always Free* tier includes a VM and persistent storage with no time limit, which is the only way to get a free persistent disk for a stateful Node app in 2026. It needs a card for identity verification, but the free resources are never charged. (Render's free instance has no disk, and Fly.io and Koyeb no longer offer free persistent volumes.)

### 1. Create the VM

1. Sign up at [cloud.oracle.com](https://cloud.oracle.com) and open **Compute → Instances → Create instance**.
2. Image: **Ubuntu 24.04**. Shape: **Ampere A1.Flex** (2 OCPU / 12 GB) is within the Always Free allowance; the **E2.1.Micro** (1 GB) also works but is tight for the client build — add swap if you use it.
3. Under **Networking**, ensure the subnet allows ingress on TCP **80** and **443** (add rules to the VCN Security List if needed).
4. Add your SSH key and create the instance.

### 2. Prepare the VM

```bash
# On the instance (SSH in as the default user)
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2
sudo usermod -aG docker "$USER"   # log out and back in for this to apply

# Open the OS firewall (Ubuntu images ship an iptables ruleset that drops 80/443)
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

### 3. Configure and start

```bash
git clone https://github.com/urchfundz1-netizen/North-Bridge-.git
cd North-Bridge-
```

Create a `.env` in the repo root (read by both Compose and the app):

```ini
# Use a domain you control, or <public-ip>.sslip.io for TLS without owning one.
DOMAIN=bank.example.com
CLIENT_ORIGIN=https://bank.example.com

SESSION_SECRET=<paste 48 random bytes as hex>
ADMIN_EMAIL=admin@northbridge.bank
ADMIN_PASSWORD=<a strong password>
```

Generate the secret with:
`node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`

Point `DOMAIN` at the instance's public IP (an `A` record), then:

```bash
docker compose up -d --build
docker compose exec app npm run seed:admin   # one-time: create the administrator
```

Migrations run automatically on boot (`server/src/index.js`). Visit `https://<DOMAIN>/admin` to sign in.

### Notes

- `CLIENT_ORIGIN` must equal `https://<DOMAIN>`; the server refuses to boot in production while it is a loopback address (silent CORS failures otherwise).
- Everything durable lives on the `northbridge-data` Docker volume mounted at `/data`: the SQLite database (`DATABASE_FILE`) and avatar uploads (`UPLOADS_DIR`). `docker compose down` keeps it; `docker compose down -v` deletes it.
- Caddy stores its certificates in the `caddy-data` volume, so renewals survive restarts.
- The Firestore mirror ships disabled (`FIREBASE_ENABLED=0`); enable it only after adding real Firebase credentials.
- `render.yaml` is kept as an alternative for Render, but its config requires a paid instance (free has no disk).

## Security notes

- Passwords and transfer PINs hashed with scrypt (memory-hard, per-secret salt, versioned format with automatic rehash on login).
- Sessions are server-side rows; the browser holds only an opaque `httpOnly` cookie, stored as a SHA-256 digest. Customer and admin cookies are separate and enforced by `actor_type` in SQL.
- Per-session CSRF tokens (double-submit), rate limiting on login and PIN confirmation per IP and per account.
- Audit log rows are append-only (SQL triggers reject UPDATE/DELETE).

## Licence

Private / unlicensed unless stated otherwise.
