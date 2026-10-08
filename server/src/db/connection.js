/**
 * SQLite connection.
 *
 * Uses Node's built-in `node:sqlite` module (Node >= 22.5), so the project has
 * no native build step. The driver is synchronous, which is fine here: every
 * statement is a single fast local read/write, and it removes a whole class of
 * interleaving bugs around money.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../core/config.js';

const here = dirname(fileURLToPath(import.meta.url));
export const SCHEMA_PATH = resolve(here, 'schema.sql');

let db = null;

export function getDb() {
  if (db) return db;

  if (config.databaseFile !== ':memory:') {
    mkdirSync(dirname(config.databaseFile), { recursive: true });
  }

  db = new DatabaseSync(config.databaseFile);

  // WAL gives us concurrent readers alongside a writer. `busy_timeout` stops a
  // request from throwing SQLITE_BUSY if two writers collide.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA synchronous = NORMAL');

  return db;
}

export function applySchema(database = getDb()) {
  database.exec(readFileSync(SCHEMA_PATH, 'utf8'));
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Run `fn` inside a single IMMEDIATE transaction.
 *
 * BEGIN IMMEDIATE takes the write lock up front, so two concurrent approval
 * requests cannot both read `status = 'pending'` and both try to settle. This
 * is the backbone of the "no double approval, no double debit" guarantee.
 */
export function transaction(fn) {
  const database = getDb();
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = fn(database);
    database.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // The transaction was already unwound by SQLite itself.
    }
    throw error;
  }
}

/** Convenience: run `fn` and return only its first column. */
export function one(sql, params = []) {
  return getDb().prepare(sql).get(...params) ?? null;
}

/** Convenience: run `fn` and return all rows. */
export function many(sql, params = []) {
  return getDb().prepare(sql).all(...params);
}

/** Convenience: run a write and return `{ changes, lastInsertRowid }`. */
export function run(sql, params = []) {
  return getDb().prepare(sql).run(...params);
}

export const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');