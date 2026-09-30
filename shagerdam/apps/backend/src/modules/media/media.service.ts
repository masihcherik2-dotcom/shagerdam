import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MediaKind, Prisma, UserRole } from '@prisma/client';
import type { FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { EnvironmentVariables } from '../../config/env.validation';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import {
  MAGIC_BYTE_PROBE_LENGTH,
  detectFileType,
  sanitizeOriginalName,
  type DetectedFileType,
} from './file-signature';
import {
  BRANDING_IMAGE_PROFILES,
  BRANDING_PURPOSE,
  SVG_RENDER_DENSITY,
  isSvgDocument,
  svgRejectionReason,
  type BrandingSlot,
} from './branding-image';
import { documentDownloadUrl } from './media-urls';

/** Longest edge of the stored (optimised) image, in pixels. */
const MAX_IMAGE_DIMENSION = 1_600;
/** Thumbnail box. `fit: cover` guarantees exactly 300×300 without distortion. */
const THUMBNAIL_SIZE = 300;
const WEBP_QUALITY = 82;

/**
 * Accepted types per endpoint.
 *
 * The document endpoint deliberately accepts PNG/JPEG as well as PDF: a KYC card
 * is usually photographed, and forcing a conversion would destroy the evidence.
 * GIF is not accepted as a document (nothing in the workflow produces one), and
 * the image endpoint does not accept PDFs — that is what the document endpoint is
 * for, and the error message says which one to use.
 */
const IMAGE_MIME_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const DOCUMENT_MIME_TYPES: ReadonlySet<string> = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
]);

/** Roles allowed to read any private asset (KYC review, support, auditing). */
const STAFF_ROLES_WITH_KYC_ACCESS = new Set<UserRole>([
  UserRole.SUPPORT,
  UserRole.FINANCIAL_OFFICER,
  UserRole.ADMIN,
  UserRole.SUPER_ADMIN,
]);
const THUMBNAIL_QUALITY = 75;

export interface UploadedFile {
  /** Original filename as sent by the client (untrusted; sanitized before use). */
  originalName: string;
  /** Declared content type; used only as a hint, never as a decision. */
  declaredMimeType: string;
  buffer: Buffer;
}

/**
 * Internal read model. It includes `path` — the object key the storage provider
 * needs — which is deliberately **not** part of the HTTP representation
 * (`MediaAssetDto`), so the API never discloses an internal key that would be
 * useful only to an attacker.
 */
/**
 * Result of resolving a public object key: which asset owns it, and **which** of
 * the asset's two keys matched. The thumbnail is a separate stored object, so
 * serving the URL is not the same as serving the asset's primary file.
 */
export interface PublicAssetLookup {
  asset: MediaAssetView;
  /** Provider-relative key to read: the file itself, or its thumbnail. */
  storagePath: string;
}

export interface MediaAssetView {
  id: string;
  kind: MediaKind;
  purpose: string;
  path: string;
  url: string;
  thumbnailUrl: string | null;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  originalName: string | null;
  isPublic: boolean;
  createdAt: Date;
}

export interface ImageUploadResult {
  id: string;
  url: string;
  thumbnailUrl: string;
  mimeType: 'image/webp';
  sizeBytes: number;
  originalSizeBytes: number;
  width: number;
  height: number;
  compressionRatio: number;
}

export interface DocumentUploadResult {
  id: string;
  url: string;
  originalName: string;
  sizeBytes: number;
  mimeType: string;
  isPublic: false;
}

/**
 * The media pipeline.
 *
 * Order of operations, and why it is this order:
 *
 * 1. **size** — reject before allocating anything else;
 * 2. **magic bytes** — reject a mislabelled file before Sharp sees it;
 * 3. **Sharp decode** — the real proof that the bytes are a usable image, and
 *    the source of the true dimensions (a `Content-Type: image/png` header is a
 *    claim, decoding is evidence);
 * 4. **re-encode to WebP** — the pipeline never stores the uploaded bytes as
 *    received, so an image cannot smuggle a payload in a side channel of a
 *    format Sharp would otherwise copy verbatim (EXIF, ICC, trailing data);
 * 5. **store** — only after the buffer is known-good, so a rejected upload never
 *    leaves a file behind;
 * 6. **record** — one row per stored file, written last, after both objects exist.
 *
 * Documents take a shorter path (2 → 5 → 6): they are stored as received because
 * re-encoding a PDF or a KYC scan would destroy its evidentiary value. They are
 * marked private and are streamed through the API instead of being published.
 */
@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);
  private readonly maxImageBytes: number;
  private readonly maxDocumentBytes: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.maxImageBytes = config.getOrThrow<number>('MEDIA_MAX_IMAGE_BYTES');
    this.maxDocumentBytes = config.getOrThrow<number>('MEDIA_MAX_DOCUMENT_BYTES');
  }

  get limits(): { imageBytes: number; documentBytes: number } {
    return { imageBytes: this.maxImageBytes, documentBytes: this.maxDocumentBytes };
  }

  // ─── Images ───────────────────────────────────────────────────────────────

  /**
   * Processes an uploaded image into two WebP objects (optimised + thumbnail)
   * and records the asset.
   *
   * `isPublic` is decided by the caller (`purpose`): a store logo is meant to be
   * seen by everyone, KYC material never is.
   */
  async uploadImage(
    file: UploadedFile,
    context: { ownerUserId: string; purpose: string; isPublic: boolean; vendorId?: string | null },
  ): Promise<ImageUploadResult> {
    this.assertWithinSize(file.buffer, this.maxImageBytes, 'image');
    const detected = this.assertDetectedType(file.buffer, 'image');

    const optimised = await this.processImage(file.buffer, { maxDimension: MAX_IMAGE_DIMENSION, quality: WEBP_QUALITY });
    const thumbnail = await this.processImage(file.buffer, {
      maxDimension: THUMBNAIL_SIZE,
      quality: THUMBNAIL_QUALITY,
      square: true,
    });

    const basePath = this.buildPath('images', context.purpose);
    const path = `${basePath}.webp`;
    const thumbnailPath = `${basePath}_thumb.webp`;

    const storedImage = await this.storage.upload({
      buffer: optimised.buffer,
      path,
      mimeType: 'image/webp',
      metadata: { originalType: detected.mimeType, purpose: context.purpose },
    });
    const storedThumbnail = await this.storage.upload({
      buffer: thumbnail.buffer,
      path: thumbnailPath,
      mimeType: 'image/webp',
      metadata: { purpose: `${context.purpose}_thumbnail` },
    });

    const asset = await this.prisma.mediaAsset.create({
      data: {
        ownerUserId: context.ownerUserId,
        vendorId: context.vendorId ?? null,
        kind: MediaKind.IMAGE,
        purpose: context.purpose,
        storageProvider: this.storage.kind,
        path: storedImage.path,
        thumbnailPath: storedThumbnail.path,
        url: storedImage.url,
        thumbnailUrl: storedThumbnail.url,
        mimeType: 'image/webp',
        originalName: sanitizeOriginalName(file.originalName),
        sizeBytes: storedImage.sizeBytes,
        width: optimised.width,
        height: optimised.height,
        isPublic: context.isPublic,
      },
      select: { id: true },
    });

    this.logger.log(
      `Stored image ${asset.id} (${context.purpose}): ${file.buffer.byteLength}B ${detected.extension} → ${storedImage.sizeBytes}B webp`,
    );

    return {
      id: asset.id,
      url: storedImage.url,
      thumbnailUrl: storedThumbnail.url,
      mimeType: 'image/webp',
      sizeBytes: storedImage.sizeBytes,
      originalSizeBytes: file.buffer.byteLength,
      width: optimised.width,
      height: optimised.height,
      compressionRatio: Number((storedImage.sizeBytes / file.buffer.byteLength).toFixed(4)),
    };
  }

  // ─── Branding (platform visual identity) ─────────────────────────────────

  /**
   * Logo / mobile logo / favicon / hero banner. Same pipeline as `uploadImage`
   * (size → type → Sharp decode → WebP re-encode → store → record) with a
   * per-slot profile, plus SVG for the logo slots — rasterised, never stored as
   * SVG (see `branding-image.ts`). Always public: these are shown to everyone.
   */
  async uploadBrandingImage(file: UploadedFile, context: { ownerUserId: string; slot: BrandingSlot }): Promise<ImageUploadResult> {
    const profile = BRANDING_IMAGE_PROFILES[context.slot];
    const purpose = BRANDING_PURPOSE[context.slot];
    this.assertWithinSize(file.buffer, this.maxImageBytes, 'image');

    let originalType: string;
    let density: number | undefined;
    if (isSvgDocument(file.buffer)) {
      if (!profile.acceptsSvg) {
        throw new BadRequestException({
          statusCode: 400,
          error: 'Bad Request',
          code: 'BRANDING_SVG_NOT_ALLOWED',
          message: 'SVG is accepted for logos and the favicon only; upload a PNG, JPEG or WEBP banner',
        });
      }
      const reason = svgRejectionReason(file.buffer);
      if (reason) {
        throw new BadRequestException({ statusCode: 400, error: 'Bad Request', code: 'BRANDING_SVG_REJECTED', message: reason });
      }
      originalType = 'image/svg+xml';
      density = SVG_RENDER_DENSITY;
    } else {
      originalType = this.assertDetectedType(file.buffer, 'image').mimeType;
    }

    const source = await this.sourceDimensions(file.buffer, density);
    if (source.width < profile.minWidth || source.height < profile.minHeight) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'BRANDING_IMAGE_TOO_SMALL',
        message: `The image is too small for this slot: ${source.width}×${source.height}px, minimum ${profile.minWidth}×${profile.minHeight}px`,
        width: source.width,
        height: source.height,
        minWidth: profile.minWidth,
        minHeight: profile.minHeight,
      });
    }

    const main = await this.processImage(file.buffer, {
      width: profile.width,
      height: profile.height,
      fit: profile.fit,
      quality: profile.quality,
      lossless: profile.lossless,
      density,
    });
    const thumbnail = await this.processImage(file.buffer, {
      width: profile.thumbnail.width,
      height: profile.thumbnail.height,
      fit: profile.thumbnail.fit,
      quality: profile.thumbnail.quality,
      lossless: profile.lossless,
      density,
    });

    const basePath = this.buildPath('images', purpose);
    const storedImage = await this.storage.upload({
      buffer: main.buffer,
      path: `${basePath}.webp`,
      mimeType: 'image/webp',
      metadata: { originalType, purpose },
    });
    const storedThumbnail = await this.storage.upload({
      buffer: thumbnail.buffer,
      path: `${basePath}_thumb.webp`,
      mimeType: 'image/webp',
      metadata: { purpose: `${purpose}_thumbnail` },
    });

    const asset = await this.prisma.mediaAsset.create({
      data: {
        ownerUserId: context.ownerUserId,
        vendorId: null,
        kind: MediaKind.IMAGE,
        purpose,
        storageProvider: this.storage.kind,
        path: storedImage.path,
        thumbnailPath: storedThumbnail.path,
        url: storedImage.url,
        thumbnailUrl: storedThumbnail.url,
        mimeType: 'image/webp',
        originalName: sanitizeOriginalName(file.originalName),
        sizeBytes: storedImage.sizeBytes,
        width: main.width,
        height: main.height,
        isPublic: true,
      },
      select: { id: true },
    });

    this.logger.log(
      `Stored branding image ${asset.id} (${purpose}): ${file.buffer.byteLength}B ${originalType} → ${storedImage.sizeBytes}B webp ${main.width}×${main.height}`,
    );

    return {
      id: asset.id,
      url: storedImage.url,
      thumbnailUrl: storedThumbnail.url,
      mimeType: 'image/webp',
      sizeBytes: storedImage.sizeBytes,
      originalSizeBytes: file.buffer.byteLength,
      width: main.width,
      height: main.height,
      compressionRatio: Number((storedImage.sizeBytes / file.buffer.byteLength).toFixed(4)),
    };
  }

  // ─── Documents ────────────────────────────────────────────────────────────

  /**
   * Stores a KYC/verification document. Never re-encoded, always private.
   *
   * A PDF is additionally opened by Sharp's metadata reader only when it is an
   * image; a PDF is accepted on its magic bytes alone, which is what its
   * producers and reviewers expect.
   */
  async uploadDocument(
    file: UploadedFile,
    context: { ownerUserId: string; purpose: string; vendorId?: string | null },
  ): Promise<DocumentUploadResult> {
    this.assertWithinSize(file.buffer, this.maxDocumentBytes, 'document');
    const detected = this.assertDetectedType(file.buffer, 'document');
    const originalName = sanitizeOriginalName(file.originalName);

    const path = `${this.buildPath('documents', context.purpose)}.${detected.extension}`;

    const stored = await this.storage.upload({
      buffer: file.buffer,
      path,
      mimeType: detected.mimeType,
      metadata: { purpose: context.purpose, originalName },
    });

    // The id is generated here, not by the database, because the canonical URL of a
    // private document *is* the guarded download route — and that route needs the
    // id. Handing back the provider path instead would produce a URL that 404s by
    // design (private objects are not served through the public file route), which
    // is exactly the kind of lying response a client cannot debug.
    const assetId = randomUUID();

    const asset = await this.prisma.mediaAsset.create({
      data: {
        id: assetId,
        ownerUserId: context.ownerUserId,
        vendorId: context.vendorId ?? null,
        kind: MediaKind.DOCUMENT,
        purpose: context.purpose,
        storageProvider: this.storage.kind,
        path: stored.path,
        url: documentDownloadUrl(assetId),
        mimeType: detected.mimeType,
        originalName,
        sizeBytes: stored.sizeBytes,
        isPublic: false,
      },
      select: { id: true },
    });

    this.logger.log(`Stored document ${asset.id} (${context.purpose}): ${originalName} ${stored.sizeBytes}B`);

    return {
      id: asset.id,
      url: documentDownloadUrl(asset.id),
      originalName,
      sizeBytes: stored.sizeBytes,
      mimeType: detected.mimeType,
      isPublic: false,
    };
  }

  // ─── Reads ────────────────────────────────────────────────────────────────

  async findAsset(id: string): Promise<MediaAssetView | null> {
    const asset = await this.prisma.mediaAsset.findUnique({ where: { id } });
    if (asset === null) {
      return null;
    }
    return {
      id: asset.id,
      kind: asset.kind,
      purpose: asset.purpose,
      path: asset.path,
      url: asset.url,
      thumbnailUrl: asset.thumbnailUrl,
      mimeType: asset.mimeType,
      sizeBytes: asset.sizeBytes,
      width: asset.width,
      height: asset.height,
      originalName: asset.originalName,
      isPublic: asset.isPublic,
      createdAt: asset.createdAt,
    };
  }

  /**
   * Public lookup by object key, used by the anonymous file route.
   *
   * Both of an asset's keys resolve here — the image and its thumbnail — because
   * both are published and both are in the URL a storefront embeds. The row is
   * what authorizes the file, so an unpublished object key yields `null` no matter
   * how plausible the path looks.
   */
  async findPublicAssetByPath(path: string): Promise<PublicAssetLookup | null> {
    const row = await this.prisma.mediaAsset.findFirst({
      where: { isPublic: true, OR: [{ path }, { thumbnailPath: path }] },
      select: { id: true, path: true, thumbnailPath: true },
    });
    if (row === null) {
      return null;
    }

    const asset = await this.findAsset(row.id);
    if (asset === null) {
      return null;
    }

    return {
      asset,
      storagePath: row.thumbnailPath === path ? row.thumbnailPath : row.path,
    };
  }

  /** Every asset of a vendor, newest first — used by the admin vendor detail view. */
  async listVendorAssets(vendorId: string): Promise<MediaAssetView[]> {
    const assets = await this.prisma.mediaAsset.findMany({
      where: { vendorId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return assets.map((asset) => ({
      id: asset.id,
      kind: asset.kind,
      purpose: asset.purpose,
      path: asset.path,
      url: asset.url,
      thumbnailUrl: asset.thumbnailUrl,
      mimeType: asset.mimeType,
      sizeBytes: asset.sizeBytes,
      width: asset.width,
      height: asset.height,
      originalName: asset.originalName,
      isPublic: asset.isPublic,
      createdAt: asset.createdAt,
    }));
  }

  /**
   * Authorization for private objects: the owner, or a member of staff whose job
   * requires the file. Vendors never see other vendors' KYC material.
   *
   * `SUPPORT` and `FINANCIAL_OFFICER` are included because a support agent must
   * read the document a vendor complains about, and a credit officer must review
   * the bank proof attached to a KYC file — but neither can approve a vendor,
   * which stays with `ADMIN`/`SUPER_ADMIN`.
   */
  async canAccessPrivateAsset(params: {
    asset: MediaAssetView;
    user: { id: string; role: UserRole };
  }): Promise<boolean> {
    if (params.asset.isPublic) {
      return true;
    }

    const owner = await this.prisma.mediaAsset.findUnique({
      where: { id: params.asset.id },
      select: { ownerUserId: true },
    });
    if (owner?.ownerUserId === params.user.id) {
      return true;
    }

    if (STAFF_ROLES_WITH_KYC_ACCESS.has(params.user.role)) {
      return true;
    }

    // Dispute evidence (Phase 9): both parties of the dispute may read it — the
    // customer who raised it and the owner of the store it is against.
    const sharedAsEvidence = await this.prisma.disputeEvidence.count({
      where: {
        mediaAssetId: params.asset.id,
        dispute: { OR: [{ raisedByUserId: params.user.id }, { vendor: { userId: params.user.id } }] },
      },
    });
    return sharedAsEvidence > 0;
  }

  /**
   * Pipelines a stored object to the HTTP response.
   *
   * Content is read from the active provider — never from a client-supplied path
   * — and the response carries the stored content type plus hardening headers, so
   * an HTML-looking payload could not be rendered as a page even if the
   * magic-byte filter were somehow bypassed.
   *
   * `storagePath` defaults to the asset's own file and is overridden only when the
   * request was for the thumbnail key.
   */
  async streamAsset(asset: MediaAssetView, reply: FastifyReply, storagePath?: string): Promise<void> {
    const buffer = await this.storage.read(storagePath ?? asset.path);

    reply
      .header('content-type', asset.mimeType)
      .header('content-length', String(buffer.byteLength))
      .header('cache-control', asset.isPublic ? 'public, max-age=31536000, immutable' : 'private, no-store')
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .send(buffer);
  }

  /** Honest report of the active storage provider, surfaced by the API. */
  storageProviderInfo(): { provider: string; isLocal: boolean } {
    return this.storage.describe();
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private assertWithinSize(buffer: Buffer, limit: number, label: string): void {
    if (buffer.byteLength === 0) {
      throw new BadRequestException('The uploaded file is empty');
    }
    if (buffer.byteLength > limit) {
      throw new BadRequestException(
        `The ${label} exceeds the maximum size of ${Math.round(limit / 1024 / 1024)} MB`,
      );
    }
  }

  /**
   * Magic bytes decide; a client-supplied extension or `Content-Type` never does.
   *
   * A file whose bytes are not in the allow-list is rejected here, before Sharp or
   * the storage provider ever see it, and a file that *is* identifiable but belongs
   * to the other family (a PDF sent to the image endpoint) is reported with the
   * type that actually arrived so the client can fix the call.
   */
  private assertDetectedType(buffer: Buffer, expected: 'image' | 'document'): DetectedFileType {
    if (buffer.length < MAGIC_BYTE_PROBE_LENGTH) {
      throw new BadRequestException('The file is too small to identify and was rejected');
    }

    const detected = detectFileType(buffer);
    if (detected === null) {
      throw new BadRequestException(
        expected === 'image'
          ? 'Unsupported image format. Allowed: PNG, JPEG, GIF, WEBP'
          : 'Unsupported document format. Allowed: PDF, PNG, JPEG',
      );
    }

    const accepted = expected === 'image' ? IMAGE_MIME_TYPES : DOCUMENT_MIME_TYPES;
    if (!accepted.has(detected.mimeType)) {
      throw new BadRequestException(
        expected === 'image'
          ? `Expected an image (PNG, JPEG, GIF, WEBP) but received ${detected.mimeType}`
          : `Expected a document (PDF, PNG, JPEG) but received ${detected.mimeType}`,
      );
    }
    return detected;
  }

  /**
   * Decodes and re-encodes with Sharp.
   *
   * `failOn: 'error'` makes a truncated or corrupt image throw instead of being
   * silently repaired, and `.rotate()` (no argument) applies the EXIF
   * orientation before the EXIF block is dropped by the WebP encoder — without
   * it, phone photos would be stored sideways.
   */
  private async processImage(
    buffer: Buffer,
    options: {
      maxDimension?: number;
      width?: number;
      height?: number;
      fit?: 'inside' | 'contain' | 'cover';
      quality: number;
      square?: boolean;
      lossless?: boolean;
      /** Rasterisation density for vector input (SVG). */
      density?: number;
    },
  ): Promise<{ buffer: Buffer; width: number; height: number }> {
    try {
      const pipeline = sharp(buffer, {
        failOn: 'error',
        limitInputPixels: 50_000_000,
        ...(options.density ? { density: options.density } : {}),
      }).rotate();

      const width = options.width ?? options.maxDimension;
      const height = options.height ?? options.maxDimension;
      const fit = options.square === true ? 'cover' : (options.fit ?? 'inside');
      const resized =
        fit === 'cover'
          ? pipeline.resize({ width, height, fit: 'cover' })
          : fit === 'contain'
            ? pipeline.resize({ width, height, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
            : pipeline.resize({ width, height, fit: 'inside', withoutEnlargement: true });

      const { data, info } = await resized
        .webp(options.lossless === true ? { lossless: true, effort: 4 } : { quality: options.quality, effort: 4 })
        .toBuffer({ resolveWithObject: true });

      return { buffer: data, width: info.width, height: info.height };
    } catch (error) {
      this.logger.warn(`Image processing rejected a file: ${String(error)}`);
      throw new BadRequestException('The file is not a readable image or is corrupted');
    }
  }

  /** Decoded dimensions of the source (after SVG rasterisation at `density`). */
  private async sourceDimensions(buffer: Buffer, density?: number): Promise<{ width: number; height: number }> {
    try {
      const meta = await sharp(buffer, {
        failOn: 'error',
        limitInputPixels: 50_000_000,
        ...(density ? { density } : {}),
      }).metadata();
      if (!meta.width || !meta.height) {
        throw new Error('no dimensions');
      }
      // EXIF orientations 5–8 swap the axes once `.rotate()` applies them.
      const swapped = (meta.orientation ?? 1) >= 5;
      return swapped ? { width: meta.height, height: meta.width } : { width: meta.width, height: meta.height };
    } catch (error) {
      this.logger.warn(`Image metadata rejected a file: ${String(error)}`);
      throw new BadRequestException('The file is not a readable image or is corrupted');
    }
  }

  /**
   * Object key: `<family>/<purpose>/<yyyy>/<mm>/<uuid>`. The date prefix keeps
   * directories and S3 prefixes small, and the UUID makes collisions impossible
   * without trusting anything from the client.
   */
  private buildPath(family: string, purpose: string): string {
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const safePurpose = purpose.replace(/[^a-z0-9_-]/gi, '_').slice(0, 40);
    return `${family}/${safePurpose}/${year}/${month}/${randomUUID()}`;
  }
}

/** Narrow helper so callers can distinguish a Prisma unique violation if needed. */
export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
