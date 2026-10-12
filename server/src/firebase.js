/**
 * Firebase Functions entry point.
 *
 * Wraps the existing Express app in a single HTTPS function so every /api/*
 * route keeps working unchanged. Firebase Hosting rewrites /api/** here (see
 * firebase.json); everything else is served as static SPA files.
 *
 * Unlike `index.js` (the long-running server), this does not call app.listen -
 * the functions runtime owns the socket.
 */

import { onRequest } from 'firebase-functions/v2/https';
import { setGlobalOptions } from 'firebase-functions/v2';
import { createApp } from './app.js';
import { initFirestore } from './db/firestore.js';
import { bootstrap } from './db/migrate.js';
import { loadSettings } from './services/settings.js';

// Keep the blast radius small until the migration is proven.
setGlobalOptions({ region: 'us-central1', maxInstances: 10, memory: '512MiB' });

let appPromise = null;

async function getApp() {
  if (appPromise) return appPromise;
  appPromise = (async () => {
    initFirestore();
    await bootstrap(); // idempotent: seed settings + starter banks
    await loadSettings(); // warm the settings cache for synchronous bankingRules()
    // The SPA is served by Firebase Hosting, not by this function.
    return createApp({ serveClient: false });
  })();
  return appPromise;
}

export const api = onRequest(async (req, res) => {
  const app = await getApp();
  return app(req, res);
});
