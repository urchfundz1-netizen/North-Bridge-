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

The app is a single Node process that serves the API and the built SPA from one origin, backed by Firestore and Cloud Storage (no separate database server). There is **no Docker and no Tailscale** in this path — a deployment is just Node on a host, a domain pointed at it, and something that terminates HTTPS.

### 1. Run it on your own machine (now)

Two ways:

- **Dev mode** (hot reload) — the Quick start above: `npm run dev`, browse to `http://localhost:5173` (customer + `/admin`). API on `:4000`.
- **Production-like, single origin** — the server serves the built SPA *and* the API on one port, the same way a VPS will run it. In `.env` set:

  ```ini
  NODE_ENV=production
  CLIENT_ORIGIN=http://localhost:4000
  ALLOW_LOOPBACK_ORIGIN=1   # overrides the "loopback in production" guard deliberately
  SESSION_SECRET=<a real secret, not the example>
  ```

  then:

  ```bash
  npm run build
  npm start        # http://localhost:4000 serves the SPA + API together
  ```

  The server listens on every interface, so other devices on your LAN can open `http://<your-lan-ip>:4000`. Drop `ALLOW_LOOPBACK_ORIGIN` before any real deployment.

### 2. Move it to a VPS with your domain (when you're ready)

The same single process, kept alive by systemd.

**1. Point your domain at the server.** In your DNS panel, create an `A` record, e.g. `bank` → `<VPS public IP>`. It must resolve before you add HTTPS.

**2. Install Node 22.5+** (Ubuntu):

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

**3. Clone and build the app** at `/opt/northbridge-bank`:

```bash
sudo useradd --system --home /opt/northbridge-bank --shell /usr/sbin/nologin northbridge
sudo mkdir -p /opt/northbridge-bank
sudo chown northbridge:northbridge /opt/northbridge-bank
sudo -u northbridge git clone https://github.com/urchfundz1-netizen/North-Bridge-.git /opt/northbridge-bank
cd /opt/northbridge-bank
sudo -u northbridge cp .env.production.example .env
sudo -u northbridge nano .env   # set CLIENT_ORIGIN, SESSION_SECRET,
                                # ADMIN_EMAIL, ADMIN_PASSWORD
sudo -u northbridge npm install
sudo -u northbridge npm run build
sudo -u northbridge npm run migrate
sudo -u northbridge npm run seed:admin   # one-time: create the administrator
```

Generate `SESSION_SECRET` with:
`node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`

`CLIENT_ORIGIN` must equal `https://<your-domain>` exactly; `COOKIE_SECURE` is forced on automatically in production.

**4. Keep it running with systemd** (`deploy/northbridge.service` already uses the `northbridge` user and `/opt/northbridge-bank` — adjust if you changed either):

```bash
sudo cp deploy/northbridge.service /etc/systemd/system/northbridge.service
sudo systemctl daemon-reload
sudo systemctl enable --now northbridge
sudo systemctl status northbridge
```

Migrations run automatically on boot; the site is now up over plain HTTP on port 4000.

**5. Add HTTPS later.** Open TCP **80** and **443** in the cloud provider's firewall and the OS firewall, then either follow the nginx + certbot route below or use your provider's load balancer / certificate. For example, nginx:

```nginx
server {
    listen 80;
    server_name bank.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_buffering off;
    }
}
```

then `sudo apt-get install -y nginx certbot python3-certbot-nginx` and `sudo certbot --nginx` for the certificate.

### Data and backups

Firestore and Cloud Storage are the only datastores — there is no local database file or `uploads/` directory to back up. Enable the project's backups in the Firebase console (Firestore native backups / scheduled exports, and Storage object versioning if you want rollback). The test suite runs entirely against local emulators and never touches the real project.

## Security notes

- Passwords and transfer PINs hashed with scrypt (memory-hard, per-secret salt, versioned format with automatic rehash on login).
- Sessions are server-side documents; the browser holds only an opaque `httpOnly` cookie, stored as a SHA-256 digest. Customer and admin cookies are separate and enforced by `actor_type` in the session document.
- Per-session CSRF tokens (double-submit), rate limiting on login and PIN confirmation per IP and per account.
- Audit log documents are written through a single append path, never updated or deleted; Firestore rules deny all client access.

## Licence

Private / unlicensed unless stated otherwise.
