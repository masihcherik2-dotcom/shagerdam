import { describe, expect, it } from 'vitest';

import { ApiError } from '@/lib/api/errors';
import type { BulkItem, BulkJob } from '@/lib/api/types';

import { bulkErrorMessage, describeBulkItem, formatRetryAfter, normalizeStoreUrl, productUrlLabel, retryableCount } from './bulk-import';

const item = (patch: Partial<BulkItem>): BulkItem => ({
  index: 0,
  url: 'https://shop.example/product/pot-24/',
  status: 'PENDING',
  attempts: 0,
  code: null,
  message: null,
  notes: [],
  title: null,
  imageUrl: null,
  price: null,
  product: null,
  updatedAt: '2026-09-30T10:00:00.000Z',
  ...patch,
});

describe('describeBulkItem', () => {
  it('translates the notes of a created product', () => {
    expect(describeBulkItem(item({ status: 'SUCCEEDED' }))).toBeNull();
    expect(describeBulkItem(item({ status: 'SUCCEEDED', notes: ['NO_IMAGE', 'OUT_OF_STOCK'] }))).toBe(
      'هیچ تصویری از صفحه دریافت نشد؛ تصویر را دستی اضافه کنید. در سایت مبدأ ناموجود است؛ موجودی صفر ثبت شد.',
    );
  });

  it('translates review, importer and HTTP codes, and falls back to the server text', () => {
    expect(describeBulkItem(item({ status: 'NEEDS_REVIEW', code: 'NO_PRICE' }))).toContain('قیمتی در صفحه پیدا نشد');
    expect(describeBulkItem(item({ status: 'NEEDS_REVIEW', code: 'FOREIGN_CURRENCY' }))).toContain('ارز خارجی');
    expect(describeBulkItem(item({ status: 'FAILED', code: 'IMPORT_NOT_FOUND' }))).toBe('این کالا در سایت مبدأ پیدا نشد یا دیگر فعال نیست.');
    expect(describeBulkItem(item({ status: 'FAILED', code: 'HTTP_409', message: 'Slug taken' }))).toBe('ثبت محصول با خطای ۴۰۹ رد شد (Slug taken).');
    expect(describeBulkItem(item({ status: 'FAILED', code: 'SOMETHING_NEW', message: 'raw detail' }))).toBe('raw detail');
    expect(describeBulkItem(item({ status: 'PENDING' }))).toBeNull();
  });
});

describe('helpers', () => {
  it('counts retryable items', () => {
    const job = { items: [item({ status: 'SUCCEEDED' }), item({ status: 'FAILED' }), item({ status: 'NEEDS_REVIEW' }), item({ status: 'SKIPPED' }), item({ status: 'PENDING' })] } as BulkJob;
    expect(retryableCount(job)).toBe(3);
  });

  it('labels product pages by their decoded slug', () => {
    expect(productUrlLabel('https://zarrinmetal.ir/product/%D9%82%D8%A7%D8%A8%D9%84%D9%85%D9%87-%D9%85%D8%B3%DB%8C/')).toBe('قابلمه مسی');
    expect(productUrlLabel('https://shop.example/')).toBe('shop.example');
    expect(productUrlLabel('not a url')).toBe('not a url');
  });

  it('normalizes store addresses', () => {
    expect(normalizeStoreUrl(' zarrinmetal.ir ')).toBe('https://zarrinmetal.ir');
    expect(normalizeStoreUrl('http://shop.example/fa')).toBe('http://shop.example/fa');
    expect(normalizeStoreUrl('')).toBeNull();
    expect(normalizeStoreUrl('localhost')).toBeNull();
    expect(normalizeStoreUrl('ftp://shop.example')).toBeNull();
  });

  it('formats waits and quota errors', () => {
    expect(formatRetryAfter(30)).toBe('۳۰ ثانیهٔ دیگر');
    expect(formatRetryAfter(1800)).toBe('حدود ۳۰ دقیقهٔ دیگر');
    expect(formatRetryAfter(86_000)).toBe('حدود ۲۴ ساعت دیگر');
    const limited = new ApiError('x', { kind: 'http', status: 429, details: { retryAfterSeconds: 1200 } });
    expect(bulkErrorMessage(limited, 'start')).toContain('۴۰۰ محصول در ۲۴ ساعت');
    expect(bulkErrorMessage(limited, 'crawl')).toContain('حدود ۲۰ دقیقهٔ دیگر');
    expect(bulkErrorMessage(new ApiError('پیام', { kind: 'http', status: 400 }), 'crawl')).toBe('پیام');
  });
});
