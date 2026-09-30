import { BadRequestException, ForbiddenException, HttpException, Injectable, Logger } from '@nestjs/common';
import { VendorStatus } from '@prisma/client';
import { TooManyRequestsException } from '../../common/exceptions/too-many-requests.exception';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';
import { CategoriesService } from '../categories/categories.service';
import { MediaService } from '../media/media.service';
import { PRODUCT_IMAGE_PURPOSE } from '../products/products.service';
import { normalizePersianText } from '../products/catalog-text';
import type { ExtractSpecResponseDto, FailedImageDto, IngestImagesResponseDto, IngestedImageDto } from './dto/import.dto';
import { DigikalaExtractor } from './extractors/digikala.extractor';
import type { ExtractedProduct } from './extractors/extracted-product';
import { GenericSchemaOrgExtractor } from './extractors/generic-schema.extractor';
import { ImportError, toHttpException } from './import-error';
import { SafeHttpClient } from './net/safe-http-client';

/** Extractions per vendor per window; each one is up to two outbound requests. */
export const EXTRACT_LIMIT = 30;
export const EXTRACT_WINDOW_SECONDS = 10 * 60;
/** Imported images per vendor per window (≈ 10 full galleries an hour). */
export const IMAGE_LIMIT = 120;
export const IMAGE_WINDOW_SECONDS = 60 * 60;
/** Parallel image downloads per request: fast enough, polite to the source. */
const IMAGE_CONCURRENCY = 3;
const IMAGE_ACCEPT = 'image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.5';

export const importerRateKeys = {
  extract: (userId: string): string => `importer:extract:${userId}`,
  images: (userId: string): string => `importer:images:${userId}`,
};

/** Name comparison for category matching: Persian-normalised, no ZWNJ/spaces/punctuation, case-insensitive. */
export function categoryMatchKey(value: string): string {
  return normalizePersianText(value)
    .replace(/[\u200c\u200d\s\-_/،,.()]+/g, '')
    .toLocaleLowerCase('fa');
}

/**
 * Orchestrates product import for vendors: picks the extraction strategy,
 * enforces per-vendor quotas, matches the source category against the local
 * tree and pushes remote images through the regular media pipeline.
 *
 * Nothing here creates a product. The draft goes back to the vendor, who
 * completes price/stock/variants and saves through `POST /vendor/products` —
 * the same validation and audit path as a hand-typed product.
 */
@Injectable()
export class ProductImporterService {
  private readonly logger = new Logger(ProductImporterService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly categories: CategoriesService,
    private readonly media: MediaService,
    private readonly http: SafeHttpClient,
    private readonly digikala: DigikalaExtractor,
    private readonly generic: GenericSchemaOrgExtractor,
  ) {}

  async extract(userId: string, rawUrl: string): Promise<ExtractSpecResponseDto> {
    await this.requireApprovedStore(userId);
    const url = this.validateOrThrow(rawUrl);
    await this.consume(importerRateKeys.extract(userId), 1, EXTRACT_LIMIT, EXTRACT_WINDOW_SECONDS, 'Too many product imports; try again later');

    let product: ExtractedProduct;
    try {
      product = this.digikala.matches(url) ? await this.digikala.extract(url) : await this.generic.extract(url);
    } catch (error) {
      throw this.toHttp(error, url);
    }

    const suggestedCategoryId = await this.matchCategory(product.categoryCandidates);
    this.logger.log(
      `Extracted ${product.source} product from ${url.hostname} for user ${userId}: ` +
        `${product.specifications.length} specs, ${product.imageUrls.length} images [${product.strategies.join(', ')}]`,
    );

    return {
      source: product.source,
      strategies: product.strategies,
      sourceUrl: product.sourceUrl,
      sourceProductId: product.sourceProductId,
      title: product.title,
      titleEn: product.titleEn,
      brand: product.brand,
      description: product.description,
      suggestedCategory: product.suggestedCategory,
      suggestedCategoryId,
      specifications: product.specifications,
      imageUrls: product.imageUrls,
    };
  }

  /**
   * Downloads remote images and stores them exactly like an upload through
   * `POST /media/upload/image` with purpose `product_image`: magic-byte check,
   * Sharp decode, WebP re-encode (≤ 1600 px) plus a 300×300 thumbnail, storage
   * through the active provider and a `media_assets` row owned by the caller.
   *
   * Every URL is validated before anything is fetched — one private/internal
   * target rejects the whole request. After that, a failing image (404, too
   * large, not an image) is reported in `failures` while the rest are stored.
   */
  async ingestImages(userId: string, imageUrls: string[]): Promise<IngestImagesResponseDto> {
    await this.requireApprovedStore(userId);
    const urls = [...new Set(imageUrls)];
    const parsed = urls.map((raw) => this.validateOrThrow(raw));
    await this.consume(importerRateKeys.images(userId), parsed.length, IMAGE_LIMIT, IMAGE_WINDOW_SECONDS, 'Too many imported images; try again later');

    const results = new Array<IngestedImageDto | FailedImageDto>(parsed.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < parsed.length) {
        const index = next;
        next += 1;
        results[index] = await this.ingestOne(userId, urls[index]!, parsed[index]!);
      }
    };
    await Promise.all(Array.from({ length: Math.min(IMAGE_CONCURRENCY, parsed.length) }, () => worker()));

    const items = results.filter((entry): entry is IngestedImageDto => 'id' in entry);
    const failures = results.filter((entry): entry is FailedImageDto => 'code' in entry);
    this.logger.log(`Imported ${items.length}/${parsed.length} remote images for user ${userId} (${failures.length} failed)`);
    return { items, failures };
  }

  private async ingestOne(userId: string, sourceUrl: string, url: URL): Promise<IngestedImageDto | FailedImageDto> {
    try {
      const response = await this.http.fetch(url, { accept: IMAGE_ACCEPT, maxBytes: this.media.limits.imageBytes });
      if (response.status < 200 || response.status >= 300) {
        return { sourceUrl, code: 'UPSTREAM_STATUS', message: `The image server answered HTTP ${response.status}` };
      }
      const stored = await this.media.uploadImage(
        { originalName: fileNameOf(response.url), declaredMimeType: response.contentType ?? '', buffer: response.body },
        { ownerUserId: userId, purpose: PRODUCT_IMAGE_PURPOSE, isPublic: true },
      );
      return {
        sourceUrl,
        id: stored.id,
        url: stored.url,
        thumbnailUrl: stored.thumbnailUrl,
        width: stored.width,
        height: stored.height,
        sizeBytes: stored.sizeBytes,
      };
    } catch (error) {
      if (error instanceof ImportError) {
        return { sourceUrl, code: error.code, message: error.message };
      }
      if (error instanceof BadRequestException) {
        return { sourceUrl, code: 'INVALID_IMAGE', message: messageOf(error) };
      }
      throw error;
    }
  }

  /** First active, visible local category whose name equals a source category (most specific first). */
  private async matchCategory(candidates: string[]): Promise<string | null> {
    if (candidates.length === 0) {
      return null;
    }
    const visible = new Set(await this.categories.visibleCategoryIds());
    const rows = await this.prisma.category.findMany({
      where: { isActive: true },
      select: { id: true, titleFa: true, titleEn: true },
    });
    const byName = new Map<string, string>();
    for (const row of rows) {
      if (!visible.has(row.id)) continue;
      for (const name of [row.titleFa, row.titleEn]) {
        if (name) {
          const key = categoryMatchKey(name);
          if (key.length > 0 && !byName.has(key)) byName.set(key, row.id);
        }
      }
    }
    for (const candidate of candidates) {
      const id = byName.get(categoryMatchKey(candidate));
      if (id !== undefined) return id;
    }
    return null;
  }

  private validateOrThrow(raw: string): URL {
    try {
      return this.http.validate(raw);
    } catch (error) {
      throw this.toHttp(error);
    }
  }

  private toHttp(error: unknown, url?: URL): unknown {
    if (error instanceof ImportError) {
      if (error.code === 'BLOCKED_TARGET') {
        this.logger.warn(`Refused importer target${url ? ` ${url.host}` : ''}: ${error.message}`);
      }
      return toHttpException(error);
    }
    return error;
  }

  private async requireApprovedStore(userId: string): Promise<void> {
    const store = await this.prisma.vendor.findUnique({ where: { userId }, select: { status: true } });
    if (store === null || store.status !== VendorStatus.APPROVED) {
      throw new ForbiddenException('Only an approved store can import products');
    }
  }

  /** Fixed-window quota in Redis; `amount` units are charged at once. */
  private async consume(key: string, amount: number, limit: number, windowSeconds: number, message: string): Promise<void> {
    const count = await this.redis.client.incrby(key, amount);
    if (count === amount) {
      await this.redis.client.expire(key, windowSeconds);
    }
    if (count > limit) {
      await this.redis.client.decrby(key, amount);
      const ttl = await this.redis.client.ttl(key);
      throw new TooManyRequestsException(message, ttl > 0 ? ttl : windowSeconds);
    }
  }
}

function fileNameOf(url: URL): string {
  const segment = url.pathname.split('/').pop() ?? '';
  let name = segment;
  try {
    name = decodeURIComponent(segment);
  } catch {
    // keep the raw segment; sanitizeOriginalName cleans it downstream
  }
  name = name.trim();
  return name.length > 0 ? name.slice(0, 120) : 'imported-image';
}

function messageOf(error: HttpException): string {
  const response = error.getResponse();
  if (typeof response === 'object' && response !== null && 'message' in response) {
    const message = (response).message;
    return Array.isArray(message) ? message.join('; ') : String(message);
  }
  return error.message;
}
