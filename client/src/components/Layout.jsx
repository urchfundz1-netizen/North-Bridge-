/**
 * App shell: fixed header, optional fixed sub-navigation, and a fixed bottom
 * navigation on small screens.
 *
 * Scrolling behaviour
 *   The header is `position: fixed`, so `<main>` carries the matching padding
 *   (see `.app-main` in app.css). The navigation inside the header stays
 *   reachable at any scroll depth because it never scrolls away.
 *
 * Responsive strategy
 *   >= 900px : horizontal links in the header, no bottom navigation.
 *   <  900px : header keeps the brand + account menu only, a horizontally
 *   scrollable secondary nav sits under it, and a bottom bar of up to five
 *   items provides the primary destinations with large touch targets.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useSession } from '../context/SessionContext.jsx';
import { Avatar, Button, Modal, StatusBadge } from './ui.jsx';
import { useEscapeKey, useScrollLock } from '../lib/hooks.js';
import { initials } from '../lib/format.js';
import TranslateWidget from './TranslateWidget.jsx';
import {
  IconBank,
  IconChart,
  IconHistory,
  IconHome,
  IconLock,
  IconLogOut,
  IconMenu,
  IconReceipt,
  IconSettings,
  IconTransfer,
  IconUser,
  IconUsers,
  IconX,
} from './icons.jsx';

/* -------------------------------------------------------------------------- */
/* Navigation definitions                                                     */
/* -------------------------------------------------------------------------- */

const CUSTOMER_PRIMARY = [
  { to: '/dashboard', label: 'Overview', icon: IconHome, end: true },
  { to: '/transfer', label: 'Transfer', icon: IconTransfer },
  // Statement, transfers in review and receipts are three lists behind one
  // destination, so they are one link rather than three competing ones.
  { to: '/transactions', label: 'Activity', icon: IconHistory },
  { to: '/profile', label: 'Profile', icon: IconUser },
];

const CUSTOMER_SECONDARY = [
  { to: '/dashboard', label: 'Overview', icon: IconHome, end: true },
  { to: '/transfer', label: 'Send money', icon: IconTransfer },
  { to: '/transactions', label: 'Activity', icon: IconHistory },
  { to: '/profile', label: 'Profile & security', icon: IconUser },
];

const ADMIN_PRIMARY = [
  { to: '/admin', label: 'Overview', icon: IconChart, end: true },
  { to: '/admin/customers', label: 'Customers', icon: IconUsers },
  { to: '/admin/transfers', label: 'Transfers', icon: IconTransfer },
  { to: '/admin/banks', label: 'Banks', icon: IconBank },
  { to: '/admin/audit', label: 'Audit', icon: IconHistory },
];

const ADMIN_SECONDARY = [
  { to: '/admin', label: 'Overview', icon: IconChart, end: true },
  { to: '/admin/customers', label: 'Customers', icon: IconUsers },
  // "Transfer review" owns every queue view except the settled slice; "Receipts"
  // is that slice, because a receipt only exists once a transfer has approved.
  {
    to: '/admin/transfers',
    label: 'Transfer review',
    icon: IconTransfer,
    activeWhen: (search) => search.get('status') !== 'approved',
  },
  { to: '/admin/transfers?status=approved', label: 'Receipts', icon: IconReceipt, activeWhen: (search) => search.get('status') === 'approved' },
  { to: '/admin/banks', label: 'Banks', icon: IconBank },
  { to: '/admin/audit', label: 'Audit log', icon: IconHistory },
  { to: '/admin/settings', label: 'Settings', icon: IconSettings },
];

/* -------------------------------------------------------------------------- */
/* Shell                                                                      */
/* -------------------------------------------------------------------------- */

export function AppShell({ variant = 'customer', children }) {
  const isAdmin = variant === 'admin';
  const primary = isAdmin ? ADMIN_PRIMARY : CUSTOMER_PRIMARY;
  const secondary = isAdmin ? ADMIN_SECONDARY : CUSTOMER_SECONDARY;

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <Header variant={variant} links={primary} />
      <SubNav links={secondary} />
      <main id="main" className="app-main app-main--with-subnav app-main--with-bottomnav" tabIndex={-1}>
        {children}
      </main>
      <BottomNav links={primary} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Header                                                                     */
/* -------------------------------------------------------------------------- */

function Header({ variant = 'customer', links = [] }) {
  const isAdmin = variant === 'admin';
  const session = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  // A route change should always dismiss the mobile account sheet.
  useEffect(() => setMenuOpen(false), [location.pathname]);

  const identity = isAdmin ? session.admin : session.customer;
  const displayName = isAdmin
    ? identity?.fullName || identity?.email || 'Administrator'
    : identity?.fullName || identity?.email || 'Account holder';

  const monogram = isAdmin ? 'AD' : initials(identity?.fullName);

  const handleSignOut = async () => {
    await session.logout();
    navigate(isAdmin ? '/admin/login' : '/login', { replace: true });
  };

  return (
    <header className={`site-header ${isAdmin ? 'site-header--admin' : ''}`}>
      <div className="container site-header__inner">
        <NavLink to={isAdmin ? '/admin' : '/dashboard'} className="brand">
          <span className="brand__mark" aria-hidden="true">
            NB
          </span>
          <span className="brand__text">
            <span className="brand__name">Northbridge</span>
            <span className="brand__tag">{isAdmin ? 'Admin Console' : 'Personal Banking'}</span>
          </span>
        </NavLink>

        <span className="header-badge">{isAdmin ? 'Staff only' : 'Secure banking'}</span>

        <nav className="site-nav" aria-label="Primary">
          {links.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              end={link.end}
              className={({ isActive }) => `site-nav__link ${isActive ? 'is-active' : ''}`}
            >
              {link.label}
            </NavLink>
          ))}
        </nav>

        <div className="site-header__actions">
          <button
            type="button"
            className="btn btn--sm btn--onDark"
            onClick={() => setMenuOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={menuOpen}
          >
            <IconMenu size={16} />
            <span className="visually-hidden">Open account menu</span>
          </button>
        </div>
      </div>

      <AccountSheet
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        variant={variant}
        identity={identity}
        displayName={displayName}
        monogram={monogram}
        onSignOut={handleSignOut}
      />
    </header>
  );
}

/**
 * Slide-over account panel. On wide screens the header shows the avatar
 * inline; this sheet carries the same information plus sign-out and a summary
 * of the signed-in identity for narrow screens.
 */
function AccountSheet({ open, onClose, variant, identity, displayName, monogram, onSignOut }) {
  const isAdmin = variant === 'admin';
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);

  useScrollLock(open);
  useEscapeKey(onClose, open);

  const links = isAdmin
    ? [
        { to: '/admin/settings', label: 'Console settings', icon: IconSettings },
        { to: '/admin/audit', label: 'Audit log', icon: IconHistory },
      ]
    : [
        { to: '/profile', label: 'Profile', icon: IconUser },
        { to: '/security', label: 'Password & transfer PIN', icon: IconLock },
      ];

  if (!open) return null;

  return (
    // Dismissal by clicking outside is a mouse-only convenience; the sheet is
    // already dismissible with Escape and with its Close button.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      className="modal-backdrop"
      style={{ alignItems: 'flex-start', zIndex: 130 }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Account menu"
    >
      <div
        className="modal"
        style={{ maxWidth: 380, marginLeft: 'auto', marginRight: 0, height: '100%', maxHeight: '100%', borderRadius: 0 }}
      >
        <header className="modal__header">
          <h2 className="text-lg">Account</h2>
          <button type="button" className="modal__close" onClick={onClose} aria-label="Close account menu">
            <IconX size={20} />
          </button>
        </header>

        <div className="modal__body">
          <div className="row gap-4 mb-6">
            <Avatar src={identity?.profilePicture} alt={monogram} size="lg" />
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="strong truncate">{displayName}</div>
              <div className="text-sm muted truncate">{identity?.email}</div>
              {identity?.status && identity.status !== 'active' ? (
                <div className="mt-2">
                  <StatusBadge status={identity.status} />
                </div>
              ) : null}
              {isAdmin && identity?.role ? (
                <div className="mt-2">
                  <StatusBadge status={identity.role} label={identity.role.replace('_', ' ')} />
                </div>
              ) : null}
            </div>
          </div>

          {!isAdmin && identity?.accountNumber ? (
            <div className="card" style={{ background: 'var(--surface-muted)', marginBottom: 'var(--space-4)' }}>
              <div className="card__body" style={{ padding: 'var(--space-4)' }}>
                <div className="datalist__label">Account number</div>
                <div className="mono strong mt-1">{identity.accountNumber}</div>
              </div>
            </div>
          ) : null}

          <nav className="stack gap-1" aria-label="Account links">
            {links.map((link) => (
              <NavLink
                key={link.to}
                to={link.to}
                className="row gap-3"
                style={{ padding: 'var(--space-3)', borderRadius: 'var(--radius)', color: 'var(--ink-800)' }}
                onClick={onClose}
              >
                <link.icon size={18} />
                {link.label}
              </NavLink>
            ))}
          </nav>
        </div>

        <footer className="modal__footer">
          <Button variant="secondary" icon={IconLogOut} onClick={() => setConfirmingSignOut(true)}>
            Sign out
          </Button>
        </footer>
      </div>

      <ConfirmDialogWrapper
        open={confirmingSignOut}
        onClose={() => setConfirmingSignOut(false)}
        onConfirm={async () => {
          setConfirmingSignOut(false);
          onClose();
          await onSignOut();
        }}
      />
    </div>
  );
}

function ConfirmDialogWrapper({ open, onClose, onConfirm }) {
  if (!open) return null;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Sign out of Northbridge?"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Stay signed in
          </Button>
          <Button variant="danger" onClick={onConfirm}>
            Sign out
          </Button>
        </>
      }
    >
      <p>You will need to sign in again to reach your accounts.</p>
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/* Sub-navigation                                                             */
/* -------------------------------------------------------------------------- */

function SubNav({ links }) {
  const location = useLocation();
  const scrollerRef = useRef(null);
  const searchParams = useMemo(() => new URLSearchParams(location.search), [location.search]);

  // Keep the active item in view on mobile when the route changes, otherwise a
  // deep-linked page can open with its tab scrolled out of sight.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const active = scroller.querySelector('.is-active');
    if (active) {
      const target = active.offsetLeft - scroller.clientWidth / 2 + active.clientWidth / 2;
      scroller.scrollTo({ left: Math.max(0, target), behavior: 'smooth' });
    }
  }, [location.pathname]);

  /**
   * `NavLink` decides "active" from the path alone, so two entries pointing at
   * the same screen with different filters would both light up. A link may
   * therefore carry an `activeWhen` predicate for when it owns the route.
   */
  function isCurrent(link) {
    const [path, query] = link.to.split('?');
    const pathMatches = link.end
      ? location.pathname === path
      : location.pathname === path || location.pathname.startsWith(`${path}/`);
    if (!pathMatches) return false;

    if (link.activeWhen) return link.activeWhen(searchParams);
    if (query) return new URLSearchParams(query).toString() === searchParams.toString();
    return true;
  }

  return (
    <div className="subnav">
      <div className="container subnav__scroll" ref={scrollerRef}>
        {links.map((link) => (
          <NavLink
            key={link.to}
            to={link.to}
            end={link.end}
            className={() => `subnav__link ${isCurrent(link) ? 'is-active' : ''}`}
          >
            <link.icon size={16} />
            {link.label}
          </NavLink>
        ))}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Bottom navigation                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Five destinations max, so the bar never crowds a 320px-wide phone. Admins get
 * the review queue in the slot customers spend on Profile, because it is the
 * action they open the console to perform.
 */
function BottomNav({ links }) {
  const items = links.slice(0, 5);

  return (
    <nav className="bottom-nav" aria-label="Primary">
      {items.map((link) => (
        <NavLink
          key={link.to}
          to={link.to}
          end={link.end}
          className={({ isActive }) => `bottom-nav__item ${isActive ? 'is-active' : ''}`}
        >
          <link.icon size={20} className="bottom-nav__icon" />
          <span>{shortLabel(link.label)}</span>
        </NavLink>
      ))}
    </nav>
  );
}

/** Trim verbose tab labels to fit a 5-up bar on a 320px-wide phone. */
function shortLabel(label) {
  const map = {
    'Send money': 'Send',
    'Profile & security': 'Profile',
    'Transfer review': 'Review',
    'Audit log': 'Audit',
    'Profile picture': 'Picture',
  };
  return map[label] ?? label.split(' ')[0];
}

/* -------------------------------------------------------------------------- */
/* Public header (marketing pages, login, register)                           */
/* -------------------------------------------------------------------------- */

export function PublicHeader({ minimal = false }) {
  return (
    <header className="site-header">
      <div className="container site-header__inner">
        <NavLink to="/" className="brand">
          <span className="brand__mark" aria-hidden="true">
            NB
          </span>
          <span className="brand__text">
            <span className="brand__name">Northbridge</span>
            <span className="brand__tag">Personal Banking</span>
          </span>
        </NavLink>

        {minimal ? (
          <div className="site-header__actions">
            <TranslateWidget />
            <NavLink to="/login" className="btn btn--sm btn--onDark">
              Sign in
            </NavLink>
          </div>
        ) : (
          <>
            <nav className="site-nav" aria-label="Primary">
              <a className="site-nav__link" href="#features">
                Features
              </a>
              <a className="site-nav__link" href="#security">
                Security
              </a>
              <a className="site-nav__link" href="#support">
                Support
              </a>
            </nav>
            <div className="site-header__actions">
              <TranslateWidget />
              <NavLink to="/login" className="btn btn--sm btn--onDark">
                Sign in
              </NavLink>
              <NavLink to="/register" className="btn btn--sm btn--accent">
                Open an account
              </NavLink>
            </div>
          </>
        )}
      </div>
    </header>
  );
}

export function PublicFooter() {
  return (
    <footer className="site-footer" id="support">
      <div className="container">
        <div className="row wrap gap-6" style={{ justifyContent: 'space-between' }}>
          <div>
            <div className="row gap-3">
              <span className="brand__mark" aria-hidden="true">
                NB
              </span>
              <span className="brand__name" style={{ color: 'var(--white)' }}>
                Northbridge Bank
              </span>
            </div>
            <p className="text-sm mt-2" style={{ color: 'rgba(255,255,255,0.7)', maxWidth: '38ch' }}>
              Personal accounts, transfers and receipts, all in one place.
            </p>
          </div>

          <div className="row wrap gap-6">
            <div>
              <div className="datalist__label" style={{ color: 'rgba(255,255,255,0.55)' }}>
                Customer
              </div>
              <ul className="mt-2 stack gap-2 text-sm">
                <li>
                  <NavLink to="/register" style={{ color: 'rgba(255,255,255,0.82)' }}>
                    Open an account
                  </NavLink>
                </li>
                <li>
                  <NavLink to="/login" style={{ color: 'rgba(255,255,255,0.82)' }}>
                    Sign in
                  </NavLink>
                </li>
              </ul>
            </div>
            <div>
              <div className="datalist__label" style={{ color: 'rgba(255,255,255,0.55)' }}>
                Staff
              </div>
              <ul className="mt-2 stack gap-2 text-sm">
                <li>
                  <NavLink to="/admin/login" style={{ color: 'rgba(255,255,255,0.82)' }}>
                    Admin console
                  </NavLink>
                </li>
              </ul>
            </div>
          </div>
        </div>

        <hr className="divider mt-6" style={{ background: 'rgba(255,255,255,0.14)' }} />
        <p className="text-xs mt-4" style={{ color: 'rgba(255,255,255,0.55)' }}>
          &copy; {new Date().getFullYear()} Northbridge Bank. Member FDIC (simulated).
        </p>
      </div>
    </footer>
  );
}

/** Full-screen loading state used while the session probe runs. */
export function BootScreen({ label = 'Loading Northbridge Bank' }) {
  return (
    <div className="app-shell">
      <div className="loading-block" style={{ minHeight: '100vh' }} role="status" aria-live="polite">
        <span className="spinner" style={{ width: 24, height: 24 }} aria-hidden="true" />
        <span>{label}&hellip;</span>
      </div>
    </div>
  );
}