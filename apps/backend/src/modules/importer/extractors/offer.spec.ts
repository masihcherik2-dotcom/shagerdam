import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'node-html-parser';
import { digikalaOffer } from './digikala.extractor';
import { parseProductHtml } from './generic-schema.extractor';
import {
  mergeOffers,
  normalizeCurrency,
  offerFromJsonLd,
  offerFromOpenGraph,
  offerFromWooCommerce,
  parseAmount,
  parseAvailability,
  toRial,
} from './offer';

const FIXTURES = join(__dirname, '../../../../test/fixtures/importer');

describe('parseAmount', () => {
  it.each<[unknown, number | null]>([
    [185000000, 185000000],
    ['185000000', 185000000],
    ['18,500,000', 18500000],
    ['۱۸٬۵۰۰٬۰۰۰ تومان', 18500000],
    ['٢٥٠٠٠٠٠', 2500000],
    ['18.500.000', 18500000],
    ['1.500', 1500],
    ['98.00', 98],
    ['1,250,000.50', 1250000.5],
    ['0.5', 0.5],
    ['قیمت: 2,000 ریال', 2000],
    ['0', null],
    ['تماس بگیرید', null],
    [null, null],
    [-5, null],
  ])('%p → %p', (raw, expected) => {
    expect(parseAmount(raw)).toBe(expected);
  });
});

describe('normalizeCurrency / parseAvailability / toRial', () => {
  it.each([
    ['IRR', 'IRR'],
    ['irt', 'IRT'],
    ['Toman', 'IRT'],
    ['تومان', 'IRT'],
    ['هزار تومان', 'IRHT'],
    ['IRHT', 'IRHT'],
    ['ریال', 'IRR'],
    ['USD', 'USD'],
    ['', null],
    ['$', null],
  ])('%s → %s', (raw, expected) => {
    expect(normalizeCurrency(raw)).toBe(expected);
  });

  it('reads schema.org availability', () => {
    expect(parseAvailability('https://schema.org/InStock')).toBe(true);
    expect(parseAvailability('http://schema.org/OutOfStock')).toBe(false);
    expect(parseAvailability('instock')).toBe(true);
    expect(parseAvailability('out of stock')).toBe(false);
    expect(parseAvailability('https://schema.org/PreOrder')).toBe(true);
    expect(parseAvailability('whatever')).toBeNull();
  });

  it('converts to rials', () => {
    expect(toRial(18500000, 'IRT')).toBe(185000000);
    expect(toRial(1850, 'IRHT')).toBe(18500000);
    expect(toRial(99.4, 'IRR')).toBe(99);
  });
});

describe('offerFromJsonLd', () => {
  it('reads a plain Offer', () => {
    expect(offerFromJsonLd({ '@type': 'Product', offers: { '@type': 'Offer', price: '2500000', priceCurrency: 'IRR', availability: 'https://schema.org/InStock' } })).toEqual({
      amount: 2500000,
      oldAmount: null,
      currency: 'IRR',
      inStock: true,
    });
  });

  it('uses lowPrice of an AggregateOffer and a ListPrice specification as the old price', () => {
    expect(
      offerFromJsonLd({
        '@type': 'Product',
        offers: {
          '@type': 'AggregateOffer',
          lowPrice: 900,
          priceCurrency: 'IRT',
          priceSpecification: [{ '@type': 'UnitPriceSpecification', priceType: 'https://schema.org/ListPrice', price: 1200 }],
        },
      }),
    ).toEqual({ amount: 900, oldAmount: 1200, currency: 'IRT', inStock: null });
  });

  it('takes the cheapest available variant of a ProductGroup', () => {
    const offer = offerFromJsonLd({
      '@type': 'ProductGroup',
      hasVariant: [
        { '@type': 'Product', offers: { price: 500, priceCurrency: 'IRT', availability: 'OutOfStock' } },
        { '@type': 'Product', offers: { price: 700, priceCurrency: 'IRT', availability: 'InStock' } },
        { '@type': 'Product', offers: { price: 650, priceCurrency: 'IRT', availability: 'InStock' } },
      ],
    });
    expect(offer).toEqual({ amount: 650, oldAmount: null, currency: 'IRT', inStock: true });
  });

  it('reports out of stock only when every offer is', () => {
    expect(offerFromJsonLd({ offers: [{ price: 5, availability: 'OutOfStock' }, { price: 6, availability: 'SoldOut' }] })?.inStock).toBe(false);
    expect(offerFromJsonLd({ name: 'x' })).toBeNull();
  });
});

describe('HTML offers', () => {
  it('reads the visible WooCommerce sale price with its currency symbol and stock', () => {
    const root = parse(`<div class="summary entry-summary"><p class="price"><del><span class="woocommerce-Price-amount amount"><bdi>2,100,000&nbsp;<span class="woocommerce-Price-currencySymbol">تومان</span></bdi></span></del>
      <ins><span class="woocommerce-Price-amount amount"><bdi>1,850,000&nbsp;<span class="woocommerce-Price-currencySymbol">تومان</span></bdi></span></ins></p>
      <p class="stock in-stock">۵ عدد در انبار</p></div>
      <ul class="related"><li><p class="price"><span class="woocommerce-Price-amount">99</span></p></li></ul>`);
    expect(offerFromWooCommerce(root)).toEqual({ amount: 1850000, oldAmount: 2100000, currency: 'IRT', inStock: true });
  });

  it('reads OpenGraph product price tags', () => {
    const root = parse('<meta property="product:price:amount" content="1290000"><meta property="product:price:currency" content="IRR"><meta property="product:availability" content="out of stock">');
    expect(offerFromOpenGraph(root)).toEqual({ amount: 1290000, oldAmount: null, currency: 'IRR', inStock: false });
  });

  it('prefers the first offer that names a currency, availability from the first that states it', () => {
    expect(
      mergeOffers([
        null,
        { amount: 10, oldAmount: null, currency: null, inStock: false },
        { amount: 100, oldAmount: null, currency: 'IRR', inStock: null },
      ]),
    ).toEqual({ amount: 100, oldAmount: null, currency: 'IRR', inStock: false });
    expect(mergeOffers([null, null])).toBeNull();
  });
});

describe('page fixtures', () => {
  const page = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

  it('WooCommerce: the visible toman price wins over JSON-LD IRR (same value, real unit)', () => {
    const draft = parseProductHtml(page('woocommerce-product.html'), new URL('https://shop.fixture.test/product/redmi-note-13/'));
    expect(draft.offer).toEqual({ amount: 18500000, oldAmount: null, currency: 'IRT', inStock: true });
    expect(toRial(draft.offer!.amount, 'IRT')).toBe(185000000);
  });

  it('microdata: price and currency from itemprops', () => {
    const draft = parseProductHtml(page('microdata-product.html'), new URL('https://shop.fixture.test/p/1'));
    expect(draft.offer?.amount).toBe(620000000);
    expect(draft.offer?.currency).toBe('IRR');
  });

  it('Shopify: a foreign currency is reported as published', () => {
    const draft = parseProductHtml(page('shopify-product.html'), new URL('https://shop.fixture.test/products/x'));
    expect(draft.offer?.amount).toBe(98);
    expect(draft.offer?.currency).toBe('USD');
  });
});

describe('digikalaOffer', () => {
  it('reads the buy-box price in rials', () => {
    expect(digikalaOffer({ status: 'marketable', default_variant: { price: { selling_price: 459_000_000, rrp_price: 499_000_000 } } })).toEqual({
      amount: 459_000_000,
      oldAmount: 499_000_000,
      currency: 'IRR',
      inStock: true,
    });
  });

  it('has no offer when nothing is for sale', () => {
    expect(digikalaOffer({ status: 'out_of_stock', default_variant: [] })).toBeNull();
    expect(digikalaOffer({})).toBeNull();
  });

  it('keeps a price but reports unavailability', () => {
    expect(digikalaOffer({ status: 'stop_production', default_variant: { price: { selling_price: 10, rrp_price: 10 } } })).toEqual({
      amount: 10,
      oldAmount: null,
      currency: 'IRR',
      inStock: false,
    });
  });
});
