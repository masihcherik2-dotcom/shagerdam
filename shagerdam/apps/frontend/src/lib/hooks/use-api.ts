'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { apiGet, toQueryString, type Query } from '../api/client';
import { ApiError, toApiError } from '../api/errors';

export interface ApiState<T> {
  data: T | undefined;
  error: ApiError | undefined;
  /** True while the first response (or a response for new parameters) is pending. */
  loading: boolean;
  /** True while a background reload is running with data already on screen. */
  refreshing: boolean;
  reload: () => Promise<void>;
  /** Replace the cached data after a mutation that returned the new state. */
  setData: (data: T) => void;
}

/**
 * Live GET against the BFF with loading/error state. `path === null` pauses
 * the request (e.g. until a dependency is known). Responses for outdated
 * parameters are discarded, so fast typing never shows stale results.
 */
export function useApi<T>(path: string | null, query?: Query): ApiState<T> {
  const key = path === null ? null : `${path}${toQueryString(query)}`;
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<ApiError | undefined>(undefined);
  const [loading, setLoading] = useState<boolean>(path !== null);
  const [refreshing, setRefreshing] = useState(false);
  const latestKey = useRef<string | null>(key);
  const queryRef = useRef(query);
  queryRef.current = query;

  const run = useCallback(
    async (background: boolean): Promise<void> => {
      if (path === null || key === null) {
        return;
      }
      latestKey.current = key;
      if (background) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }
      try {
        const result = await apiGet<T>(path, { query: queryRef.current });
        if (latestKey.current === key) {
          setData(result);
          setError(undefined);
        }
      } catch (caught) {
        if (latestKey.current === key) {
          setError(toApiError(caught));
        }
      } finally {
        if (latestKey.current === key) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [key, path],
  );

  useEffect(() => {
    if (key === null) {
      setLoading(false);
      return;
    }
    void run(false);
  }, [key, run]);

  const reload = useCallback(() => run(true), [run]);

  return { data, error, loading, refreshing, reload, setData };
}

/** Debounced copy of a value (instant search). */
export function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export interface MutationState<TArgs extends unknown[], TResult> {
  run: (...args: TArgs) => Promise<TResult | undefined>;
  pending: boolean;
  error: ApiError | undefined;
  reset: () => void;
}

/**
 * Wraps a state-changing API call: tracks pending/error and never throws to
 * the caller (the error is exposed for display; the result is undefined).
 */
export function useMutation<TArgs extends unknown[], TResult>(action: (...args: TArgs) => Promise<TResult>): MutationState<TArgs, TResult> {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | undefined>(undefined);
  const actionRef = useRef(action);
  actionRef.current = action;

  const run = useCallback(async (...args: TArgs): Promise<TResult | undefined> => {
    setPending(true);
    setError(undefined);
    try {
      return await actionRef.current(...args);
    } catch (caught) {
      setError(toApiError(caught));
      return undefined;
    } finally {
      setPending(false);
    }
  }, []);

  const reset = useCallback(() => setError(undefined), []);
  return { run, pending, error, reset };
}
