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
```

## Environment

All configuration lives in `.env` (never committed) — see `.env.example` for the annotated full list. Highlights:

- `CLIENT_ORIGIN` — must match the real client origin; the server refuses to boot in production while it is still a loopback address (silent CORS failures otherwise).
- `REQUIRE_TRANSFER_APPROVAL` — `1` keeps transfers Pending until an admin approves them; `0` settles immediately.
- `TRANSFER_FEE_CENTS`, `MIN_TRANSFER_CENTS`, `MAX_TRANSFER_CENTS` — fee and guard rails.
- `FIREBASE_ENABLED=0` (default) turns the Firestore mirror off entirely; SQLite stays the source of truth.

## Security notes

- Passwords and transfer PINs hashed with scrypt (memory-hard, per-secret salt, versioned format with automatic rehash on login).
- Sessions are server-side rows; the browser holds only an opaque `httpOnly` cookie, stored as a SHA-256 digest. Customer and admin cookies are separate and enforced by `actor_type` in SQL.
- Per-session CSRF tokens (double-submit), rate limiting on login and PIN confirmation per IP and per account.
- Audit log rows are append-only (SQL triggers reject UPDATE/DELETE).

## Licence

Private / unlicensed unless stated otherwise.
