/**
 * Error screens and the shared loading fallback.
 *
 * These sit outside `AppShell` deliberately: if the shell itself failed to render
 * we must not depend on the session context that would render it.
 */

import { isRouteErrorResponse, useInRouterContext, Link } from 'react-router-dom';
import { PublicHeader } from '../components/Layout.jsx';
import { Button } from '../components/ui.jsx';
import { IconAlert, IconHome } from '../components/icons.jsx';

export function FullPageSpinner({ label = 'Loading' }) {
  return (
    <div className="loading-block" style={{ minHeight: '60vh' }} role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{label}…</span>
    </div>
  );
}

/**
 * 404. Rendered inside a full app shell when the visitor is signed in, so the
 * navigation stays available instead of dumping them back on the marketing site.
 */
export function NotFoundPage() {
  return (
    <SimplePage
      code="404"
      title="We could not find that page"
      description="The link may be out of date, or the page may have moved. Your accounts and transfers are unaffected."
      icon={IconAlert}
    >
      <div className="row gap-3" style={{ justifyContent: 'center' }}>
        <Link to="/dashboard" className="btn btn--primary">
          Go to my dashboard
        </Link>
        <Link to="/" className="btn btn--secondary">
          Home
        </Link>
      </div>
    </SimplePage>
  );
}

/**
 * 500 / unhandled render error.
 *
 * Rendered by `AppErrorBoundary` in main.jsx, which sits *outside*
 * `BrowserRouter`, so this component must never call router hooks
 * (`useRouteError` would throw here - there is no data router context)
 * and must not render router `<Link>`s. The error arrives as a plain prop;
 * `SimplePage` swaps the header for static markup when no router is present.
 */
export function ServerErrorPage({ error }) {
  let detail = 'An unexpected error stopped this page from loading. Nothing was changed.';
  if (isRouteErrorResponse(error)) {
    detail = error.statusText || 'The server could not complete that request.';
  } else if (error instanceof Error && !(error instanceof DOMException)) {
    detail = error.message;
  }

  return (
    <SimplePage
      code="500"
      title="Something went wrong on our side"
      description={detail}
      icon={IconAlert}
    >
      <div className="row gap-3" style={{ justifyContent: 'center' }}>
        <Button variant="primary" icon={IconHome} onClick={() => window.location.assign('/')}>
          Start again
        </Button>
      </div>
    </SimplePage>
  );
}

function SimplePage({ code, title, description, icon: Icon = IconAlert, children }) {
  // Outside a <Router> (the root boundary in main.jsx) a router <Link>
  // throws, so fall back to static header markup.
  const inRouter = useInRouterContext();
  return (
    <div className="app-shell">
      {inRouter ? (
        <PublicHeader minimal />
      ) : (
        <header className="site-header">
          <div className="container site-header__inner">
            <span className="brand">
              <span className="brand__mark" aria-hidden="true">
                NB
              </span>
              <span className="brand__text">
                <span className="brand__name">Northbridge</span>
                <span className="brand__tag">Personal Banking</span>
              </span>
            </span>
          </div>
        </header>
      )}
      <main id="main" className="app-main">
        <div className="container page" style={{ maxWidth: 560, textAlign: 'center' }}>
          <div
            className="row"
            style={{
              justifyContent: 'center',
              marginBottom: 'var(--space-5)',
              color: 'var(--ink-300)',
            }}
          >
            <Icon size={44} />
          </div>
          <div className="text-xs uppercase muted mb-2">{code}</div>
          <h1 className="text-2xl mb-3">{title}</h1>
          <p className="muted mb-6">{description}</p>
          {children}
        </div>
      </main>
    </div>
  );
}
