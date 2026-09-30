'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { apiDelete, apiGet, apiPatch, apiPost } from '@/lib/api/client';
import { toApiError, type ApiError } from '@/lib/api/errors';
import type { Cart } from '@/lib/api/types';

import { useSession } from './session-provider';

interface CartContextValue {
  cart: Cart | undefined;
  loading: boolean;
  error: ApiError | undefined;
  /** Live number of items for the header badge. */
  count: number;
  reload: () => Promise<void>;
  addItem: (productVariantId: string, quantity: number) => Promise<Cart>;
  updateQuantity: (lineId: string, quantity: number) => Promise<Cart>;
  removeLine: (lineId: string) => Promise<Cart>;
  clear: () => Promise<Cart>;
}

const CartContext = createContext<CartContextValue | null>(null);

/**
 * Single source of the cart for the header badge, the cart page and checkout.
 * Guests get a backend guest cart (its token lives in an httpOnly cookie set
 * by the BFF); on sign-in the BFF merges it into the account cart.
 */
export function CartProvider({ children }: { children: ReactNode }) {
  const { user } = useSession();
  const [cart, setCart] = useState<Cart | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | undefined>(undefined);

  const reload = useCallback(async () => {
    try {
      setCart(await apiGet<Cart>('/cart'));
      setError(undefined);
    } catch (caught) {
      setError(toApiError(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  // Reload whenever the identity changes (sign-in merges the guest cart, sign-out shows the guest cart).
  useEffect(() => {
    void reload();
  }, [reload, user?.id]);

  const apply = useCallback((next: Cart): Cart => {
    setCart(next);
    setError(undefined);
    return next;
  }, []);

  const value = useMemo<CartContextValue>(
    () => ({
      cart,
      loading,
      error,
      count: cart?.itemCount ?? 0,
      reload,
      addItem: async (productVariantId, quantity) => apply(await apiPost<Cart>('/cart/items', { productVariantId, quantity })),
      updateQuantity: async (lineId, quantity) => apply(await apiPatch<Cart>(`/cart/items/${lineId}`, { quantity })),
      removeLine: async (lineId) => apply(await apiDelete<Cart>(`/cart/items/${lineId}`)),
      clear: async () => apply(await apiPost<Cart>('/cart/clear')),
    }),
    [apply, cart, error, loading, reload],
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartContextValue {
  const value = useContext(CartContext);
  if (!value) {
    throw new Error('useCart must be used inside <CartProvider>');
  }
  return value;
}
