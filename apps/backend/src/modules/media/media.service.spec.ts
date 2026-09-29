import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { MediaKind, UserRole } from '@prisma/client';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import type { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables } from '../../config/env.validation';
import type { PrismaService } from '../../infra/prisma/prisma.service';
import { LocalStorageProvider } from '../storage/providers/local-storage.provider';
import { StorageService } from '../storage/storage.service';
import {
  StorageError,
  type StorageProvider,
  type UploadParams,
} from '../storage/storage-provider.interface';
import { MediaService, type MediaAssetView, type UploadedFile } from './media.service';
import { detectFileType } from './file-signature';

/**
 * Unit coverage of the media pipeline.
 *
 * Sharp, the storage provider and the filesystem are **real**: the images are
 * genuine PNG/JPEG buffers produced by Sharp itself, they are written to a
 * temporary directory and read back from it, and the dimension assertions decode
 * the stored bytes rather than trusting the metadata the service returned. Only
 * `PrismaService` is a fake, because these tests are about the file pipeline, not
 * about PostgreSQL.
 */

const IMAGE_LIMIT = 5 * 1024 * 1024;
const DOCUMENT_LIMIT = 10 * 1024 * 1024;
const OWNER = 'user-owner-1';

interface AssetRow {
  id: string;
  ownerUserId: string | null;
  vendorId: string | null;
  kind: MediaKind;
  purpose: string;
  storageProvider: string;
  path: string;
  thumbnailPath: string | null;
  url: string;
  thumbnailUrl: string | null;
  mimeType: string;
  originalName: string | null;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  isPublic: boolean;
  createdAt: Date;
}

/** Minimal in-memory stand-in for the `media_assets` table. */
function createPrismaFake(): {
  service: PrismaService;
  rows: Map<string, AssetRow>;
  setOwner: (id: string, ownerUserId: string) => void;
  shareAsEvidence: (mediaAssetId: string, partyUserIds: string[]) => void;
} {
  const rows = new Map<string, AssetRow>();
  /** `dispute_evidence` rows: asset → user ids of the dispute's parties (customer, store owner). */
  const evidence: Array<{ mediaAssetId: string; parties: string[] }> = [];
  const owners = new Map<string, string>();
  let counter = 0;

  const withOwner = (row: AssetRow): AssetRow =>
    owners.has(row.id) ? { ...row, ownerUserId: owners.get(row.id) ?? null } : row;

  const service = {
    disputeEvidence: {
      count: (args: { where: { mediaAssetId: string; dispute: { OR: Array<{ raisedByUserId?: string; vendor?: { userId: string } }> } } }): Promise<number> => {
        const callers = args.where.dispute.OR.map((clause) => clause.raisedByUserId ?? clause.vendor?.userId);
        const hits = evidence.filter((row) => row.mediaAssetId === args.where.mediaAssetId && row.parties.some((party) => callers.includes(party)));
        return Promise.resolve(hits.length);
      },
    },
    mediaAsset: {
      create: (args: { data: Record<string, unknown> }): Promise<AssetRow> => {
        counter += 1;
        const row: AssetRow = {
          id: `asset-${counter}`,
          createdAt: new Date('2026-09-26T10:00:00.000Z'),
          ownerUserId: null,
          vendorId: null,
          kind: MediaKind.IMAGE,
          purpose: 'unknown',
          storageProvider: 'local',
          thumbnailPath: null,
          thumbnailUrl: null,
          originalName: null,
          width: null,
          height: null,
          isPublic: false,
          ...args.data,
        } as AssetRow;
        rows.set(row.id, row);
        return Promise.resolve(row);
      },
      findUnique: (args: { where: { id: string } }): Promise<AssetRow | null> => {
        const row = rows.get(args.where.id);
        return Promise.resolve(row === undefined ? null : withOwner(row));
      },
      findFirst: (args: {
        where: { path?: string; thumbnailPath?: string; isPublic?: boolean; OR?: Array<{ path?: string; thumbnailPath?: string }> };
      }): Promise<AssetRow | null> => {
        for (const row of rows.values()) {
          const matches = (candidate: AssetRow): boolean => {
            if (args.where.isPublic !== undefined && candidate.isPublic !== args.where.isPublic) {
              return false;
            }
            if (args.where.path !== undefined && candidate.path !== args.where.path) {
              return false;
            }
            if (args.where.thumbnailPath !== undefined && candidate.thumbnailPath !== args.where.thumbnailPath) {
              return false;
            }
            if (args.where.OR !== undefined) {
              return args.where.OR.some(
                (clause) =>
                  (clause.path !== undefined && candidate.path === clause.path) ||
                  (clause.thumbnailPath !== undefined && candidate.thumbnailPath === clause.thumbnailPath),
              );
            }
            return true;
          };
          if (matches(row)) {
            return Promise.resolve(withOwner(row));
          }
        }
        return Promise.resolve(null);
      },
      findMany: (): Promise<AssetRow[]> => Promise.resolve([...rows.values()].map(withOwner)),
    },
  } as unknown as PrismaService;

  return {
    service,
    rows,
    setOwner: (id: string, ownerUserId: string): void => {
      owners.set(id, ownerUserId);
    },
    shareAsEvidence: (mediaAssetId: string, partyUserIds: string[]): void => {
      evidence.push({ mediaAssetId, parties: partyUserIds });
    },
  };
}

/** Captures the headers a handler would have sent, without an HTTP server. */
interface ReplyStub {
  statusCode?: number;
  payload?: unknown;
  headers: Record<string, string>;
  header(name: string, value: string): ReplyStub;
  send(payload: Buffer): ReplyStub;
}

const createReplyStub = (): ReplyStub => {
  const stub: ReplyStub = {
    headers: {},
    header(name: string, value: string): ReplyStub {
      stub.headers[name.toLowerCase()] = value;
      return stub;
    },
    send(payload: Buffer): ReplyStub {
      stub.payload = payload;
      return stub;
    },
  };
  return stub;
};

const upload = (buffer: Buffer, originalName: string, declaredMimeType: string): UploadedFile => ({
  buffer,
  originalName,
  declaredMimeType,
});

describe('MediaService (real Sharp, real filesystem, fake Prisma)', () => {
  let uploadRoot: string;
  let prismaFake: ReturnType<typeof createPrismaFake>;
  let storage: StorageService;
  let service: MediaService;

  const png = (width: number, height: number): Promise<Buffer> =>
    sharp({
      create: {
        width,
        height,
        channels: 3,
        background: { r: 40, g: 120, b: 200 },
      },
    })
      .png()
      .toBuffer();

  const jpeg = (width: number, height: number): Promise<Buffer> =>
    sharp({
      create: { width, height, channels: 3, background: { r: 230, g: 20, b: 90 } },
    })
      .jpeg()
      .toBuffer();

  const configFake = {
    getOrThrow: (key: string): unknown => {
      if (key === 'MEDIA_MAX_IMAGE_BYTES') {
        return IMAGE_LIMIT;
      }
      if (key === 'MEDIA_MAX_DOCUMENT_BYTES') {
        return DOCUMENT_LIMIT;
      }
      throw new Error(`unexpected config key ${key}`);
    },
  } as unknown as ConfigService<EnvironmentVariables, true>;

  beforeAll(async () => {
    uploadRoot = await mkdtemp(join(tmpdir(), 'shopino-media-'));
  });

  afterAll(async () => {
    await rm(uploadRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    prismaFake = createPrismaFake();
    storage = new StorageService(
      new LocalStorageProvider({ root: uploadRoot, publicBaseUrl: '/api/v1/media/files' }),
    );
    service = new MediaService(prismaFake.service, storage, configFake);
  });

  // ─── Images ───────────────────────────────────────────────────────────────

  it('converts a 2400x1600 PNG to WebP capped at 1600px, plus a 300x300 thumbnail', async () => {
    const source = await png(2_400, 1_600);

    const result = await service.uploadImage(upload(source, 'store-logo.png', 'image/png'), {
      ownerUserId: OWNER,
      purpose: 'store_logo',
      isPublic: true,
    });

    expect(result.mimeType).toBe('image/webp');
    expect(result.width).toBe(1_600);
    expect(result.height).toBe(1_067);
    expect(result.originalSizeBytes).toBe(source.byteLength);
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(result.sizeBytes).toBeLessThan(source.byteLength);
    expect(result.compressionRatio).toBeCloseTo(result.sizeBytes / source.byteLength, 4);

    // The bytes on disk are what the response describes — verified by decoding them.
    const optimisedBytes = await readFile(join(uploadRoot, result.url.replace('/api/v1/media/files/', '')));
    const thumbnailBytes = await readFile(
      join(uploadRoot, result.thumbnailUrl.replace('/api/v1/media/files/', '')),
    );

    expect(detectFileType(optimisedBytes)?.mimeType).toBe('image/webp');
    expect(detectFileType(thumbnailBytes)?.mimeType).toBe('image/webp');

    const optimisedMeta = await sharp(optimisedBytes).metadata();
    expect([optimisedMeta.width, optimisedMeta.height]).toEqual([1_600, 1_067]);

    const thumbnailMeta = await sharp(thumbnailBytes).metadata();
    expect([thumbnailMeta.width, thumbnailMeta.height]).toEqual([300, 300]);

    // Keys are siblings and both carry the purpose and the date prefix.
    expect(result.url).toMatch(/\/images\/store_logo\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.webp$/);
    expect(result.thumbnailUrl).toBe(result.url.replace(/\.webp$/, '_thumb.webp'));
  });

  it('never enlarges a small image and stores it at its original size', async () => {
    const source = await jpeg(320, 240);

    const result = await service.uploadImage(upload(source, 'product.jpg', 'image/jpeg'), {
      ownerUserId: OWNER,
      purpose: 'product_image',
      isPublic: true,
    });

    expect([result.width, result.height]).toEqual([320, 240]);
  });

  it('applies the EXIF orientation so phone photos are not stored sideways', async () => {
    const rotated = await sharp({
      create: { width: 900, height: 600, channels: 3, background: { r: 10, g: 10, b: 10 } },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();

    const result = await service.uploadImage(upload(rotated, 'photo.jpg', 'image/jpeg'), {
      ownerUserId: OWNER,
      purpose: 'product_image',
      isPublic: true,
    });

    // Orientation 6 means "rotate 90°": a 900x600 source is stored as 600x900.
    expect([result.width, result.height]).toEqual([600, 900]);
  });

  it('rejects a text file sent as image/png on its bytes, not on the declared type', async () => {
    const payload = Buffer.from('<html><body><script>alert(1)</script></body></html>', 'utf8');

    await expect(
      service.uploadImage(upload(payload, 'screenshot.png', 'image/png'), {
        ownerUserId: OWNER,
        purpose: 'product_image',
        isPublic: true,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      service.uploadImage(upload(payload, 'screenshot.png', 'image/png'), {
        ownerUserId: OWNER,
        purpose: 'product_image',
        isPublic: true,
      }),
    ).rejects.toThrow('Unsupported image format. Allowed: PNG, JPEG, GIF, WEBP');
  });

  it('rejects a corrupt image that carries valid PNG magic bytes', async () => {
    const corrupted = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('not an IHDR chunk at all, just text', 'latin1'),
    ]);

    await expect(
      service.uploadImage(upload(corrupted, 'broken.png', 'image/png'), {
        ownerUserId: OWNER,
        purpose: 'product_image',
        isPublic: true,
      }),
    ).rejects.toThrow('The file is not a readable image or is corrupted');
  });

  it('rejects an image above the 5 MB ceiling before it is processed', async () => {
    const oversized = Buffer.alloc(IMAGE_LIMIT + 1, 0x41);
    oversized.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);

    await expect(
      service.uploadImage(upload(oversized, 'huge.png', 'image/png'), {
        ownerUserId: OWNER,
        purpose: 'product_image',
        isPublic: true,
      }),
    ).rejects.toThrow('The image exceeds the maximum size of 5 MB');
  });

  it('rejects an empty upload with a message that says so', async () => {
    await expect(
      service.uploadImage(upload(Buffer.alloc(0), 'empty.png', 'image/png'), {
        ownerUserId: OWNER,
        purpose: 'product_image',
        isPublic: true,
      }),
    ).rejects.toThrow('The uploaded file is empty');
  });

  it('rejects a PDF sent to the image endpoint, naming the type that actually arrived', async () => {
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n', 'latin1'), Buffer.alloc(64, 0x20)]);

    await expect(
      service.uploadImage(upload(pdf, 'invoice.pdf', 'application/pdf'), {
        ownerUserId: OWNER,
        purpose: 'product_image',
        isPublic: true,
      }),
    ).rejects.toThrow('Expected an image (PNG, JPEG, GIF, WEBP) but received application/pdf');
  });

  it('refuses to store a document through the image endpoint', async () => {
    const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64, 0x00)]);

    await expect(
      service.uploadImage(upload(zip, 'archive.png', 'image/png'), {
        ownerUserId: OWNER,
        purpose: 'product_image',
        isPublic: true,
      }),
    ).rejects.toThrow('Unsupported image format');

    expect(prismaFake.rows.size).toBe(0);
  });

  // ─── Documents ────────────────────────────────────────────────────────────

  it('stores a KYC document byte-for-byte and marks it private', async () => {
    const source = await jpeg(1_200, 900);

    const result = await service.uploadDocument(upload(source, 'national-card.jpg', 'image/jpeg'), {
      ownerUserId: OWNER,
      purpose: 'kyc_national_id',
    });

    expect(result.isPublic).toBe(false);
    expect(result.mimeType).toBe('image/jpeg');
    expect(result.sizeBytes).toBe(source.byteLength);
    expect(result.originalName).toBe('national-card.jpg');
    expect(result.url).toBe(`/api/v1/media/documents/${result.id}/download`);

    const stored = await readFile(join(uploadRoot, (await service.findAsset(result.id))!.path));
    expect(stored.equals(source)).toBe(true);
    expect(join(uploadRoot, (await service.findAsset(result.id))!.path)).toContain('/documents/kyc_national_id/');

    const row = await service.findAsset(result.id);
    expect(row?.kind).toBe(MediaKind.DOCUMENT);
    expect(row?.isPublic).toBe(false);
    // Documents are stored as received and never decoded: a PDF or a KYC scan is
    // evidence, and handing untrusted bytes to an image decoder to learn their
    // dimensions would buy a cosmetic field at the price of an attack surface.
    expect([row?.width, row?.height]).toEqual([null, null]);
    expect(row?.path).toContain('documents/kyc_national_id/');
  });

  it('accepts a PDF as a document on its magic bytes', async () => {
    const pdf = Buffer.concat([
      Buffer.from('%PDF-1.7\n', 'latin1'),
      Buffer.alloc(512, 0x20),
      Buffer.from('%%EOF', 'latin1'),
    ]);

    const result = await service.uploadDocument(upload(pdf, 'bank-statement.pdf', 'application/pdf'), {
      ownerUserId: OWNER,
      purpose: 'kyc_bank_proof',
    });

    expect(result.mimeType).toBe('application/pdf');
    expect(result.sizeBytes).toBe(pdf.byteLength);
  });

  it('rejects a ZIP archive renamed to .pdf on the document endpoint too', async () => {
    const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(128, 0x00)]);

    await expect(
      service.uploadDocument(upload(zip, 'licence.pdf', 'application/pdf'), {
        ownerUserId: OWNER,
        purpose: 'kyc_business_license',
      }),
    ).rejects.toThrow('Unsupported document format. Allowed: PDF, PNG, JPEG');
  });

  it('rejects a GIF as a document: nothing in the workflow produces one', async () => {
    const gif = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(64, 0x33)]);

    await expect(
      service.uploadDocument(upload(gif, 'card.gif', 'image/gif'), {
        ownerUserId: OWNER,
        purpose: 'kyc_national_id',
      }),
    ).rejects.toThrow('Expected a document (PDF, PNG, JPEG) but received image/gif');
  });

  it('rejects a document above the 10 MB ceiling', async () => {
    const oversized = Buffer.alloc(DOCUMENT_LIMIT + 1, 0x20);
    oversized.set(Buffer.from('%PDF-1.7', 'latin1'), 0);

    await expect(
      service.uploadDocument(upload(oversized, 'big.pdf', 'application/pdf'), {
        ownerUserId: OWNER,
        purpose: 'kyc_national_id',
      }),
    ).rejects.toThrow('The document exceeds the maximum size of 10 MB');
  });

  it('sanitizes the stored original name of a document', async () => {
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n', 'latin1'), Buffer.alloc(64, 0x20)]);

    const result = await service.uploadDocument(
      upload(pdf, '../../etc/statement.html', 'application/pdf'),
      { ownerUserId: OWNER, purpose: 'kyc_bank_proof' },
    );

    expect(result.originalName).toBe('etc_statement.bin');
  });

  // ─── Lookup and access control ────────────────────────────────────────────

  it('resolves a public asset by its own key and by its thumbnail key', async () => {
    const source = await png(600, 600);
    const uploaded = await service.uploadImage(upload(source, 'logo.png', 'image/png'), {
      ownerUserId: OWNER,
      purpose: 'store_logo',
      isPublic: true,
    });

    const asset = await service.findAsset(uploaded.id);
    // Both keys are published, so both resolve — and each resolves to itself.
    const thumbnailKey = asset!.thumbnailUrl!.replace('/api/v1/media/files/', '');
    const byFile = await service.findPublicAssetByPath(asset!.path);
    const byThumbnail = await service.findPublicAssetByPath(thumbnailKey);

    expect(byFile?.asset.id).toBe(uploaded.id);
    expect(byFile?.storagePath).toBe(asset!.path);
    expect(byThumbnail?.asset.id).toBe(uploaded.id);
    expect(byThumbnail?.storagePath).toBe(thumbnailKey);

    // The two keys are different objects on disk, which is why serving the
    // thumbnail cannot simply reuse the asset's own path.
    expect(thumbnailKey).not.toBe(asset!.path);
  });

  it('never resolves a private document through the public key route', async () => {
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n', 'latin1'), Buffer.alloc(64, 0x20)]);
    const uploaded = await service.uploadDocument(upload(pdf, 'card.pdf', 'application/pdf'), {
      ownerUserId: OWNER,
      purpose: 'kyc_national_id',
    });
    const asset = await service.findAsset(uploaded.id);

    expect(await service.findPublicAssetByPath(asset!.path)).toBeNull();
    expect(await service.findPublicAssetByPath('images/store_logo/2026/09/nope.webp')).toBeNull();
  });

  it('grants private documents to the owner and to reviewing staff only', async () => {
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n', 'latin1'), Buffer.alloc(64, 0x20)]);
    const uploaded = await service.uploadDocument(upload(pdf, 'card.pdf', 'application/pdf'), {
      ownerUserId: OWNER,
      purpose: 'kyc_national_id',
    });
    const asset = (await service.findAsset(uploaded.id)) as MediaAssetView;
    prismaFake.setOwner(asset.id, OWNER);

    const allowed = await Promise.all(
      [UserRole.SUPPORT, UserRole.ADMIN, UserRole.SUPER_ADMIN, UserRole.FINANCIAL_OFFICER].map((role) =>
        service.canAccessPrivateAsset({ asset, user: { id: 'staff-1', role } }),
      ),
    );
    expect(allowed).toEqual([true, true, true, true]);

    expect(await service.canAccessPrivateAsset({ asset, user: { id: OWNER, role: UserRole.CUSTOMER } })).toBe(true);
    expect(
      await service.canAccessPrivateAsset({ asset, user: { id: 'someone-else', role: UserRole.VENDOR } }),
    ).toBe(false);
  });

  it('grants dispute evidence to both parties of the dispute and to nobody else (Phase 9)', async () => {
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n', 'latin1'), Buffer.alloc(64, 0x20)]);
    const uploaded = await service.uploadDocument(upload(pdf, 'photo.pdf', 'application/pdf'), { ownerUserId: OWNER, purpose: 'dispute_evidence' });
    const asset = (await service.findAsset(uploaded.id)) as MediaAssetView;
    prismaFake.setOwner(asset.id, OWNER);

    expect(await service.canAccessPrivateAsset({ asset, user: { id: 'store-owner', role: UserRole.VENDOR } })).toBe(false);
    prismaFake.shareAsEvidence(asset.id, [OWNER, 'store-owner']);
    expect(await service.canAccessPrivateAsset({ asset, user: { id: 'store-owner', role: UserRole.VENDOR } })).toBe(true);
    expect(await service.canAccessPrivateAsset({ asset, user: { id: 'other-store', role: UserRole.VENDOR } })).toBe(false);
    expect(await service.canAccessPrivateAsset({ asset, user: { id: 'other-customer', role: UserRole.CUSTOMER } })).toBe(false);
  });

  it('serves a public file as cacheable and a private one as no-store, with hardening headers', async () => {
    const source = await png(500, 500);
    const uploaded = await service.uploadImage(upload(source, 'logo.png', 'image/png'), {
      ownerUserId: OWNER,
      purpose: 'store_logo',
      isPublic: true,
    });
    const asset = (await service.findAsset(uploaded.id)) as MediaAssetView;

    const publicReply = createReplyStub();
    await service.streamAsset(asset, publicReply as never);

    expect(detectFileType(publicReply.payload as Buffer)?.mimeType).toBe('image/webp');
    expect(publicReply.headers['content-type']).toBe('image/webp');
    expect(publicReply.headers['content-length']).toBe(String(asset.sizeBytes));
    expect(publicReply.headers['cache-control']).toContain('public');
    expect(publicReply.headers['x-content-type-options']).toBe('nosniff');
    expect(publicReply.headers['content-security-policy']).toContain("default-src 'none'");

    const privateAsset = { ...asset, isPublic: false };
    const privateReply = createReplyStub();
    await service.streamAsset(privateAsset, privateReply as never);

    expect(privateReply.headers['cache-control']).toBe('private, no-store');
  });

  it('reports the active provider and the configured ceilings', () => {
    expect(service.storageProviderInfo()).toEqual({ provider: 'local', isLocal: true });
    expect(service.limits).toEqual({ imageBytes: IMAGE_LIMIT, documentBytes: DOCUMENT_LIMIT });
  });

  it('surfaces a storage outage as 503 rather than as a bad request', async () => {
    const failingProvider: StorageProvider = {
      kind: 'local',
      isLocal: true,
      upload: (params: UploadParams): Promise<never> => {
        void params;
        return Promise.reject(new StorageError('local', 'ENOSPC: no space left on device'));
      },
      delete: (): Promise<boolean> => Promise.resolve(false),
      exists: (): Promise<boolean> => Promise.resolve(false),
      read: (): Promise<Buffer> => Promise.resolve(Buffer.alloc(0)),
      getUrl: (path: string): string => `/api/v1/media/files/${path}`,
    };
    const failingStorage = new StorageService(failingProvider);
    const failingService = new MediaService(prismaFake.service, failingStorage, configFake);
    const source = await png(400, 400);

    const rejection = await failingService
      .uploadImage(upload(source, 'logo.png', 'image/png'), {
        ownerUserId: OWNER,
        purpose: 'store_logo',
        isPublic: true,
      })
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(ServiceUnavailableException);
    expect((rejection as ServiceUnavailableException).getStatus()).toBe(503);
    expect((rejection as ServiceUnavailableException).message).toContain('provider: local');
    // Nothing was recorded: a failed store must not leave a row behind.
    expect(prismaFake.rows.size).toBe(0);
  });
});
