/**
 * Routing.
 *
 * Two separate applications share one bundle but never share a session. The
 * customer portal and the admin portal each sit under their own
 * `SessionProvider`, because they authenticate against different cookies and
 * different `/session` endpoints. One provider mounted at the root would probe
 * the wrong endpoint for whichever portal the visitor was not using.
 *
 * These are layout routes (a `<Route>` with no `path`): React Router matches the
 * most specific sibling, so `/admin/login` renders the admin branch and never
 * touches the customer provider, while `/login` does the opposite.
 *
 * Every screen is lazily loaded, so a customer never downloads the admin
 * screens and first paint does not wait for twenty route modules.
 */

import { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';

import {
  RequireAnonymous,
  RequireAuth,
  SessionProvider,
} from './context/SessionContext.jsx';
import { FullPageSpinner, NotFoundPage } from './pages/Errors.jsx';
import { retranslate } from './components/TranslateWidget.jsx';

/* ---- Public ---- */
const LandingPage = lazy(() => import('./pages/public/LandingPage.jsx'));
const LoginPage = lazy(() => import('./pages/public/LoginPage.jsx'));
const RegisterPage = lazy(() => import('./pages/public/RegisterPage.jsx'));

/* ---- Customer ---- */
const DashboardPage = lazy(() => import('./pages/customer/DashboardPage.jsx'));
const TransferPage = lazy(() => import('./pages/customer/TransferPage.jsx'));
const ActivityPage = lazy(() => import('./pages/customer/TransactionsPage.jsx'));
const TransfersPage = lazy(() => import('./pages/customer/TransfersPage.jsx'));
const TransferDetailPage = lazy(() => import('./pages/customer/TransferDetailPage.jsx'));
const ProfilePage = lazy(() => import('./pages/customer/ProfilePage.jsx'));
const SecurityPage = lazy(() => import('./pages/customer/SecurityPage.jsx'));

/* ---- Admin ---- */
const AdminLoginPage = lazy(() => import('./pages/admin/AdminLoginPage.jsx'));
const AdminOverviewPage = lazy(() => import('./pages/admin/AdminOverviewPage.jsx'));
const AdminCustomersPage = lazy(() => import('./pages/admin/AdminCustomersPage.jsx'));
const AdminNewCustomerPage = lazy(() => import('./pages/admin/AdminNewCustomerPage.jsx'));
const AdminCustomerDetailPage = lazy(() => import('./pages/admin/AdminCustomerDetailPage.jsx'));
const AdminTransfersPage = lazy(() => import('./pages/admin/AdminTransfersPage.jsx'));
const AdminTransferDetailPage = lazy(() => import('./pages/admin/AdminTransferDetailPage.jsx'));
const AdminBanksPage = lazy(() => import('./pages/admin/AdminBanksPage.jsx'));
const AdminAuditPage = lazy(() => import('./pages/admin/AdminAuditPage.jsx'));
const AdminSettingsPage = lazy(() => import('./pages/admin/AdminSettingsPage.jsx'));

/** Convenience wrappers so the route table reads as intent, not as plumbing. */
const customerOnly = (element) => (
  <RequireAuth actor="customer">{element}</RequireAuth>
);
const customerAnon = (element) => (
  <RequireAnonymous actor="customer">{element}</RequireAnonymous>
);
const adminOnly = (element) => <RequireAuth actor="admin">{element}</RequireAuth>;
const adminAnon = (element) => <RequireAnonymous actor="admin">{element}</RequireAnonymous>;

/**
 * A route change swaps in fresh English DOM while Google's combo still holds
 * the visitor's language. Re-drive the engine after every navigation so the
 * portal (which mounts no picker of its own) keeps its language without a
 * widget remount. Must sit inside <BrowserRouter> for useLocation.
 */
function TranslateRouteSync() {
  const location = useLocation();
  useEffect(() => {
    retranslate();
  }, [location.pathname, location.search]);
  return null;
}

export default function App() {
  return (
    <BrowserRouter>
      <TranslateRouteSync />
      <Suspense fallback={<FullPageSpinner />}>
        <Routes>
          {/* ================= Customer portal ================= */}
          <Route element={<SessionProvider actor="customer" />}>
            <Route path="/" element={<LandingPage />} />
            <Route path="/login" element={customerAnon(<LoginPage />)} />
            <Route path="/register" element={customerAnon(<RegisterPage />)} />

            <Route path="/dashboard" element={customerOnly(<DashboardPage />)} />
            <Route path="/transfer" element={customerOnly(<TransferPage />)} />
            {/* One nav entry covers the statement, the transfers in review and
                the receipts they produced; the `view` parameter picks the list. */}
            <Route path="/transactions" element={customerOnly(<ActivityPage />)} />
            <Route path="/transfers" element={customerOnly(<TransfersPage />)} />
            <Route path="/transfers/:id" element={customerOnly(<TransferDetailPage />)} />
            <Route path="/receipts" element={<Navigate to="/transactions?view=receipts" replace />} />
            <Route path="/profile" element={customerOnly(<ProfilePage />)} />
            <Route path="/security" element={customerOnly(<SecurityPage />)} />
          </Route>

          {/* ================= Admin portal ================= */}
          <Route path="/admin" element={<SessionProvider actor="admin" />}>
            <Route path="login" element={adminAnon(<AdminLoginPage />)} />
            <Route index element={adminOnly(<AdminOverviewPage />)} />
            <Route path="customers" element={adminOnly(<AdminCustomersPage />)} />
            <Route path="customers/new" element={adminOnly(<AdminNewCustomerPage />)} />
            <Route path="customers/:id" element={adminOnly(<AdminCustomerDetailPage />)} />
            <Route path="transfers" element={adminOnly(<AdminTransfersPage />)} />
            <Route path="transfers/:id" element={adminOnly(<AdminTransferDetailPage />)} />
            <Route path="banks" element={adminOnly(<AdminBanksPage />)} />
            <Route path="audit" element={adminOnly(<AdminAuditPage />)} />
            <Route path="settings" element={adminOnly(<AdminSettingsPage />)} />

            {/* Receipts are only ever reached through the transfer that issued
                them, so this shortcut redirects instead of rendering a stub. */}
            <Route path="receipts" element={<Navigate to="/admin/transfers" replace />} />
            <Route path="*" element={<NotFoundPage />} />
          </Route>

          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
