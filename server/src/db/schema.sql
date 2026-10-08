-- ===========================================================================
-- Northbridge Bank - database schema
--
-- Integrity notes
--   * Every monetary value is stored as an INTEGER number of minor units
--     (cents). No floating point is ever used for money.
--   * `ledger_entries` is the ONLY place a balance is ever changed. Nothing in
--     the application writes `customers.balance_cents` directly.
--   * `customers.balance_cents` has a CHECK (>= 0) constraint so the database
--     itself refuses to let an account go overdrawn, even if application code
--     has a bug.
--   * `ledger_entries(transfer_id, entry_type)` is UNIQUE, which makes it
--     impossible to settle the same transfer twice - the second attempt fails
--     at the database level regardless of application race conditions.
--   * `transfers.status` transitions are guarded in code AND verified with a
--     conditional UPDATE (`WHERE status = 'pending'`), so an approval is only
--     ever applied if the row was still pending.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Key/value application settings (transfer fees, approval policy, ...)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- ---------------------------------------------------------------------------
-- Administrators. Kept completely separate from customers: separate table,
-- separate hash column, separate login route, separate session actor type.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admins (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  email             TEXT NOT NULL UNIQUE COLLATE NOCASE,
  full_name         TEXT NOT NULL,
  password_hash     TEXT NOT NULL,
  role              TEXT NOT NULL DEFAULT 'teller'
                      CHECK (role IN ('superadmin', 'admin', 'teller')),
  status            TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'disabled')),
  failed_attempts   INTEGER NOT NULL DEFAULT 0,
  locked_until      TEXT,
  last_login_at     TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- ---------------------------------------------------------------------------
-- Supported banks. Admin-managed so customers can send money to any bank,
-- not just a hard-coded list in the frontend.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS banks (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  name                     TEXT NOT NULL UNIQUE COLLATE NOCASE,
  code                     TEXT,
  country                  TEXT NOT NULL DEFAULT 'United States',
  routing_number_length    INTEGER CHECK (routing_number_length IS NULL OR routing_number_length BETWEEN 3 AND 12),
  supports_local           INTEGER NOT NULL DEFAULT 1 CHECK (supports_local IN (0, 1)),
  supports_international   INTEGER NOT NULL DEFAULT 1 CHECK (supports_international IN (0, 1)),
  supports_wire            INTEGER NOT NULL DEFAULT 1 CHECK (supports_wire IN (0, 1)),
  is_active                INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_by_admin_id      INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  created_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- ---------------------------------------------------------------------------
-- Customer accounts.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customers (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  account_number              TEXT NOT NULL UNIQUE,
  full_name                   TEXT NOT NULL,
  date_of_birth               TEXT NOT NULL,
  email                       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone                       TEXT NOT NULL,
  address_line1               TEXT NOT NULL,
  address_line2               TEXT,
  city                        TEXT NOT NULL,
  state_region                TEXT NOT NULL,
  postal_code                 TEXT NOT NULL,
  country                     TEXT NOT NULL DEFAULT 'United States',
  account_type                TEXT NOT NULL DEFAULT 'checking'
                                CHECK (account_type IN ('checking', 'savings', 'premium')),

  -- Credentials (scrypt, never reversible). transfer_pin_hash is deliberately
  -- a separate column from password_hash so a compromised password hash can
  -- never be used to authorise a money movement.
  password_hash               TEXT NOT NULL,
  transfer_pin_hash           TEXT NOT NULL,
  transfer_pin_hash_updated_at TEXT,

  transfer_pin_failed_attempts INTEGER NOT NULL DEFAULT 0,
  transfer_pin_locked_until    TEXT,

  -- Sign-in throttling counters. `locked_until` is a temporary self-lock; the
  -- `status` column below is the administrator-controlled state.
  failed_login_attempts        INTEGER NOT NULL DEFAULT 0,
  locked_until                 TEXT,

  -- Account control flags. Only an administrator may change these; there is
  -- deliberately no customer-facing endpoint that writes this column.
  status                      TEXT NOT NULL DEFAULT 'active'
                                CHECK (status IN ('active', 'locked', 'frozen', 'disabled')),
  status_reason               TEXT,
  status_changed_at           TEXT,
  status_changed_by_admin_id  INTEGER REFERENCES admins(id) ON DELETE SET NULL,

  balance_cents               INTEGER NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  profile_picture             TEXT,
  last_login_at               TEXT,
  created_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_customers_status  ON customers (status);
CREATE INDEX IF NOT EXISTS idx_customers_name    ON customers (full_name);
CREATE INDEX IF NOT EXISTS idx_customers_created ON customers (created_at DESC);

-- ---------------------------------------------------------------------------
-- Server-side sessions. The cookie only carries an opaque random token; the
-- database stores its SHA-256 hash, so a leaked database cannot be replayed
-- as a login. `csrf_token` backs the double-submit CSRF protection.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash    TEXT NOT NULL UNIQUE,
  actor_type    TEXT NOT NULL CHECK (actor_type IN ('customer', 'admin')),
  actor_id      INTEGER NOT NULL,
  csrf_token    TEXT NOT NULL,
  ip_address    TEXT,
  user_agent    TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  last_seen_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  expires_at    TEXT NOT NULL,
  revoked_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_actor ON sessions (actor_type, actor_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions (expires_at);

-- ---------------------------------------------------------------------------
-- Transfer requests. Recipient bank details are SNAPSHOTTED onto the row so a
-- historical receipt stays truthful even if the bank record is later renamed
-- or deactivated.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transfers (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  reference_number          TEXT NOT NULL UNIQUE,

  customer_id               INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,

  transfer_type             TEXT NOT NULL
                              CHECK (transfer_type IN ('local', 'international', 'wire')),
  recipient_name            TEXT NOT NULL,
  recipient_account_number  TEXT NOT NULL,
  recipient_bank_id         INTEGER REFERENCES banks(id) ON DELETE SET NULL,
  recipient_bank_name       TEXT NOT NULL,
  recipient_routing_number  TEXT,
  recipient_iban            TEXT,
  recipient_swift_bic       TEXT,
  recipient_country         TEXT NOT NULL,

  amount_cents              INTEGER NOT NULL CHECK (amount_cents > 0),
  fee_cents                 INTEGER NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
  total_debit_cents         INTEGER NOT NULL CHECK (total_debit_cents > 0),
  currency                  TEXT NOT NULL DEFAULT 'USD',
  description               TEXT NOT NULL DEFAULT '',

  status                    TEXT NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  requires_approval         INTEGER NOT NULL DEFAULT 1 CHECK (requires_approval IN (0, 1)),

  -- Guards duplicate submission if the client retries a request.
  idempotency_key           TEXT UNIQUE,

  requested_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  reviewed_at               TEXT,
  reviewed_by_admin_id      INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  review_note               TEXT,
  rejection_reason          TEXT,
  settled_at                TEXT,
  cancelled_at              TEXT
);

CREATE INDEX IF NOT EXISTS idx_transfers_customer ON transfers (customer_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_transfers_status   ON transfers (status, requested_at ASC);

-- ---------------------------------------------------------------------------
-- The ledger. Append-only journal of every cent that ever moved.
-- `balance_after_cents` is a running snapshot so each row can be independently
-- verified against the customer's balance.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ledger_entries (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id        INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,

  -- Signed: positive credits the account, negative debits it.
  amount_cents       INTEGER NOT NULL CHECK (amount_cents <> 0),
  balance_after_cents INTEGER NOT NULL CHECK (balance_after_cents >= 0),

  entry_type         TEXT NOT NULL
                       CHECK (entry_type IN ('deposit', 'transfer_principal', 'transfer_fee', 'adjustment')),

  transfer_id        INTEGER REFERENCES transfers(id) ON DELETE CASCADE,
  admin_id           INTEGER REFERENCES admins(id) ON DELETE SET NULL,

  description        TEXT NOT NULL DEFAULT '',
  reference_number   TEXT,

  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),

  -- The double-settlement guard: at most one principal row and one fee row
  -- may ever exist per transfer.
  UNIQUE (transfer_id, entry_type)
);

CREATE INDEX IF NOT EXISTS idx_ledger_customer ON ledger_entries (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_transfer ON ledger_entries (transfer_id);
CREATE INDEX IF NOT EXISTS idx_ledger_admin    ON ledger_entries (admin_id);

-- ---------------------------------------------------------------------------
-- Receipts. A frozen JSON snapshot generated at settlement time, so a receipt
-- is a permanent record rather than a live query against mutable rows.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS receipts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_number   TEXT NOT NULL UNIQUE,
  transfer_id      INTEGER NOT NULL UNIQUE REFERENCES transfers(id) ON DELETE CASCADE,
  customer_id      INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  payload_json     TEXT NOT NULL,
  issued_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_receipts_customer ON receipts (customer_id, issued_at DESC);

-- ---------------------------------------------------------------------------
-- Append-only audit log. Every privileged action is written here.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_type     TEXT NOT NULL CHECK (actor_type IN ('admin', 'customer', 'system')),
  actor_id       INTEGER,
  actor_email    TEXT,
  action         TEXT NOT NULL,
  target_type    TEXT,
  target_id      TEXT,
  target_label   TEXT,
  reason         TEXT,
  metadata_json  TEXT,
  ip_address     TEXT,
  user_agent     TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_created  ON audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor    ON audit_logs (actor_type, actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_target   ON audit_logs (target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_audit_action   ON audit_logs (action);

-- ---------------------------------------------------------------------------
-- Trigger: audit_logs is a compliance record - never allow it to be edited or
-- deleted by an accidental cascade.
-- ---------------------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS trg_audit_logs_no_delete
BEFORE DELETE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'audit_logs is append-only and cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_audit_logs_no_update
BEFORE UPDATE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'audit_logs is append-only and cannot be updated');
END;

-- ---------------------------------------------------------------------------
-- Trigger: refuse to delete settled ledger rows. Only a compensating
-- "adjustment" entry may be written instead.
-- ---------------------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS trg_ledger_no_delete
BEFORE DELETE ON ledger_entries
WHEN (SELECT COUNT(*) FROM transfers WHERE id = OLD.transfer_id AND status = 'approved') > 0
BEGIN
  SELECT RAISE(ABORT, 'settled ledger entries cannot be deleted; record an adjustment instead');
END;