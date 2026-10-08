/**
 * Session context.
 *
 * The server is the only authority on who is signed in. This provider asks
 * `/session` once per role and keeps the result in memory; nothing sensitive is
 * written to localStorage because the session lives in an `httpOnly` cookie
 * that JavaScript cannot read.
 *
 * The CSRF token *is* readable (the server sends it in the login/session
 * response body) and is held in a module-level variable by the API client so
 * every mutating call picks it up without threading it through props.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Navigate, Outlet } from 'react-router-dom';
import { customerApi, adminApi, setCsrfToken } from '../api/client.js';

const SessionContext = createContext(null);

const EMPTY = {
  authenticated: false,
  customer: null,
  admin: null,
  csrfToken: null,
};

/**
 * `actor` selects which portal's session endpoint is consulted. Rendering the
 * customer app and the admin app in the same tree is not a thing, so a single
 * provider instance per app is enough.
 */
export function SessionProvider({ actor = 'customer', children }) {
  const api = actor === 'admin' ? adminApi : customerApi;

  const [state, setState] = useState(EMPTY);
  const [status, setStatus] = useState('loading'); // loading | ready
  const requestIdRef = useRef(0);

  // `api` is a stable module-level object, so this effect runs once per mount.
  const bootstrap = useCallback(async () => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setStatus('loading');

    try {
      const data = await api.session();
      if (requestIdRef.current !== requestId) return;
      setCsrfToken(data?.csrfToken ?? null);
      setState({
        authenticated: Boolean(data?.authenticated),
        customer: data?.customer ?? null,
        admin: data?.admin ?? null,
        csrfToken: data?.csrfToken ?? null,
      });
    } catch {
      // A failed session probe means "not signed in", never "app is broken".
      if (requestIdRef.current !== requestId) return;
      setCsrfToken(null);
      setState(EMPTY);
    } finally {
      if (requestIdRef.current === requestId) setStatus('ready');
    }
  }, [api]);

  useEffect(() => {
    bootstrap();
  }, [bootstrap]);

  const login = useCallback(
    async (credentials) => {
      const data = await api.login(credentials.email, credentials.password);
      setCsrfToken(data?.csrfToken ?? null);
      setState({
        authenticated: Boolean(data?.authenticated ?? true),
        customer: data?.customer ?? null,
        admin: data?.admin ?? null,
        csrfToken: data?.csrfToken ?? null,
      });
      return data;
    },
    [api],
  );

  /**
   * Registration also signs the customer in, so it has to go through the same
   * adoption path as login. Calling `customerApi.register` directly from a page
   * would leave the provider believing nobody is signed in, and the redirect to
   * the dashboard would bounce straight back to the login screen.
   */
  const register = useCallback(async (payload) => {
    const data = await customerApi.register(payload);
    setCsrfToken(data?.csrfToken ?? null);
    setState({
      authenticated: Boolean(data?.authenticated ?? true),
      customer: data?.customer ?? null,
      admin: null,
      csrfToken: data?.csrfToken ?? null,
    });
    return data;
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      // Clear locally even if the network call fails, so a user on a shared
      // machine is never left showing a signed-in shell.
      setCsrfToken(null);
      setState(EMPTY);
    }
  }, [api]);

  /**
   * Adopt an updated profile after a successful PATCH, without a round trip
   * that would flash stale data.
   */
  const patchIdentity = useCallback((patch) => {
    setState((prev) => {
      if (prev.customer) return { ...prev, customer: { ...prev.customer, ...patch } };
      if (prev.admin) return { ...prev, admin: { ...prev.admin, ...patch } };
      return prev;
    });
  }, []);

  const value = useMemo(
    () => ({ ...state, actor, status, login, register, logout, refresh: bootstrap, patchIdentity }),
    [state, actor, status, login, register, logout, bootstrap, patchIdentity],
  );

  // This provider is mounted as a layout route, so nested routes arrive through
  // <Outlet /> and `children` is undefined. Rendering `children` alone gives a
  // silently blank page: React renders nothing, logs nothing, and throws nothing.
  // The fallback keeps it usable as a plain wrapper in tests and stories.
  return (
    <SessionContext.Provider value={value}>{children ?? <Outlet />}</SessionContext.Provider>
  );
}

export function useSession() {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession must be used inside a <SessionProvider>.');
  return context;
}

/**
 * Gate for a portal. While the session probe is in flight we render a
 * skeleton-free spinner instead of redirecting, otherwise a refresh on a
 * signed-in page would bounce the user to the login screen.
 */
export function RequireAuth({ actor = 'customer', children }) {
  const session = useSession();

  if (session.status === 'loading') return <FullPageSpinner label="Restoring your session" />;

  if (!session.authenticated) {
    // `replace` rather than `push` so the back button cannot walk straight
    // back into the guarded route and bounce forward again.
    return <Navigate to={actor === 'admin' ? '/admin/login' : '/login'} replace />;
  }

  return children;
}

/** Inverse of RequireAuth: keep signed-in users away from the login screen. */
export function RequireAnonymous({ actor = 'customer', children }) {
  const session = useSession();

  if (session.status === 'loading') return <FullPageSpinner />;

  if (session.authenticated) {
    return <Navigate to={actor === 'admin' ? '/admin' : '/dashboard'} replace />;
  }

  return children;
}

function FullPageSpinner({ label = 'Loading' }) {
  return (
    <div className="loading-block" style={{ minHeight: '60vh' }} role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{label}…</span>
    </div>
  );
}
