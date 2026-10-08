/**
 * Shared hooks: session bootstrap, data fetching with abort, and toasts.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/client.js';

/**
 * Runs an async loader on mount and whenever `deps` change.
 *
 * An in-flight request is aborted when dependencies change or the component
 * unmounts, which prevents a slow first response from overwriting fresher data
 * after the user has already navigated to a different filter.
 */
export function useAsync(loader, deps = [], { enabled = true } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: enabled });
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const [reloadToken, setReloadToken] = useState(0);
  const reload = useCallback(() => setReloadToken((n) => n + 1), []);

  useEffect(() => {
    if (!enabled) {
      setState({ data: null, error: null, loading: false });
      return undefined;
    }

    const controller = new AbortController();
    let cancelled = false;

    setState((prev) => ({ data: prev.data, error: null, loading: true }));

    loaderRef
      .current({ signal: controller.signal })
      .then((data) => {
        if (!cancelled) setState({ data, error: null, loading: false });
      })
      .catch((error) => {
        if (cancelled || error?.name === 'AbortError') return;
        setState({ data: null, error, loading: false });
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled, reloadToken]);

  return { ...state, reload, setData: (data) => setState((s) => ({ ...s, data })) };
}

/** Delay a rapidly changing value (used for search-as-you-type). */
export function useDebounced(value, delay = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/** Track an online/offline connection for a global banner. */
export function useOnline() {
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );
  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);
  return online;
}

/** Lock body scroll while a modal or drawer is open. */
export function useScrollLock(active) {
  useEffect(() => {
    if (!active) return undefined;
    const original = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = original;
    };
  }, [active]);
}

/** Run `handler` on Escape, respecting capture for nested dialogs. */
export function useEscapeKey(handler, active = true) {
  useEffect(() => {
    if (!active) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') handler(event);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [handler, active]);
}

/**
 * Sequential numeric helper for pagination:
 * builds [1, '...', 4, 5, 6, '...', 12].
 */
export function pageWindow(current, total, span = 1) {
  if (total <= 1) return [1];
  const pages = new Set([1, total, current]);
  for (let offset = 1; offset <= span; offset += 1) {
    if (current - offset >= 1) pages.add(current - offset);
    if (current + offset <= total) pages.add(current + offset);
  }
  const sorted = [...pages].sort((a, b) => a - b);
  const output = [];
  let previous = 0;
  for (const page of sorted) {
    if (previous && page - previous > 1) output.push('gap');
    output.push(page);
    previous = page;
  }
  return output;
}

/**
 * Wrap a mutating action with pending state and a normalised error message.
 * Returns `[run, pending, error, reset]`.
 */
export function useAction(action) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const run = useCallback(
    async (...args) => {
      setPending(true);
      setError(null);
      try {
        return await action(...args);
      } catch (err) {
        if (mountedRef.current) {
          setError(err instanceof ApiError ? err : new ApiError({
            status: 0,
            code: 'unexpected_error',
            message: err?.message ?? 'Something went wrong. Please try again.',
          }));
        }
        return undefined;
      } finally {
        if (mountedRef.current) setPending(false);
      }
    },
    [action],
  );

  return [run, pending, error, () => setError(null)];
}
