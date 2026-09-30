import { describe, expect, it } from 'vitest';

import { TOROB_FEED_API_PATH, torobFeedPath } from './torob';

describe('torobFeedPath', () => {
  it('targets the public feed endpoint with the store slug', () => {
    expect(torobFeedPath('my-store')).toBe(`${TOROB_FEED_API_PATH}?vendorSlug=my-store`);
    expect(TOROB_FEED_API_PATH).toBe('/api/v1/integrations/torob/products');
  });

  it('encodes the slug', () => {
    expect(torobFeedPath('a b&c')).toBe(`${TOROB_FEED_API_PATH}?vendorSlug=a%20b%26c`);
  });
});
