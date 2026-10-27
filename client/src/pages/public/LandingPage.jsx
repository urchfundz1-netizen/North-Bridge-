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
  IconBank,
  IconCard,
  IconChart,
  IconLock,
  IconReceipt,
  IconShield,
  IconSparkle,
  IconTransfer,
} from '../../components/icons.jsx';

const FEATURES = [
  {
    icon: IconChart,
    title: '24/7 Online & Mobile Banking',
    body: 'Check balances, view transactions, and manage your accounts anytime, anywhere from your computer or mobile device.',
  },
  {
    icon: IconTransfer,
    title: 'Transfers & Bill Pay',
    body: 'Move money between accounts or pay bills with a clear review screen before you confirm each payment.',
  },
  {
    icon: IconCard,
    title: 'Debit Card Controls',
    body: 'Lock or unlock your card, report it lost or stolen, and monitor activity right from your Northbridge portal.',
  },
  {
    icon: IconSparkle,
    title: 'Account Alerts',
    body: 'Get notified for purchases, low balances, or unusual activity so you can stay on top of your money.',
  },
  {
    icon: IconReceipt,
    title: 'eStatements & Transaction History',
    body: 'Go paperless with secure, downloadable statements and easy access to your full transaction history.',
  },
  {
    icon: IconShield,
    title: 'Fraud Protection',
    body: 'Proactive monitoring helps detect suspicious activity and keeps your accounts protected around the clock.',
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
        <section className="hero hero--animated">
          <div className="hero__bg" aria-hidden="true">
            <span className="hero__bg-orb hero__bg-orb--1" />
            <span className="hero__bg-orb hero__bg-orb--2" />
            <span className="hero__bg-orb hero__bg-orb--3" />
            <IconBank size={340} className="hero__bg-icon hero__bg-icon--bank" />
            <IconShield size={240} className="hero__bg-icon hero__bg-icon--shield" />
            <IconCard size={200} className="hero__bg-icon hero__bg-icon--card" />
            <IconTransfer size={180} className="hero__bg-icon hero__bg-icon--transfer" />
            <IconReceipt size={160} className="hero__bg-icon hero__bg-icon--receipt" />
            <IconLock size={150} className="hero__bg-icon hero__bg-icon--lock" />
          </div>
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
                At Northbridge Bank, integrity and your trust come first. We are committed to secure, reliable banking and exceptional customer service.
              </p>
              <p
                className="text-lg mt-3"
                style={{ color: 'rgba(255,255,255,0.9)', maxWidth: '52ch', fontWeight: 600 }}
              >
                Bank with confidence. Choose Northbridge Bank today!
              </p>
              <p
                className="text-md mt-2"
                style={{ color: 'rgba(255,255,255,0.85)', maxWidth: '52ch', fontStyle: 'italic' }}
              >
                Northbridge Bank — Your Trust, Our Commitment.
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
              <h2 className="text-2xl">Banking Made Simple</h2>
              <p className="muted mt-3">
                The essentials you'd expect from a trusted bank.
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
                    <h2 className="text-xl">Your Security Comes First</h2>
                    <p className="muted mt-3">
                      At Northbridge Bank, we use bank-grade security measures to help safeguard your accounts and personal information. From encrypted connections to proactive fraud monitoring, your peace of mind is always our priority.
                    </p>
                    <div className="row wrap gap-2 mt-4">
                      <span className="badge badge--info">256-bit Encryption</span>
                      <span className="badge badge--info">Multi-Factor Authentication</span>
                      <span className="badge badge--info">Fraud Monitoring</span>
                      <span className="badge badge--info">Secure Logins</span>
                      <span className="badge badge--info">Card Fraud Alerts</span>
                      <span className="badge badge--info">Zero Liability Protection</span>
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