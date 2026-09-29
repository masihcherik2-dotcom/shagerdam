import { useCallback } from 'react';

/**
 * Ref callback for server-rendered <img> elements that must fall back when the
 * image cannot load. A failed load can happen *before* hydration, when React
 * has not attached `onError` yet — so on mount, an image that is already
 * `complete` with no pixels is reported as broken too.
 */
export function useBrokenImageRef(onBroken: () => void): (element: HTMLImageElement | null) => void {
  return useCallback(
    (element: HTMLImageElement | null) => {
      if (element && element.complete && element.naturalWidth === 0) onBroken();
    },
    [onBroken],
  );
}
