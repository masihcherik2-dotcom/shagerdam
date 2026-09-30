/**
 * Torob (price-comparison) integration: the public feed lives on the site's own
 * origin under the BFF (`/api/v1/integrations/torob/products`).
 */
export const TOROB_FEED_API_PATH = '/api/v1/integrations/torob/products';

/** Relative path of a store's dedicated feed; prefix it with the site origin to share it. */
export function torobFeedPath(storeSlug: string): string {
  return `${TOROB_FEED_API_PATH}?vendorSlug=${encodeURIComponent(storeSlug)}`;
}
