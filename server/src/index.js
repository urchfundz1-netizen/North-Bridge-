/**
 * Server entry point.
 *
 * Initialises Firestore, applies reference data, loads settings, and starts the
 * HTTP listener for local development. Running on Firebase Functions uses
 * `firebase.js` instead (no listen).
 */

import { createApp } from './app.js';
import { config } from './core/config.js';
import { bootstrap } from './db/migrate.js';
import { purgeExpiredSessions, pruneRateLimits } from './core/session.js';
import { clearSettingsCache, loadSettings } from './services/settings.js';
import { initFirestore } from './db/firestore.js';

async function bootstrapIndex() {
  initFirestore();
  await bootstrap({ silent: true });
  await loadSettings();

  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`  Northbridge Bank API listening on http://localhost:${config.port}`);
    console.log(`  environment: ${config.env}`);
    console.log(`  client origin: ${config.clientOrigin}`);
  });

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

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} received, shutting down...`);
    clearInterval(housekeeping);
    server.close(() => {
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 8000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    console.error('[unhandled rejection]', reason);
  });

  return server;
}

bootstrapIndex().catch((error) => {
  console.error('[startup] failed to start:', error.message);
  process.exit(1);
});
