/**
 * Browser entry point.
 *
 * `ErrorBoundary` and `ErrorPage` are mounted here rather than inside `App`, so a
 * render failure in the router itself still produces a readable screen instead of
 * a blank page. The boundary renders outside <BrowserRouter>, so its fallback
 * takes the error as a prop (router hooks would throw with no router context).
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App.jsx';
import { AppErrorBoundary } from './components/ErrorBoundary.jsx';
import { TranslateEngine, hasActiveLanguage } from './components/TranslateWidget.jsx';
import { ServerErrorPage } from './pages/Errors.jsx';
import './styles/app.css';

const container = document.getElementById('root');

if (!container) {
  throw new Error('index.html is missing its <div id="root"> mount point.');
}

/**
 * Last-resort recovery for DOM-structure crashes caused by Google's
 * translation rewriting text nodes React still holds references to
 * (`insertBefore`/`removeChild` NotFoundError). When one escapes a boundary
 * with a language active, a reload lands on a freshly mounted page that the
 * `googtrans` cookie re-translates - instead of a dead blank screen. The
 * cooldown stops a crash loop on a page that reloads into the same fault.
 */
let lastCrashReload = 0;
window.addEventListener('error', (event) => {
  const err = event.error;
  if (!err || err.name !== 'NotFoundError') return;
  if (!hasActiveLanguage()) return;
  const now = Date.now();
  if (now - lastCrashReload < 5000) return;
  lastCrashReload = now;
  window.location.reload();
});

createRoot(container).render(
  <StrictMode>
    <AppErrorBoundary fallback={(error) => <ServerErrorPage error={error} />}>
      {/* App-lifetime chrome: one Google Translate engine for every route. */}
      <TranslateEngine />
      <App />
    </AppErrorBoundary>
  </StrictMode>,
);
