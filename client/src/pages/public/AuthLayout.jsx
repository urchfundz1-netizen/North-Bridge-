/**
 * Shared layout for the sign-in / registration screens: a centred form panel
 * beside a brand panel that collapses away on small screens.
 *
 * The brand panel is deliberately image-only. It carries no selling copy, so
 * the form is never competing with a paragraph of marketing text for
 * attention, and the wordmark is a real element rather than an image so it
 * stays selectable and legible at any zoom.
 */

export function AuthLayout({ title, subtitle, children, footer }) {
  return (
    <div className="app-shell">
      <main className="auth-layout">
        <section className="auth-panel">
          <div className="auth-card">
            <h1 className="text-2xl">{title}</h1>
            {subtitle ? <p className="muted mt-2">{subtitle}</p> : null}
            <div className="mt-6">{children}</div>
            {footer ? <div className="mt-6">{footer}</div> : null}
          </div>
        </section>

        <aside className="auth-aside">
          <div className="auth-aside__brand">
            <img className="auth-aside__mark" src="/favicon.svg" alt="" width="44" height="44" />
            <span className="auth-aside__wordmark">NorthBridge Bank</span>
          </div>

          <div className="auth-aside__figure">
            <img
              className="auth-aside__image"
              src="/bank-head-office.svg"
              alt="The NorthBridge Bank head office"
              width="900"
              height="900"
              /* Reserved before the file loads, so the panel does not reflow
                 when the image arrives. */
              decoding="async"
            />
          </div>
        </aside>
      </main>
    </div>
  );
}