import { describe, expect, it } from 'vitest';

import { MAX_LISTING_PAGE, parseListingParams, toProductQuery } from './search-params';

describe('listing URL params', () => {
  it('maps storefront names to the API query', () => {
    const params = parseListingParams({ q: ' گوشی ', category: 'Mobile', vendor: 'demo-diginoo', minPrice: '1000', maxPrice: '5000', inStock: '1', onSale: '1', sort: 'price_asc', page: '3', colors: 'مشکی,#1D4ED8' });
    expect(toProductQuery(params)).toEqual({
      search: 'گوشی',
      categorySlug: 'mobile',
      vendorSlug: 'demo-diginoo',
      minPrice: 1000,
      maxPrice: 5000,
      inStockOnly: true,
      onSaleOnly: true,
      colors: ['مشکی', '#1D4ED8'],
      sizes: [],
      sortBy: 'price_asc',
      page: 3,
      pageSize: 24,
    });
  });

  it('ignores invalid values instead of failing the page', () => {
    const params = parseListingParams(new URLSearchParams('sort=hack&page=-2&minPrice=abc&inStock=true'));
    expect(params.sort).toBe('newest');
    expect(params.page).toBe(1);
    expect(params.minPrice).toBeUndefined();
    expect(params.inStockOnly).toBe(false);
  });

  it('caps the page depth and fixes the category on category pages', () => {
    const params = parseListingParams({ page: '999999', category: 'other' }, 'laptop');
    expect(params.page).toBe(MAX_LISTING_PAGE);
    expect(params.categorySlug).toBe('laptop');
  });

  it('swaps an inverted price range', () => {
    const query = toProductQuery(parseListingParams({ minPrice: '900', maxPrice: '100' }));
    expect([query.minPrice, query.maxPrice]).toEqual([100, 900]);
  });
});
