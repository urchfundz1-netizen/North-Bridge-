/**
 * Shared layout for the sign-in / registration screens: a centred form panel
 * beside a brand panel that collapses away on small screens.
 *
 * The brand panel is deliberately image-only. It carries no selling copy, so
 * the form is never competing with a paragraph of marketing text for
 * attention, and the wordmark is a real element rather than an image so it
 * stays selectable and legible at any zoom.
 *
 * `variant="dark"` opts a screen into the dark, glassy treatment on mobile
 * only. Desktop keeps the light split layout with the brand aside, so the
 * variant never changes how the page reads on a large screen.
 */

import { IconUser } from '../../components/icons.jsx';

export function AuthLayout({ title, subtitle, children, footer, variant, avatar: AvatarIcon }) {
  const dark = variant === 'dark';
  const Avatar = AvatarIcon ?? IconUser;

  return (
    <div className="app-shell">
      <main className={`auth-layout ${dark ? 'auth-layout--dark' : ''}`}>
        <section className="auth-panel">
          {/* Compact wordmark for small screens, where the brand aside is
              hidden. Mirrors the desktop aside so the page still feels
              branded without a paragraph of marketing copy. */}
          <div className="auth-brand" aria-hidden="true">
            <span className="brand__mark">NB</span>
            <span className="auth-brand__name">
              Northbridge
              <span className="auth-brand__tag">Personal Banking</span>
            </span>
          </div>

          <div className="auth-card">
            {dark ? (
              <span className="auth-card__avatar" aria-hidden="true">
                <Avatar size={40} />
              </span>
            ) : null}
            <header className="auth-card__head">
              <h1 className="auth-card__title">{title}</h1>
              {subtitle ? <p className="muted mt-2">{subtitle}</p> : null}
            </header>
            <div className="auth-card__body mt-6">{children}</div>
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