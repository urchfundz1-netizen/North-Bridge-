/**
 * Bootstrap the administrator account from environment variables.
 *
 * Credentials live in `.env`, never in source. Re-running this command is safe:
 * if an admin with the same email already exists the password is rotated rather
 * than a duplicate being created.
 *
 *   npm run seed:admin
 */

import { coll, C, coerceId, getById, setById, nowIso, initFirestore } from './firestore.js';
import { migrate } from './migrate.js';
import { hashSecret } from '../core/crypto.js';
import { config } from '../core/config.js';
import { isEntryPoint } from '../core/is-entry-point.js';
import { reportFailure } from './report-failure.js';
import { recordAudit, AUDIT_ACTIONS } from '../services/audit.js';
import { transaction } from './firestore.js';

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
  initFirestore();

  const result = await transaction(async (txn) => {
    const existingSnap = await txn.get(coll(C.admins).where('email', '==', adminEmail).limit(1));
    if (!existingSnap.empty) {
      const existing = existingSnap.docs[0];
      const existingId = coerceId(existing.id);
      await setById(
        C.admins,
        existingId,
        {
          password_hash: passwordHash,
          full_name: name,
          role: 'superadmin',
          status: 'active',
          failed_attempts: 0,
          locked_until: null,
          updated_at: nowIso(),
        },
        { merge: true },
      );
      const admin = await getById(C.admins, existingId);
      return { created: false, admin };
    }

    const idSnap = await txn.get(coll(C.counters).doc(C.admins));
    const nextId = Number(idSnap.exists ? idSnap.data().value : 0) + 1;
    txn.set(coll(C.counters).doc(C.admins), { value: nextId }, { merge: true });
    const now = nowIso();
    txn.set(coll(C.admins).doc(String(nextId)), {
      id: nextId,
      email: adminEmail,
      full_name: name,
      password_hash: passwordHash,
      role: 'superadmin',
      status: 'active',
      failed_attempts: 0,
      locked_until: null,
      last_login_at: null,
      created_at: now,
      updated_at: now,
    });
    const admin = await getById(C.admins, nextId);
    return { created: true, admin };
  });

  return result;
}

if (isEntryPoint(import.meta.url)) {
  try {
    await migrate({ silent: true });
    const result = await seedAdmin();

    await recordAudit({
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
  } catch (error) {
    reportFailure('seed:admin', error);
    process.exitCode = 1;
  }
}
