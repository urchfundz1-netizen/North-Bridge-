/**
 * Public landing page.
 *
 * Presented with the same fixed header as the authenticated app so navigation
 * behaves identically before and after signing in.
 */

import { Link } from 'react-router-dom';
import { PublicFooter, PublicHeader } from '../../components/Layout.jsx';
import { LinkButton } from '../../components/ui.jsx';
import {
  IconArrowRight,
  IconChart,
  IconLock,
  IconReceipt,
  IconShield,
  IconSparkle,
  IconTransfer,
} from '../../components/icons.jsx';

const FEATURES = [
  {
    icon: IconTransfer,
    title: 'Transfers with a fee you see first',
    body: 'Every transfer is priced before you commit, so the amount, the processing fee and the total leaving your account are agreed up front — never discovered afterwards.',
  },
  {
    icon: IconShield,
    title: 'A second secret for money movement',
    body: 'Moving money needs a transfer PIN as well as your sign-in. The two credentials are stored as separate hashes, so one leaked password cannot authorise a payment.',
  },
  {
    icon: IconReceipt,
    title: 'Receipts issued on settlement',
    body: 'Once Northbridge approves a transfer, a receipt is generated automatically and kept as a frozen snapshot, exactly as it read on the day.',
  },
  {
    icon: IconChart,
    title: 'Every balance change is traceable',
    body: 'Deposits, transfers, fees and adjustments are written to an append-only ledger. Nothing can be quietly edited or deleted after the fact.',
  },
  {
    icon: IconLock,
    title: 'Account controls you can see',
    body: 'Freeze your own account to stop outgoing payments without losing the ability to sign in and check your balance.',
  },
  {
    icon: IconSparkle,
    title: 'Built for phones first',
    body: 'A fixed navigation bar and full-height bottom navigation keep every destination one tap away, on any screen size.',
  },
];

export default function LandingPage() {
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <PublicHeader />

      <main id="main" className="app-main">
        <section className="hero">
          <div className="container hero__grid">
            <div>
              <span className="badge badge--gold">
                <span className="badge__dot" aria-hidden="true" />
                Personal banking
              </span>

              <h1
                className="text-3xl mt-4"
                style={{ color: 'var(--white)', letterSpacing: '-0.03em', maxWidth: '18ch' }}
              >
                Everyday banking, without the guesswork.
              </h1>

              <p
                className="text-lg mt-4"
                style={{ color: 'rgba(255,255,255,0.78)', maxWidth: '52ch' }}
              >
                Northbridge gives you one clear view of your money. Send a transfer, watch it clear,
                and download a receipt — with every step explained before you confirm it.
              </p>

              <div className="hero__actions">
                <LinkButton to="/register" variant="accent" size="lg" icon={IconArrowRight}>
                  Open an account
                </LinkButton>
                <LinkButton to="/login" variant="onDark" size="lg">
                  Sign in
                </LinkButton>
              </div>

              <p className="text-xs mt-6" style={{ color: 'rgba(255,255,255,0.6)' }}>
                Need help? Call +1 (800) 555-0142 or email{' '}
                <a
                  href="mailto:support.northbridgebank@gmail.com"
                  style={{ color: '#ffffff' }}
                >
                  support.northbridgebank@gmail.com
                </a>
                .
              </p>
            </div>

            <div className="hero-card" aria-hidden="true">
              <div className="balance-hero" style={{ background: 'rgba(255,255,255,0.1)' }}>
                <div className="balance-hero__label">Available balance</div>
                <div className="balance-hero__amount">$24,180.55</div>
                <div className="balance-hero__meta">
                  <div className="balance-hero__meta-item">
                    <span className="balance-hero__meta-label">Account</span>
                    <span className="balance-hero__meta-value mono">0000 0000 0000 4821</span>
                  </div>
                  <div className="balance-hero__meta-item">
                    <span className="balance-hero__meta-label">Status</span>
                    <span className="balance-hero__meta-value">Active</span>
                  </div>
                </div>
              </div>

              <div className="stack gap-3 mt-4">
                <div className="row gap-3">
                  <span className="txn__icon txn__icon--debit">
                    <IconTransfer size={17} />
                  </span>
                  <span className="grow text-sm">
                    <span className="strong">Rent payment</span>
                    <br />
                    <span className="subtle">Awaiting review</span>
                  </span>
                  <span className="strong">−$1,850.00</span>
                </div>
                <div className="row gap-3">
                  <span className="txn__icon txn__icon--credit">
                    <IconReceipt size={17} />
                  </span>
                  <span className="grow text-sm">
                    <span className="strong">Salary</span>
                    <br />
                    <span className="subtle">Settled · receipt issued</span>
                  </span>
                  <span className="strong positive">+$4,200.00</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="section" id="features">
          <div className="container">
            <div className="text-center" style={{ maxWidth: '60ch', margin: '0 auto var(--space-10)' }}>
              <h2 className="text-2xl">How Northbridge works</h2>
              <p className="muted mt-3">
                Six commitments that shape every screen in the portal.
              </p>
            </div>

            <div className="feature-grid">
              {FEATURES.map((feature) => (
                <article className="feature" key={feature.title}>
                  <span className="feature__icon">
                    <feature.icon size={22} />
                  </span>
                  <h3 className="text-md">{feature.title}</h3>
                  <p className="text-sm muted">{feature.body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="section" id="security" style={{ background: 'var(--navy-50)' }}>
          <div className="container">
            <div className="card" style={{ background: 'var(--white)' }}>
              <div className="card__body">
                <div className="row wrap gap-6" style={{ alignItems: 'center' }}>
                  <div className="grow" style={{ minWidth: '260px' }}>
                    <h2 className="text-xl">Security is structural, not decorative</h2>
                    <p className="muted mt-3">
                      Sessions live in <code className="mono">httpOnly</code> cookies that scripts cannot
                      read. Passwords and transfer PINs are stored with scrypt and never leave the
                      server. Every state-changing request carries a CSRF token, and every
                      administrative action is written to an append-only audit log.
                    </p>
                    <div className="row wrap gap-2 mt-4">
                      <span className="badge badge--info">httpOnly sessions</span>
                      <span className="badge badge--info">scrypt hashing</span>
                      <span className="badge badge--info">CSRF protection</span>
                      <span className="badge badge--info">Append-only ledger</span>
                      <span className="badge badge--info">Rate limiting</span>
                      <span className="badge badge--info">Audit trail</span>
                    </div>
                  </div>

                  <div className="stack gap-3" style={{ minWidth: '240px' }}>
                    <LinkButton to="/register" variant="primary" size="lg">
                      Get started
                    </LinkButton>
                    <Link to="/login" className="btn btn--secondary" style={{ height: 44 }}>
                      I already have an account
                    </Link>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>

      <PublicFooter />
    </div>
  );
}