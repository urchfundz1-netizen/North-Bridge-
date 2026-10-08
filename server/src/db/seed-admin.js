/**
 * Bootstrap the administrator account from environment variables.
 *
 * Credentials live in `.env`, never in source. Re-running this command is safe:
 * if an admin with the same email already exists the password is rotated rather
 * than a duplicate being created.
 *
 *   npm run seed:admin
 */

import { getDb, one, run, nowIso, closeDb, transaction } from './connection.js';
import { migrate } from './migrate.js';
import { hashSecret } from '../core/crypto.js';
import { config } from '../core/config.js';
import { isEntryPoint } from '../core/is-entry-point.js';
import { reportFailure } from './report-failure.js';
import { recordAudit, AUDIT_ACTIONS } from '../services/audit.js';
import { mirrorAdminById } from '../services/firestore.js';

export async function seedAdmin({ email, password, fullName } = {}) {
  const adminEmail = (email ?? config.admin.email ?? '').trim().toLowerCase();
  const adminPassword = password ?? config.admin.password;
  const name = fullName ?? config.admin.fullName;

  if (!adminEmail || !adminPassword) {
    throw new Error(
      'Set ADMIN_EMAIL and ADMIN_PASSWORD in .env (see .env.example) before running this command.',
    );
  }
  if (!adminEmail.includes('@')) throw new Error('ADMIN_EMAIL does not look like an email address.');
  if (adminPassword.length < 12) {
    throw new Error('ADMIN_PASSWORD must be at least 12 characters.');
  }

  const passwordHash = await hashSecret(adminPassword);
  getDb();

  const result = transaction(() => {
    const existing = one('SELECT id, email FROM admins WHERE email = ?', [adminEmail]);

    if (existing) {
      run(
        `UPDATE admins SET password_hash = ?, full_name = ?, role = 'superadmin',
                          status = 'active', failed_attempts = 0, locked_until = NULL, updated_at = ?
          WHERE id = ?`,
        [passwordHash, name, nowIso(), existing.id],
      );
      return { created: false, admin: one('SELECT id, email, full_name, role FROM admins WHERE id = ?', [existing.id]) };
    }

    const inserted = run(
      `INSERT INTO admins (email, full_name, password_hash, role)
       VALUES (?, ?, ?, 'superadmin')`,
      [adminEmail, name, passwordHash],
    );

    const admin = one('SELECT id, email, full_name, role FROM admins WHERE id = ?', [
      Number(inserted.lastInsertRowid),
    ]);
    return { created: true, admin };
  });

  mirrorAdminById(result.admin.id);
  return result;
}

if (isEntryPoint(import.meta.url)) {
  try {
    migrate({ silent: true });
    const result = await seedAdmin();

    recordAudit({
      actorType: 'system',
      actorEmail: result.admin.email,
      action: result.created ? AUDIT_ACTIONS.ADMIN_CREATED : AUDIT_ACTIONS.ADMIN_PASSWORD_ROTATED,
      targetType: 'admin',
      targetId: result.admin.id,
      targetLabel: result.admin.email,
      metadata: { role: result.admin.role },
    });

    console.log(result.created ? 'Administrator created:' : 'Administrator password rotated:');
    console.log(`  email: ${result.admin.email}`);
    console.log(`  name:  ${result.admin.full_name}`);
    console.log(`  role:  ${result.admin.role}`);
    console.log('\nSign in at /admin/login');
    closeDb();
  } catch (error) {
    reportFailure('seed:admin', error);
    process.exitCode = 1;
  }
}
