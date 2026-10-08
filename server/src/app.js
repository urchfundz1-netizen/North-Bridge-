/**
 * Express application factory.
 *
 * Kept separate from `index.js` so tests can mount the whole API against an
 * in-memory database without binding a port.
 */

import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';

import { config, SERVER_ROOT } from './core/config.js';
import { notFoundHandler, errorHandler } from './middleware/error-handler.js';
import { bankingRules } from './services/settings.js';

import authRoutes from './routes/auth.routes.js';
import accountRoutes from './routes/account.routes.js';
import transferRoutes from './routes/transfer.routes.js';

import adminAuthRoutes from './routes/admin/auth.routes.js';
import adminCustomersRoutes from './routes/admin/customers.routes.js';
import adminTransfersRoutes from './routes/admin/transfers.routes.js';
import adminBanksRoutes from './routes/admin/banks.routes.js';
import adminSystemRoutes from './routes/admin/system.routes.js';

export function createApp({ serveClient = true } = {}) {
  const app = express();

  // Required for correct client IPs (and therefore audit logs) behind a proxy.
  // `1` trusts exactly one hop, which is the only safe default: a higher value
  // would let a client forge X-Forwarded-For and evade IP rate limiting.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  /* ---------------------------------------------------------------- */
  /* Security headers                                                 */
  /* ---------------------------------------------------------------- */

  // The Google Translate gadget (client/src/components/TranslateWidget.jsx) is
  // the platform's only third-party origin. Its loader lives on
  // translate.google.com, but the engine it bootstraps is served from
  // translate.googleapis.com with styles (and branding art) on gstatic, and
  // it calls home through the translate APIs. Keep the allowlist to exactly
  // those Google-owned hosts.
  //
  // The engine's bootstrap runs as an inline script inside an about:srcdoc
  // frame, and a srcdoc frame inherits this CSP - so it needs a hash rather
  // than 'unsafe-inline'. The hash is of Google's static Closure runtime
  // snippet (1721 bytes, identical across pages and loads); if Google ever
  // recompiles it the CSP console will report the new hash to swap in.
  const googleTranslate = {
    // translate-pa.googleapis.com carries the supported-language list as a
    // JSONP *script* (hence script-src, not just connect-src).
    script:
      'https://translate.google.com https://translate.googleapis.com https://translate-pa.googleapis.com',
    // Production only: a hash in script-src makes the browser ignore
    // 'unsafe-inline', which must keep working in the dev branch.
    scriptSrcdocHash: "'sha256-R6kjt5FwTd5vAw94Q08NLDZsSaGTzg4NsdIfKtECSp0='",
    style: 'https://www.gstatic.com',
    // Toolbar/loading art, Google's cleardot.gif pixel, and the gen204
    // timing beacon — emitted with the page's scheme, so both spellings of
    // translate.google.com keep the console clean on http origins too (on an
    // https origin browsers block/upgrade the http form as mixed content).
    img:
      'https://www.gstatic.com https://fonts.gstatic.com https://www.google.com https://translate.googleapis.com ' +
      'https://translate.google.com http://translate.google.com',
    connect:
      'https://translate.google.com https://translate.googleapis.com https://translate-pa.googleapis.com',
    frame: 'https://translate.google.com',
  };

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        // Vite's dev client needs inline/eval; the production build does not.
        config.isProduction
          ? `script-src 'self' ${googleTranslate.script} ${googleTranslate.scriptSrcdocHash}`
          : `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${googleTranslate.script}`,
        `style-src 'self' 'unsafe-inline' ${googleTranslate.style}`,
        `img-src 'self' data: blob: ${googleTranslate.img}`,
        "font-src 'self' data:",
        `connect-src 'self' ${googleTranslate.connect}`,
        `frame-src 'self' ${googleTranslate.frame}`,
        "form-action 'self'",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "object-src 'none'",
      ].join('; '),
    );
    if (config.isProduction) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  });

  /* ---------------------------------------------------------------- */
  /* Parsing                                                          */
  /* ---------------------------------------------------------------- */

  app.use(
    cors({
      origin: config.clientOrigin,
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'X-CSRF-Token'],
    }),
  );

  // A small body limit is enough for JSON forms; file uploads go through multer
  // as multipart and are bounded separately.
  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));
  app.use(cookieParser());

  /* ---------------------------------------------------------------- */
  /* Public metadata                                                  */
  /* ---------------------------------------------------------------- */

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', service: 'northbridge-bank', time: new Date().toISOString() });
  });

  /** Public site metadata used by the landing page. */
  app.get(
    '/api/public/info',
    (_req, res) => {
      const rules = bankingRules();
      res.json({
        bankName: rules.bankName,
        supportEmail: rules.supportEmail,
        supportPhone: rules.supportPhone,
        transferTypes: [
          { id: 'local', label: 'Local transfer', description: 'Send money to a bank in your country.' },
          { id: 'international', label: 'International transfer', description: 'Send money abroad in local currency.' },
          { id: 'wire', label: 'Wire transfer', description: 'Urgent same-day settlement for larger payments.' },
        ],
      });
    },
  );

  /* ---------------------------------------------------------------- */
  /* Static assets                                                    */
  /* ---------------------------------------------------------------- */

  // Uploaded avatars. Served read-only; filenames are server-generated and
  // carry no extension-derived execution path beyond the allowlisted set.
  fs.mkdirSync(path.join(config.uploadsDir, 'avatars'), { recursive: true });
  app.use(
    '/uploads',
    express.static(path.join(config.uploadsDir), {
      index: false,
      dotfiles: 'deny',
      maxAge: '7d',
      setHeaders: (res) => {
        // Avatars are user content: never let a browser sniff or execute them.
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Disposition', 'inline');
      },
    }),
  );

  // In production the API also serves the built React app, so the whole
  // platform runs from a single origin (and therefore a single cookie scope).
  const clientDist = path.resolve(SERVER_ROOT, '..', 'client', 'dist');
  if (serveClient && config.isProduction && fs.existsSync(clientDist)) {
    // Three different cache policies, because these files break in three
    // different ways if they share one.
    //
    // 1. Vite fingerprints everything under assets/ (index-CJx3vKTl.css,
    //    react-CIVwX2PG.js, ...). The bytes behind a given name can never
    //    change, because a change produces a new name. A year plus immutable
    //    is what lets a returning visitor skip the ~215 kB download entirely.
    app.use(
      '/assets',
      express.static(path.join(clientDist, 'assets'), {
        index: false,
        dotfiles: 'deny',
        maxAge: '1y',
        immutable: true,
      }),
    );

    // 2. Files copied verbatim out of client/public/ (the favicon, the
    //    head-office illustration) keep their names across builds. They must
    //    revalidate, or a corrected illustration would never reach a browser
    //    that already has the old one.
    app.use(
      express.static(clientDist, {
        index: false,
        dotfiles: 'deny',
        maxAge: 0,
        setHeaders: (res) => {
          res.setHeader('Cache-Control', 'no-cache');
        },
      }),
    );

    // 3. The SPA shell is what *names* the current fingerprinted bundles. A
    //    stale copy points at files the deploy already deleted, which fails
    //    as a blank page with no console error to act on. So the shell always
    //    revalidates; the 304 that comes back is a few hundred bytes.
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.sendFile(path.join(clientDist, 'index.html'), {
        headers: { 'Cache-Control': 'no-cache' },
      });
    });
  }

  /* ---------------------------------------------------------------- */
  /* API routes                                                       */
  /* ---------------------------------------------------------------- */

  app.use('/api/auth', authRoutes);
  app.use('/api/account', accountRoutes);
  app.use('/api/transfers', transferRoutes);

  // The admin panel is namespaced under /api/admin so a single mount point
  // makes the privilege boundary obvious in the router tree.
  app.use('/api/admin/auth', adminAuthRoutes);
  app.use('/api/admin/customers', adminCustomersRoutes);
  app.use('/api/admin/transfers', adminTransfersRoutes);
  app.use('/api/admin/banks', adminBanksRoutes);
  app.use('/api/admin', adminSystemRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
