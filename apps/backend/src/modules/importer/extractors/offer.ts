import type { HTMLElement } from 'node-html-parser';

/**
 * Commercial data of a source product page (price, strike-through price,
 * currency and availability), as published by the page.
 *
 * Amounts are kept in the source's own unit: Iranian storefronts publish in
 * rial *or* toman, and the unit a page declares in its structured data is not
 * always the unit it really uses. The visible price with its currency symbol
 * (what the customer sees) is therefore preferred over machine-readable codes,
 * and the bulk importer lets the user override the unit per job.
 */
export interface ExtractedOffer {
  /** Selling price in the source unit (> 0). */
  amount: number;
  /** Original price when the page shows a discount (> amount), same unit. */
  oldAmount: number | null;
  /**
   * Normalised currency: `IRR` (rial), `IRT` (toman), `IRHT` (thousand toman),
   * another ISO code as published (e.g. `USD`), or null when the page gives none.
   */
  currency: string | null;
  /** true/false when the page states availability, null when it does not. */
  inStock: boolean | null;
}

/** Currencies the platform can convert into its own unit (IRR). */
export const IRANIAN_UNITS = ['IRR', 'IRT', 'IRHT'] as const;
export type IranianUnit = (typeof IRANIAN_UNITS)[number];

const UNIT_FACTOR: Record<IranianUnit, number> = { IRR: 1, IRT: 10, IRHT: 10_000 };

export function isIranianUnit(value: string | null | undefined): value is IranianUnit {
  return value === 'IRR' || value === 'IRT' || value === 'IRHT';
}

/** Converts an amount in an Iranian unit to whole rials (the platform's money unit). */
export function toRial(amount: number, unit: IranianUnit): number {
  return Math.round(amount * UNIT_FACTOR[unit]);
}

const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

function latinDigits(value: string): string {
  return value.replace(/[۰-۹٠-٩]/g, (digit) => {
    const persian = PERSIAN_DIGITS.indexOf(digit);
    return String(persian >= 0 ? persian : ARABIC_DIGITS.indexOf(digit));
  });
}

/**
 * Reads a price as published: numbers, or strings with Persian/Arabic digits
 * and thousands separators (`18,500,000`, `۱۸٬۵۰۰٬۰۰۰`, `18.500.000`), with an
 * optional decimal part (`98.00`). Returns null for anything that is not a
 * positive amount.
 */
export function parseAmount(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw > 0 ? raw : null;
  }
  if (typeof raw !== 'string') {
    return null;
  }
  let text = latinDigits(raw).replace(/[\s\u00a0\u200c\u202f]/g, '');
  const match = /\d[\d.,٬،']*/.exec(text);
  if (!match) return null;
  text = match[0].replace(/[.,٬،']+$/, '');

  const dots = (text.match(/\./g) ?? []).length;
  const commas = (text.match(/,/g) ?? []).length;
  let normalized: string;
  if (dots > 1 || (dots === 1 && commas === 0 && /\.\d{3}$/.test(text) && !/^0\./.test(text))) {
    // 18.500.000 or 1.500 — dots are thousands separators
    normalized = text.replace(/[.,٬،']/g, '');
  } else if (commas > 0 && dots === 1 && text.lastIndexOf('.') > text.lastIndexOf(',')) {
    // 1,250,000.00 — commas group, dot is decimal
    normalized = text.replace(/[,٬،']/g, '');
  } else if (commas === 1 && dots === 0 && /,\d{1,2}$/.test(text)) {
    // 98,50 — European decimal comma
    normalized = text.replace(',', '.');
  } else {
    normalized = text.replace(/[,٬،']/g, '');
  }
  const value = Number(normalized);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** Maps published currency codes and Persian labels to one vocabulary (see {@link ExtractedOffer.currency}). */
export function normalizeCurrency(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.replace(/[\s\u00a0\u200c]+/g, ' ').trim();
  if (text.length === 0) return null;
  if (/هزار\s*تومان/.test(text)) return 'IRHT';
  if (/تومان|تومن/.test(text)) return 'IRT';
  if (/ریال/.test(text)) return 'IRR';
  const code = text.toUpperCase();
  if (code === 'IRHT') return 'IRHT';
  if (code === 'IRT' || code === 'TOMAN' || code === 'TOM' || code === 'TMN') return 'IRT';
  if (code === 'IRR' || code === 'RIAL' || code === 'RIALS') return 'IRR';
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

/** schema.org availability (`https://schema.org/InStock`, `instock`, `out of stock`, …) → boolean. */
export function parseAvailability(raw: unknown): boolean | null {
  if (typeof raw !== 'string') return null;
  const key = raw.replace(/^.*[/#:]/, '').replace(/[\s_-]+/g, '').toLowerCase();
  if (key.length === 0) return null;
  if (['outofstock', 'soldout', 'discontinued', 'backorder'].includes(key) || key === 'false' || key === 'ناموجود') return false;
  if (['instock', 'instoreonly', 'onlineonly', 'limitedavailability', 'preorder', 'presale', 'available'].includes(key) || key === 'true' || key === 'موجود') return true;
  return null;
}

// ---------------------------------------------------------------------------
// JSON-LD
// ---------------------------------------------------------------------------

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asList(value: JsonValue | undefined): JsonValue[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function scalar(value: JsonValue | undefined): string | number | undefined {
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (isObject(value)) return scalar(value['@value']) ?? scalar(value['@id']);
  if (Array.isArray(value)) return scalar(value[0]);
  return undefined;
}

interface Candidate {
  amount: number;
  oldAmount: number | null;
  currency: string | null;
  inStock: boolean | null;
}

function fromOfferNode(offer: JsonObject): Candidate | null {
  let amount = parseAmount(scalar(offer['price'])) ?? parseAmount(scalar(offer['lowPrice']));
  let currency = normalizeCurrency(scalar(offer['priceCurrency']));
  let oldAmount: number | null = null;
  for (const spec of asList(offer['priceSpecification'])) {
    if (!isObject(spec)) continue;
    const specAmount = parseAmount(scalar(spec['price']));
    const priceType = String(scalar(spec['priceType']) ?? '').toLowerCase();
    if (specAmount === null) continue;
    if (/listprice|strikethrough|msrp|srp/.test(priceType)) {
      oldAmount = specAmount;
    } else if (amount === null) {
      amount = specAmount;
    }
    currency ??= normalizeCurrency(scalar(spec['priceCurrency']));
  }
  if (amount === null) return null;
  return {
    amount,
    oldAmount: oldAmount !== null && oldAmount > amount ? oldAmount : null,
    currency,
    inStock: parseAvailability(scalar(offer['availability'])),
  };
}

/** Lowest in-stock offer (else lowest offer) of a Product/ProductGroup node, variants included. */
export function offerFromJsonLd(product: JsonObject): ExtractedOffer | null {
  const candidates: Candidate[] = [];
  const collect = (node: JsonObject): void => {
    for (const offer of asList(node['offers'])) {
      if (!isObject(offer)) continue;
      const nested = asList(offer['offers']).filter(isObject);
      if (nested.length > 0) {
        for (const inner of nested) {
          const candidate = fromOfferNode(inner);
          if (candidate) candidates.push(candidate);
        }
      }
      const candidate = fromOfferNode(offer);
      if (candidate) candidates.push(candidate);
    }
  };
  collect(product);
  for (const variant of asList(product['hasVariant'])) {
    if (isObject(variant)) collect(variant);
  }
  if (candidates.length === 0) return null;
  const available = candidates.filter((candidate) => candidate.inStock !== false);
  const pool = available.length > 0 ? available : candidates;
  const best = pool.reduce((min, candidate) => (candidate.amount < min.amount ? candidate : min));
  const inStock = candidates.some((candidate) => candidate.inStock === true)
    ? true
    : candidates.every((candidate) => candidate.inStock === false)
      ? false
      : null;
  return { amount: best.amount, oldAmount: best.oldAmount, currency: best.currency, inStock };
}

// ---------------------------------------------------------------------------
// HTML (microdata, WooCommerce, OpenGraph)
// ---------------------------------------------------------------------------

function attrOrText(element: HTMLElement | null): string | undefined {
  if (!element) return undefined;
  const value = element.getAttribute('content') ?? element.getAttribute('href') ?? element.text;
  const text = value?.trim();
  return text && text.length > 0 ? text : undefined;
}

export function offerFromMicrodata(scope: HTMLElement): ExtractedOffer | null {
  const priceElement = scope.querySelector('[itemprop="price"]') ?? scope.querySelector('[itemprop="lowPrice"]');
  const amount = parseAmount(attrOrText(priceElement));
  if (amount === null) return null;
  return {
    amount,
    oldAmount: null,
    currency: normalizeCurrency(attrOrText(scope.querySelector('[itemprop="priceCurrency"]'))),
    inStock: parseAvailability(attrOrText(scope.querySelector('[itemprop="availability"]'))),
  };
}

/**
 * The price block of a WooCommerce product summary, as the customer sees it:
 * `<ins>` is the sale price, `<del>` the original, and the currency symbol is
 * the store's real unit (often «تومان» while structured data claims IRR).
 * Only the main product summary is read — related-product cards carry prices too.
 */
export function offerFromWooCommerce(root: HTMLElement): ExtractedOffer | null {
  const block =
    root.querySelector('.summary p.price, .entry-summary p.price, .product-summary p.price, .summary .price, .entry-summary .price') ??
    root.querySelector('p.price');
  if (!block) return null;
  const amountOf = (element: HTMLElement | null): number | null => {
    if (!element) return null;
    const clone = element.clone() as HTMLElement;
    for (const symbol of clone.querySelectorAll('.woocommerce-Price-currencySymbol')) symbol.remove();
    return parseAmount(clone.text);
  };
  const sale = block.querySelector('ins .woocommerce-Price-amount');
  const original = block.querySelector('del .woocommerce-Price-amount');
  const plain = block.querySelector('.woocommerce-Price-amount');
  const amount = amountOf(sale) ?? amountOf(plain);
  if (amount === null) return null;
  const oldAmount = sale ? amountOf(original) : null;
  const symbol = block.querySelector('.woocommerce-Price-currencySymbol')?.text;
  const stock = root.querySelector('.summary .stock, .entry-summary .stock, p.stock');
  const stockClass = stock?.getAttribute('class') ?? '';
  return {
    amount,
    oldAmount: oldAmount !== null && oldAmount > amount ? oldAmount : null,
    currency: normalizeCurrency(symbol),
    inStock: /\bout-of-stock\b/.test(stockClass) ? false : /\bin-stock\b/.test(stockClass) ? true : null,
  };
}

export function offerFromOpenGraph(root: HTMLElement): ExtractedOffer | null {
  let amount: number | null = null;
  let currency: string | null = null;
  let inStock: boolean | null = null;
  for (const element of root.querySelectorAll('meta')) {
    const key = (element.getAttribute('property') ?? element.getAttribute('name') ?? '').trim().toLowerCase();
    const content = element.getAttribute('content');
    if (key === 'product:price:amount' || key === 'og:price:amount') amount ??= parseAmount(content);
    if (key === 'product:price:currency' || key === 'og:price:currency') currency ??= normalizeCurrency(content);
    if (key === 'product:availability' || key === 'og:availability') inStock ??= parseAvailability(content);
  }
  return amount === null ? null : { amount, oldAmount: null, currency, inStock };
}

/**
 * Merges the page's offers: the first source that has an amount *and* a
 * currency wins, in the order given (visible WooCommerce price first, then
 * JSON-LD, microdata, OpenGraph); availability comes from the first source
 * that states it.
 */
export function mergeOffers(offers: Array<ExtractedOffer | null>): ExtractedOffer | null {
  const present = offers.filter((offer): offer is ExtractedOffer => offer !== null);
  if (present.length === 0) return null;
  const priced = present.find((offer) => offer.currency !== null) ?? present[0]!;
  const inStock = present.find((offer) => offer.inStock !== null)?.inStock ?? null;
  return { ...priced, inStock };
}
