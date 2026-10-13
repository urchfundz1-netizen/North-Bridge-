# Northbridge Bank

Full-stack online banking platform: a customer portal (transfers, receipts, security settings) and an administrator panel (customer onboarding, transfer approvals, audit log, system settings), backed by a double-entry ledger.

## Tech stack

| Layer    | Choice                                                          |
| -------- | --------------------------------------------------------------- |
| Server   | Node >= 22.5, Express 4, Zod validation, ESM                     |
| Database | Firestore via `firebase-admin`; Cloud Storage for avatars        |
| Client   | React 18, Vite 6, react-router 6 (SPA)                          |

## Features

**Customer portal** — registration, session login, dashboard, money transfers (quote → PIN confirmation → receipt), transaction history, transfer browser with search, profile and avatar upload, password / transfer-PIN changes, active-session review and revocation.

**Admin panel** — customer onboarding (with server-generated transfer PIN), funding and balance adjustments, transfer approval queue (toggleable), bank catalogue management, immutable audit log, system settings (transfer limits, fees, approval requirement), freeze / block account status controls.

**Ledger integrity** — every movement is a ledger entry; balances are reconstructed from entries, negative balances are blocked at the point of write, and settled rows are never updated or deleted.

## Quick start

```bash
git clone https://github.com/urchfundz1-netizen/North-Bridge-.git
cd North-Bridge-
npm install

copy .env.example .env      # Windows: Copy-Item .env.example .env
# edit .env - at minimum keep SESSION_SECRET unique

npm run migrate             # applies reference data + settings (idempotent)
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
| `npm test`              | Server test suite against the Firestore emulator (72 tests)      |
| `npm run test:unit`     | Same tests, against emulators you have already started           |
| `npm run lint`          | ESLint across server, client and scripts                         |
| `npm run smoke`         | End-to-end HTTP smoke test against a **running** server          |
| `npm run check:svg`     | Validate the bank illustration SVG                               |

`npm run smoke` expects the API at `http://localhost:4000` with seeded admin credentials; override with `SMOKE_BASE`, `SMOKE_ADMIN_EMAIL`, `SMOKE_ADMIN_PASSWORD`.

## Project layout

```
server/
  src/core/        config, crypto (scrypt), errors, money, sessions
  src/db/          Firestore access layer, migrations, seeds
  src/middleware/  auth, CSRF-aware validation, throttling, error handler
  src/routes/      auth, account, transfers + admin/* (customers, transfers, banks, system)
  src/services/    ledger, transfers, receipts, audit, settings
  test/            node:test suite against the Firestore emulator
client/
  src/pages/       public / customer / admin routes
  src/components/  UI primitives, layout, icons
  src/api/         fetch wrapper with cookie + CSRF handling
scripts/           smoke test, SVG checker
firestore.rules    Firestore security rules (deny all client access)
deploy/            systemd unit for running the app as a service on a VPS
.env.production.example  production env template (copy to .env on the server)
```

## Environment

All configuration lives in `.env` (never committed) — see `.env.example` for the annotated full list. Highlights:

- `CLIENT_ORIGIN` — must match the real client origin; the server refuses to boot in production while it is still a loopback address (silent CORS failures otherwise).
- `REQUIRE_TRANSFER_APPROVAL` — `1` keeps transfers Pending until an admin approves them; `0` settles immediately.
- `TRANSFER_FEE_CENTS`, `MIN_TRANSFER_CENTS`, `MAX_TRANSFER_CENTS` — fee and guard rails.
- `FIREBASE_PROJECT_ID` — the Firestore project (set `demo-northbridge` for the emulator).

## Deploying

Two surfaces, deployed independently:

- **Client (React SPA)** — hosted on **Vercel** via `vercel.json` (root `client`, Vite build, all routes rewritten to `index.html`).
- **API + data** — a single Firebase Function (`server/src/firebase.js`) under `/api/*`, backed by Firestore and Cloud Storage. `firestore.rules` and `storage.rules` deny all client access; only the server (Firebase Admin SDK) reads and writes.

### 1. Run it locally

Dev mode (hot reload): `npm run dev` — API on `:4000`, client on `:5173`. The test suite (`npm test`) runs against the Firestore + Storage emulators and never touches a real project.

Production rehearsal on one origin: set `NODE_ENV=production`, `CLIENT_ORIGIN=http://localhost:4000`, `ALLOW_LOOPBACK_ORIGIN=1`, a real `SESSION_SECRET`, then `npm run build && npm start`.

### 2. Deploy the API to Firebase

```bash
firebase login
firebase use north-bridgebank
firebase deploy --only firestore:rules,firestore:indexes,storage:rules,functions
```

Function environment comes from a `.env` file in `server/` on the deploy machine (Firebase uploads it; never commit it — git ignores it). Minimum values:

```ini
SESSION_SECRET=<48 random bytes as hex>
CLIENT_ORIGIN=https://<your-vercel-app>.vercel.app
ADMIN_EMAIL=admin@northbridge.bank
ADMIN_PASSWORD=<a strong password>
```

`CLIENT_ORIGIN` must be the exact Vercel origin — CORS and cookie behaviour depend on it. The Function runs an idempotent `bootstrap()` (reference data + settings) on boot.

### 3. Deploy the client to Vercel

Import the repo in the Vercel dashboard (or `npm i -g vercel`, then `vercel` from the repo root). `vercel.json` already sets the root directory to `client`, the build command to `npm run build`, and SPA rewrites.

### 4. One-time seeding

- Create the bootstrap administrator with `npm run seed:admin` (authenticated to the real project via the credentials in `.env`).
- Migrated legacy data: `npm run migrate:data` copies the old SQLite rows into Firestore (read the script header; a real-project run requires `--yes`).

### Data and backups

Firestore and Cloud Storage are the only datastores — there is no local database file or `uploads/` directory to back up. Enable the project's backups in the Firebase console (Firestore native backups / scheduled exports, and Storage object versioning if you want rollback). The test suite runs entirely against local emulators and never touches the real project.

## Security notes

- Passwords and transfer PINs hashed with scrypt (memory-hard, per-secret salt, versioned format with automatic rehash on login).
- Sessions are server-side documents; the browser holds only an opaque `httpOnly` cookie, stored as a SHA-256 digest. Customer and admin cookies are separate and enforced by `actor_type` in the session document.
- Per-session CSRF tokens (double-submit), rate limiting on login and PIN confirmation per IP and per account.
- Audit log documents are written through a single append path, never updated or deleted; Firestore rules deny all client access.

## Licence

Private / unlicensed unless stated otherwise.
