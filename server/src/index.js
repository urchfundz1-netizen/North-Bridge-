/**
 * Server entry point.
 *
 * Applies migrations on boot (they are idempotent), then starts the HTTP
 * listener. Running the schema here means a fresh clone works with a single
 * `npm run dev` and no separate setup step.
 */

import { createApp } from './app.js';
import { config } from './core/config.js';
import { getDb, closeDb } from './db/connection.js';
import { migrate } from './db/migrate.js';
import { purgeExpiredSessions, pruneRateLimits } from './core/session.js';
import { clearSettingsCache } from './services/settings.js';
import { initFirestore } from './services/firestore.js';

function bootstrap() {
  migrate({ silent: true });
  getDb(); // force the connection open so a bad path fails fast

  const adminCount = getDb().prepare('SELECT COUNT(*) AS n FROM admins').get().n;
  if (adminCount === 0) {
    console.warn('');
    console.warn('  ┌──────────────────────────────────────────────────────────┐');
    console.warn('  │  No administrator account exists yet.                    │');
    console.warn('  │  Run `npm run seed:admin` to create one from your .env.  │');
    console.warn('  └──────────────────────────────────────────────────────────┘');
    console.warn('');
  }

  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`  Northbridge Bank API listening on http://localhost:${config.port}`);
    console.log(`  environment: ${config.env}`);
    console.log(`  client origin: ${config.clientOrigin}`);
    initFirestore();
  });

  /* -------------------------------------------------------------- */
  /* Housekeeping                                                    */
  /* -------------------------------------------------------------- */

  const housekeeping = setInterval(
    () => {
      try {
        purgeExpiredSessions();
        pruneRateLimits();
        clearSettingsCache();
      } catch (error) {
        console.error('[housekeeping]', error.message);
      }
    },
    15 * 60_000,
  );
  housekeeping.unref();

  /* -------------------------------------------------------------- */
  /* Graceful shutdown                                              */
  /* -------------------------------------------------------------- */

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} received, shutting down...`);
    clearInterval(housekeeping);
    server.close(() => {
      closeDb();
      process.exit(0);
    });
    // Force exit if connections hang.
    setTimeout(() => process.exit(1), 8000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    console.error('[unhandled rejection]', reason);
  });

  return server;
}

try {
  bootstrap();
} catch (error) {
  console.error('[startup] failed to start:', error.message);
  process.exit(1);
}
