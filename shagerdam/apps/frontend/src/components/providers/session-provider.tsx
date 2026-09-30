'use client';

import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

import { sessionClient } from '@/lib/api/client';
import type { AuthUser, Me } from '@/lib/api/types';

interface SessionContextValue {
  me: Me | null;
  user: AuthUser | null;
  /** Re-reads the identity from the BFF (after login, profile change, vendor approval). */
  refresh: () => Promise<Me | null>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ initial, children }: { initial: Me | null; children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(initial);
  const router = useRouter();

  const refresh = useCallback(async (): Promise<Me | null> => {
    try {
      const { data } = await sessionClient.get<Me | { user: null }>('');
      const next = data.user === null ? null : (data as Me);
      setMe(next);
      return next;
    } catch {
      return null;
    }
  }, []);

  const signOut = useCallback(async () => {
    try {
      await sessionClient.delete('');
    } finally {
      setMe(null);
      router.push('/');
      router.refresh();
    }
  }, [router]);

  const value = useMemo(() => ({ me, user: me?.user ?? null, refresh, signOut }), [me, refresh, signOut]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) {
    throw new Error('useSession must be used inside <SessionProvider>');
  }
  return value;
}
