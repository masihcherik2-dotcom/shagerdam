import { ConfigService } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { MediaKind, UserRole, VendorStatus } from '@prisma/client';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { AppModule } from '../src/app.module';
import { GLOBAL_API_PREFIX } from '../src/common/constants';
import { normalizeIdentifier } from '../src/modules/auth/auth.service';
import { OtpKeys } from '../src/modules/auth/otp.service';
import { loginAttemptsKey, loginLockKey } from '../src/modules/auth/token.service';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { RedisService } from '../src/infra/redis/redis.service';
import { SMS_PROVIDER } from '../src/modules/sms/sms-provider.interface';
import type { SmsProvider } from '../src/modules/sms/sms-provider.interface';
import type { SandboxSmsProvider } from '../src/modules/sms/providers/sandbox-sms.provider';
import {
  STORAGE_PROVIDER,
  type StorageProvider,
} from '../src/modules/storage/storage-provider.interface';
import { applyGlobalPolicies, buildOpenApiDocument } from '../src/setup/app.setup';

/**
 * End-to-end verification of the Phase-4 workflow against the **real** stack:
 * PostgreSQL 16, Redis 7, the configured storage provider (local filesystem in
 * development) and the real Sharp pipeline.
 *
 * Nothing is mocked. Uploads are sent as genuine `multipart/form-data` over a
 * listening HTTP server, the OTP codes are read from the sandbox SMS provider —
 * the same way a user reads them from their phone — and every assertion about the
 * outcome is checked twice: through the API and against the database rows the API
 * wrote.
 *
 * The suite uses its own phone numbers, tags its rows for identification, and
 * removes everything it created (including the files on disk) in `afterAll`, so
 * the seeded master data stays untouched.
 */

const TEST_UA = 'shopino-vendors-e2e/1.0';

/** Phone numbers reserved for this suite (never part of the seed). */
const APPLICANT_ONE = '+989971120001';
const APPLICANT_TWO = '+989971120002';
/** Accounts created only to prove that a user without a store gets 404. */
const STORE_LESS_USER = '+989971120003';
/** Owner of the store inserted without a wallet. */
const WALLET_LESS_OWNER = '+989971120004';

/** Checksum-valid Iranian IBANs (MOD 97-10 verified). */
const IBAN_ONE = 'IR820540102680020817909002';
const IBAN_TWO = 'IR570629600000001003242001';

const SEEDED_ADMIN_EMAIL = 'admin@shopino.local';
const SEEDED_SUPPORT_EMAIL = 'support@shopino.local';

interface RegisterVendorBody {
  storeName: string;
  storeSlug: string;
  instagramHandle?: string;
  bio?: string;
  bankIban: string;
  bankAccountHolder: string;
}

interface HttpResult<T> {
  status: number;
  body: T;
  headers: Headers;
  /** Raw response bytes; used for stored files, which are not JSON. */
  bytes: Buffer;
}

describe('Phase 4 — media pipeline and vendor onboarding (live HTTP)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let storage: StorageProvider;
  let adminToken: string;
  let supportToken: string;
  let adminUserId: string;
  let supportUserId: string;
  let applicantOne: { token: string; userId: string };
  let applicantTwo: { token: string; userId: string };
  let vendorOneId: string;
  let vendorTwoId: string;
  let logoUrl: string;
  let logoAssetId: string;
  let nationalCardUrl: string;
  let bankProofUrl: string;
  let businessLicenseUrl: string;
  let foreignDocumentUrl: string;

  const API = `/${GLOBAL_API_PREFIX}`;

  /**
   * Sends a request through the real routing stack without opening a socket.
   *
   * `light-my-request` feeds the request straight into Fastify's lifecycle, so
   * multipart bodies are parsed by `@fastify/multipart` exactly as they are for a
   * client, while the suite leaves no listening sockets behind.
   */
  const request = async <T>(
    url: string,
    options: { method?: string; token?: string; body?: unknown; form?: FormData } = {},
  ): Promise<HttpResult<T>> => {
    const headers: Record<string, string> = { 'user-agent': TEST_UA };
    if (options.token !== undefined) {
      headers.authorization = `Bearer ${options.token}`;
    }

    let payload: string | Buffer | undefined;
    if (options.form !== undefined) {
      const serialized = new Response(options.form);
      payload = Buffer.from(await serialized.arrayBuffer());
      headers['content-type'] = serialized.headers.get('content-type') ?? '';
    } else if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(options.body);
    }

    const response = await app.inject({
      method: (options.method ?? 'GET') as 'GET' | 'POST' | 'PATCH',
      url: `${API}${url}`,
      headers,
      ...(payload === undefined ? {} : { payload }),
    });

    return {
      status: response.statusCode,
      body: response.body.length > 0 ? (JSON.parse(response.body) as T) : (undefined as T),
      headers: new Headers(response.headers as Record<string, string>),
      bytes: Buffer.from(response.rawPayload),
    };
  };

  /** Fetches a stored file exactly as a browser would: a plain GET on its URL. */
  const fetchFile = async (
    url: string,
    token?: string,
  ): Promise<HttpResult<undefined> & { bytes: Buffer }> => {
    const response = await app.inject({
      method: 'GET',
      url,
      headers: {
        'user-agent': TEST_UA,
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
    });

    return {
      status: response.statusCode,
      body: undefined,
      headers: new Headers(response.headers as Record<string, string>),
      bytes: Buffer.from(response.rawPayload),
    };
  };

  const uploadImage = async (
    token: string,
    body: Buffer,
    filename: string,
    purpose: string,
    declaredType = 'image/png',
  ): Promise<HttpResult<{ id: string; url: string; thumbnailUrl: string; mimeType: string; sizeBytes: number }>> => {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(body)], { type: declaredType }), filename);
    form.append('purpose', purpose);
    return request('/media/upload/image', { method: 'POST', token, form });
  };

  const uploadDocument = async (
    token: string,
    body: Buffer,
    filename: string,
    purpose: string,
    declaredType = 'application/pdf',
  ): Promise<HttpResult<{ id: string; url: string; originalName: string; isPublic: boolean }>> => {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(body)], { type: declaredType }), filename);
    form.append('purpose', purpose);
    return request('/media/upload/document', { method: 'POST', token, form });
  };

  const png = (width: number, height: number): Promise<Buffer> =>
    sharp({ create: { width, height, channels: 3, background: { r: 20, g: 60, b: 120 } } })
      .png()
      .toBuffer();

  const pdfBytes = (padding = 0): Buffer =>
    Buffer.concat([Buffer.from('%PDF-1.7\n', 'latin1'), Buffer.alloc(padding, 0x20), Buffer.from('%%EOF', 'latin1')]);

  const loginWithOtp = async (
    mobile: string,
  ): Promise<{ token: string; userId: string; role: UserRole }> => {
    const requested = await request<{ status: string; trackingId: string }>('/auth/otp/request', {
      method: 'POST',
      body: { mobile },
    });
    expect(requested.status).toBe(200);

    const sms = app.get<SmsProvider>(SMS_PROVIDER);
    const code = (sms as SandboxSmsProvider).latestOtpCode(mobile);
    expect(code).toBeDefined();

    const verified = await request<{ accessToken: string; user: { id: string; role: UserRole } }>(
      '/auth/otp/verify',
      { method: 'POST', body: { mobile, code } },
    );
    expect(verified.status).toBe(200);

    return { token: verified.body.accessToken, userId: verified.body.user.id, role: verified.body.user.role };
  };

  const loginWithPassword = async (identifier: string, password: string): Promise<{ token: string; userId: string }> => {
    const response = await request<{ accessToken: string; user: { id: string } }>('/auth/login/password', {
      method: 'POST',
      body: { identifier, password },
    });
    expect(response.status).toBe(200);
    return { token: response.body.accessToken, userId: response.body.user.id };
  };

  const registerVendor = async (
    token: string,
    overrides: Partial<RegisterVendorBody> = {},
  ): Promise<HttpResult<{ id: string; status: VendorStatus; wallet: { pendingBalance: string } | null }>> => {
    const body: RegisterVendorBody = {
      storeName: 'فروشگاه آزمون شبانه',
      storeSlug: `e2e-store-${Date.now()}`,
      instagramHandle: '@e2e.night',
      bio: 'فروشگاه ساخته‌شده در آزمون انتها به انتها',
      bankIban: IBAN_ONE,
      bankAccountHolder: 'شرکت آزمون شبانه',
      ...overrides,
    };
    return request('/vendors/register', { method: 'POST', token, body });
  };

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    applyGlobalPolicies(app, app.get(ConfigService));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    prisma = app.get(PrismaService);
    storage = app.get<StorageProvider>(STORAGE_PROVIDER);

    // Clear any rate-limit residue for this suite's numbers and the staff accounts
    // it logs in with, so a repeat run cannot fail because of a 15-minute lock.
    await resetAuthKeys();

    const adminPassword = process.env['SUPER_ADMIN_PASSWORD'];
    const staffPassword = process.env['SEED_STAFF_PASSWORD'];
    if (adminPassword === undefined || staffPassword === undefined) {
      throw new Error(
        'This suite needs SUPER_ADMIN_PASSWORD and SEED_STAFF_PASSWORD in the environment (loaded from the root .env) to sign in as the seeded staff accounts.',
      );
    }

    const admin = await loginWithPassword(SEEDED_ADMIN_EMAIL, adminPassword);
    adminToken = admin.token;
    adminUserId = admin.userId;
    const support = await loginWithPassword(SEEDED_SUPPORT_EMAIL, staffPassword);
    supportToken = support.token;
    supportUserId = support.userId;
  }, 60_000);

  afterAll(async () => {
    if (prisma !== undefined) {
      const userIds = [applicantOne?.userId, applicantTwo?.userId].filter(
        (id): id is string => id !== undefined,
      );

      // Resolved from the database rather than from the variables the tests set:
      // when a test fails early, a store may exist that the suite never recorded,
      // and leaving it behind would break the *next* run.
      const existing = await prisma.vendor.findMany({
        where: { userId: { in: userIds } },
        select: { id: true },
      });
      const vendorIds = [
        ...new Set([vendorOneId, vendorTwoId, ...existing.map((vendor) => vendor.id)].filter(
          (id): id is string => id !== undefined,
        )),
      ];

      // Files first: the rows describe them, so they must be read before the rows go.
      const assets = await prisma.mediaAsset.findMany({
        where: { ownerUserId: { in: userIds } },
        select: { path: true, thumbnailPath: true },
      });
      for (const asset of assets) {
        await storage.delete(asset.path).catch(() => false);
        if (asset.thumbnailPath !== null) {
          await storage.delete(asset.thumbnailPath).catch(() => false);
        }
      }

      await prisma.auditLog.deleteMany({
        where: {
          OR: [
            { userId: { in: userIds } },
            { entityId: { in: vendorIds } },
            { userAgent: TEST_UA },
          ],
        },
      });
      await prisma.vendorVerification.deleteMany({ where: { vendorId: { in: vendorIds } } });
      await prisma.vendorWallet.deleteMany({ where: { vendorId: { in: vendorIds } } });
      await prisma.mediaAsset.deleteMany({ where: { ownerUserId: { in: userIds } } });
      await prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });

      await resetAuthKeys();
    }

    await app?.close();
  }, 60_000);

  /**
   * Clears the rate-limit state this suite can produce.
   *
   * Challenges, cooldowns, hourly quotas and login counters live in Redis with TTLs
   * measured in minutes, so without this a repeat run inside that window would fail
   * for a reason that has nothing to do with the code under test. Every request in
   * this suite shares one client IP, so the per-IP quota is cleared as well.
   *
   * Test-only housekeeping: production never deletes rate-limit state.
   */
  async function resetAuthKeys(): Promise<void> {
    const redis = app.get(RedisService);
    const requested = await redis.client.keys('auth:otp:hourly:ip:*');
    const keys = [
      ...requested,
      ...SUITE_MOBILES.flatMap((mobile) => [
        OtpKeys.challenge(mobile),
        OtpKeys.lock(mobile),
        OtpKeys.cooldown(mobile),
        OtpKeys.hourlyByMobile(mobile),
        loginAttemptsKey(normalizeIdentifier(mobile)),
        loginLockKey(normalizeIdentifier(mobile)),
      ]),
      ...[SEEDED_ADMIN_EMAIL, SEEDED_SUPPORT_EMAIL].flatMap((identifier) => [
        loginAttemptsKey(normalizeIdentifier(identifier)),
        loginLockKey(normalizeIdentifier(identifier)),
      ]),
    ];

    if (keys.length > 0) {
      await redis.client.del(...keys);
    }
  }

  // ─── 1. Storage honesty ───────────────────────────────────────────────────

  describe('storage provider report', () => {
    it('reports the provider that is actually active, publicly and honestly', async () => {
      const response = await request<{
        provider: string;
        isLocal: boolean;
        maxImageBytes: number;
        maxDocumentBytes: number;
      }>('/media/storage-provider');

      expect(response.status).toBe(200);
      expect(response.body.provider).toBe(storage.kind);
      expect(response.body.isLocal).toBe(storage.isLocal);
      // The limits are the configured ones, not constants baked into the report.
      const config = app.get(ConfigService);
      expect(response.body.maxImageBytes).toBe(Number(config.get('MEDIA_MAX_IMAGE_BYTES')));
      expect(response.body.maxDocumentBytes).toBe(Number(config.get('MEDIA_MAX_DOCUMENT_BYTES')));
    });
  });

  // ─── 2. Upload pipeline over HTTP ─────────────────────────────────────────

  describe('upload pipeline over real multipart HTTP', () => {
    beforeAll(async () => {
      applicantOne = await loginWithOtp(APPLICANT_ONE);
      applicantTwo = await loginWithOtp(APPLICANT_TWO);
    }, 60_000);

    it('rejects an upload without a token with 401', async () => {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(await png(32, 32))], { type: 'image/png' }), 'x.png');

      const response = await request('/media/upload/image', { method: 'POST', form });

      expect(response.status).toBe(401);
    });

    it('converts a 2400x1600 PNG to WebP, caps the long edge and returns a thumbnail URL', async () => {
      const source = await png(2_400, 1_600);

      const response = await uploadImage(applicantOne.token, source, 'store-logo.png', 'store_logo');

      expect(response.status).toBe(201);
      logoUrl = response.body.url;
      logoAssetId = response.body.id;
      expect(response.body.mimeType).toBe('image/webp');
      expect(response.body.url).toMatch(/^\/api\/v1\/media\/files\/images\/store_logo\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.webp$/);
      expect(response.body.thumbnailUrl).toBe(response.body.url.replace(/\.webp$/, '_thumb.webp'));

      // The bytes on disk are WebP at the documented dimensions — read back through
      // the provider rather than trusting the response.
      const stored = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: response.body.id } });
      const optimised = await storage.read(stored.path);
      const thumbnail = await storage.read(stored.thumbnailPath ?? '');

      expect(detectMagic(optimised)).toBe('webp');
      expect(detectMagic(thumbnail)).toBe('webp');

      const optimisedMeta = await sharp(optimised).metadata();
      expect([optimisedMeta.width, optimisedMeta.height]).toEqual([1_600, 1_067]);

      const thumbnailMeta = await sharp(thumbnail).metadata();
      expect([thumbnailMeta.width, thumbnailMeta.height]).toEqual([300, 300]);

      expect(stored.kind).toBe(MediaKind.IMAGE);
      expect(stored.isPublic).toBe(true);
      expect(stored.sizeBytes).toBe(response.body.sizeBytes);
      expect(stored.storageProvider).toBe(storage.kind);
      expect(stored.ownerUserId).toBe(applicantOne.userId);
    }, 30_000);

    it('honours the declared purpose in the stored key and the media row', async () => {
      const response = await uploadImage(applicantOne.token, await png(64, 64), 'avatar.png', 'avatar');

      expect(response.status).toBe(201);
      expect(response.body.url).toContain('/images/avatar/');

      const stored = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: response.body.id } });
      expect(stored.purpose).toBe('avatar');
    }, 30_000);

    it('accepts a JPEG document and keeps it private byte-for-byte', async () => {
      const source = await sharp({ create: { width: 900, height: 600, channels: 3, background: '#eeeeee' } })
        .jpeg()
        .toBuffer();

      const response = await uploadDocument(applicantOne.token, source, 'national-card.jpg', 'kyc_national_id', 'image/jpeg');

      expect(response.status).toBe(201);
      nationalCardUrl = response.body.url;
      expect(response.body.isPublic).toBe(false);
      expect(response.body.originalName).toBe('national-card.jpg');

      const stored = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: response.body.id } });
      const bytes = await storage.read(stored.path);

      expect(stored.kind).toBe(MediaKind.DOCUMENT);
      expect(stored.isPublic).toBe(false);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(
        createHash('sha256').update(source).digest('hex'),
      );
    }, 30_000);

    it('accepts a PDF proof of bank account and a business licence', async () => {
      const bankProof = await uploadDocument(applicantOne.token, pdfBytes(512), 'bank-proof.pdf', 'kyc_bank_proof');
      expect(bankProof.status).toBe(201);
      bankProofUrl = bankProof.body.url;

      const licence = await uploadDocument(
        applicantOne.token,
        pdfBytes(256),
        'business-licence.pdf',
        'kyc_business_license',
      );
      expect(licence.status).toBe(201);
      businessLicenseUrl = licence.body.url;
    });

    it('rejects a text file sent as image/png on its magic bytes', async () => {
      const payload = Buffer.from('<script>alert(1)</script>', 'utf8');

      const response = await uploadImage(applicantOne.token, payload, 'shot.png', 'product_image');

      expect(response.status).toBe(400);
      expect(JSON.stringify(response.body)).toContain('Unsupported image format');
    });

    it('rejects a corrupted PNG that carries a valid signature', async () => {
      const corrupted = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from('this is not a chunk', 'latin1'),
      ]);

      const response = await uploadImage(applicantOne.token, corrupted, 'broken.png', 'product_image');

      expect(response.status).toBe(400);
      expect(JSON.stringify(response.body)).toContain('not a readable image or is corrupted');
    });

    it('rejects an image larger than the 5 MB image ceiling with 400', async () => {
      const oversized = Buffer.alloc(5 * 1024 * 1024 + 2_048, 0x41);
      oversized.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);

      const response = await uploadImage(applicantOne.token, oversized, 'huge.png', 'product_image');

      expect(response.status).toBe(400);
      expect(JSON.stringify(response.body)).toContain('5 MB');
    }, 30_000);

    it('rejects an image past the transport ceiling with 413 before it is buffered', async () => {
      const oversized = Buffer.alloc(11 * 1024 * 1024, 0x41);
      oversized.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);

      const response = await uploadImage(applicantOne.token, oversized, 'too-big.png', 'product_image');

      expect(response.status).toBe(413);
    }, 30_000);

    it('rejects an unknown multipart field instead of ignoring it', async () => {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(await png(48, 48))], { type: 'image/png' }), 'x.png');
      form.append('isPublic', 'true');

      const response = await request('/media/upload/image', {
        method: 'POST',
        token: applicantOne.token,
        form,
      });

      expect(response.status).toBe(400);
      expect(JSON.stringify(response.body)).toContain('Unexpected field');
    });

    it('rejects a request without the file part', async () => {
      const form = new FormData();
      form.append('purpose', 'product_image');

      const response = await request('/media/upload/image', {
        method: 'POST',
        token: applicantOne.token,
        form,
      });

      expect(response.status).toBe(400);
      expect(JSON.stringify(response.body)).toContain('multipart');
    });

    it('records the upload in the audit trail for the uploading user', async () => {
      const rows = await prisma.auditLog.findMany({
        where: { userAgent: TEST_UA, entityName: 'MediaAsset', entityId: logoAssetId },
      });

      expect(rows).toHaveLength(1);
      expect(rows[0]?.userId).toBe(applicantOne.userId);
      expect(rows[0]?.action).toBe('CREATE');
    });
  });

  // ─── 3. Vendor registration ───────────────────────────────────────────────

  describe('vendor registration', () => {
    it('refuses an IBAN with an invalid check digit', async () => {
      const response = await registerVendor(applicantOne.token, {
        bankIban: 'IR820540102680020817909003',
        storeSlug: `bad-iban-${Date.now()}`,
      });

      expect(response.status).toBe(400);
      expect(JSON.stringify(response.body)).toContain('bankIban');
    });

    it('refuses a reserved store slug', async () => {
      const response = await registerVendor(applicantOne.token, { storeSlug: 'admin' });

      expect(response.status).toBe(400);
      expect(JSON.stringify(response.body)).toContain('reserved');
    });

    it('refuses staff accounts: reviewing and being reviewed stay separate', async () => {
      const response = await registerVendor(adminToken, { storeSlug: `staff-${Date.now()}` });

      expect(response.status).toBe(403);
      expect(JSON.stringify(response.body)).toContain('Staff accounts cannot open a store');
    });

    it('registers the store as PENDING and creates its wallet in the same transaction', async () => {
      const response = await registerVendor(applicantOne.token);

      expect(response.status).toBe(201);
      const vendorId = response.body.id;
      vendorOneId = vendorId;
      expect(response.body.status).toBe(VendorStatus.PENDING);

      const vendor = await prisma.vendor.findUniqueOrThrow({
        where: { id: vendorId },
        include: { wallet: true },
      });
      expect(vendor.bankIban).toBe(IBAN_ONE);
      expect(vendor.instagramHandle).toBe('e2e.night');
      expect(vendor.wallet).not.toBeNull();
      expect(vendor.wallet?.pendingBalance.toFixed(2)).toBe('0.00');
      expect(vendor.wallet?.withdrawableBalance.toFixed(2)).toBe('0.00');
      expect(vendor.wallet?.totalEarnedBalance.toFixed(2)).toBe('0.00');

      // The owner is still a customer: a self-declared vendor cannot publish.
      const owner = await prisma.user.findUniqueOrThrow({ where: { id: applicantOne.userId } });
      expect(owner.role).toBe(UserRole.CUSTOMER);
    });

    it('refuses a second store on the same account with 409', async () => {
      const response = await registerVendor(applicantOne.token, { storeSlug: `second-${Date.now()}` });

      expect(response.status).toBe(409);
    });

    it('refuses a store slug that is already taken with 409', async () => {
      const existing = await prisma.vendor.findUniqueOrThrow({ where: { id: vendorOneId } });
      const response = await registerVendor(applicantTwo.token, { storeSlug: existing.storeSlug });

      expect(response.status).toBe(409);
      expect(JSON.stringify(response.body)).toContain('already taken');
    });

    it('registers the second applicant for the cross-tenant checks', async () => {
      const response = await registerVendor(applicantTwo.token, {
        storeSlug: `e2e-other-${Date.now()}`,
        bankIban: IBAN_TWO,
      });

      expect(response.status).toBe(201);
      vendorTwoId = response.body.id;
    });
  });

  // ─── 4. KYC submission ────────────────────────────────────────────────────

  describe('KYC submission', () => {
    it("refuses a document that belongs to another account with 403", async () => {
      const foreign = await uploadDocument(applicantTwo.token, pdfBytes(128), 'other-card.pdf', 'kyc_national_id');
      expect(foreign.status).toBe(201);
      foreignDocumentUrl = foreign.body.url;

      const response = await request('/vendors/verification/documents', {
        method: 'POST',
        token: applicantOne.token,
        body: { nationalIdCardUrl: foreignDocumentUrl },
      });

      expect(response.status).toBe(403);
    });

    it('refuses an arbitrary external URL: only documents the API stored are accepted', async () => {
      const response = await request('/vendors/verification/documents', {
        method: 'POST',
        token: applicantOne.token,
        body: { nationalIdCardUrl: 'https://evil.example/national-card.png' },
      });

      expect(response.status).toBe(400);
      expect(JSON.stringify(response.body)).toContain('/media/upload/document');
    });

    it('accepts the submission and keeps the store PENDING', async () => {
      const response = await request<{ status: VendorStatus; verification: { id: string } | null }>(
        '/vendors/verification/documents',
        {
          method: 'POST',
          token: applicantOne.token,
          body: {
            nationalIdCardUrl: nationalCardUrl,
            businessLicenseUrl,
            bankAccountProofUrl: bankProofUrl,
          },
        },
      );

      expect(response.status).toBe(200);
      expect(response.body.status).toBe(VendorStatus.PENDING);

      const verification = await prisma.vendorVerification.findFirstOrThrow({
        where: { vendorId: vendorOneId },
        orderBy: { createdAt: 'desc' },
      });
      expect(verification.nationalCardDocUrl).toBe(nationalCardUrl);
      expect(verification.businessDocUrl).toBe(businessLicenseUrl);
      expect(verification.bankAccountProofUrl).toBe(bankProofUrl);
      expect(verification.reviewedAt).toBeNull();
      expect(verification.rejectionReason).toBeNull();
    });

    it('requires the national ID card', async () => {
      const response = await request('/vendors/verification/documents', {
        method: 'POST',
        token: applicantOne.token,
        body: {},
      });

      expect(response.status).toBe(400);
      expect(JSON.stringify(response.body)).toContain('nationalIdCardUrl');
    });

    it('returns the store profile with wallet and verification status, and blocks staff', async () => {
      const profile = await request<{
        storeSlug: string;
        wallet: { pendingBalance: string } | null;
        verification: { id: string } | null;
        mediaAssets: unknown[];
      }>('/vendors/me', { token: applicantOne.token });

      expect(profile.status).toBe(200);
      expect(profile.body.wallet?.pendingBalance).toBe('0.00');
      expect(profile.body.verification).not.toBeNull();
      expect(profile.body.mediaAssets.length).toBeGreaterThan(0);

      expect((await request('/vendors/me')).status).toBe(401);
      expect((await request('/vendors/me', { token: supportToken })).status).toBe(403);
    });
  });

  // ─── 5. Admin review ──────────────────────────────────────────────────────

  describe('admin listing, detail and decision', () => {
    it('blocks a customer from the admin routes', async () => {
      expect((await request('/admin/vendors', { token: applicantOne.token })).status).toBe(403);
      expect((await request(`/admin/vendors/${vendorOneId}`, { token: applicantOne.token })).status).toBe(403);
      expect(
        (
          await request(`/admin/vendors/${vendorOneId}/verify`, {
            method: 'POST',
            token: applicantOne.token,
            body: { status: 'APPROVED', rejectionReason: null },
          })
        ).status,
      ).toBe(403);
    });

    it('lists stores for staff with status, search and pagination', async () => {
      const pending = await request<{ items: Array<{ storeSlug: string }>; total: number; page: number }>(
        '/admin/vendors?status=PENDING&page=1&pageSize=50',
        { token: supportToken },
      );

      expect(pending.status).toBe(200);
      expect(pending.body.items.some((item) => item.storeSlug.startsWith('e2e-store-'))).toBe(true);

      const vendor = await prisma.vendor.findUniqueOrThrow({ where: { id: vendorOneId } });
      const search = await request<{ items: Array<{ id: string }>; total: number; totalPages: number }>(
        `/admin/vendors?search=${encodeURIComponent(vendor.storeSlug)}&pageSize=10`,
        { token: supportToken },
      );

      expect(search.status).toBe(200);
      expect(search.body.total).toBe(1);
      expect(search.body.items[0]?.id).toBe(vendorOneId);
      expect(search.body.totalPages).toBe(1);
    });

    it('rejects a malformed status filter and an out-of-range page size', async () => {
      expect((await request('/admin/vendors?status=NOT_A_STATUS', { token: adminToken })).status).toBe(400);
      expect((await request('/admin/vendors?pageSize=500', { token: adminToken })).status).toBe(400);
    });

    it('returns the full detail: owner, documents, media and audit history', async () => {
      const response = await request<{
        owner: { id: string; role: UserRole };
        bankIban: string;
        verifications: Array<{ id: string; reviewedAt: string | null }>;
        mediaAssets: Array<{ id: string; url: string }>;
        auditTrail: Array<{ action: string; entityName: string }>;
      }>(`/admin/vendors/${vendorOneId}`, { token: adminToken });

      expect(response.status).toBe(200);
      expect(response.body.owner.id).toBe(applicantOne.userId);
      expect(response.body.bankIban).toBe(IBAN_ONE);
      expect(response.body.verifications).toHaveLength(1);
      expect(response.body.verifications[0]?.reviewedAt).toBeNull();
      expect(response.body.mediaAssets.length).toBeGreaterThanOrEqual(4);
      expect(response.body.auditTrail.some((entry) => entry.entityName === 'Vendor')).toBe(true);
    });

    it('answers 404 for an unknown store id and 400 for a non-uuid id', async () => {
      const unknown = await request('/admin/vendors/6f9619ff-8b86-d011-b42d-00cf4fc964ff', { token: adminToken });
      expect(unknown.status).toBe(404);

      const malformed = await request('/admin/vendors/not-a-uuid', { token: adminToken });
      expect(malformed.status).toBe(400);
    });

    it('lets SUPPORT read but not decide', async () => {
      expect((await request(`/admin/vendors/${vendorOneId}`, { token: supportToken })).status).toBe(200);

      const decision = await request(`/admin/vendors/${vendorOneId}/verify`, {
        method: 'POST',
        token: supportToken,
        body: { status: 'APPROVED', rejectionReason: null },
      });
      expect(decision.status).toBe(403);
    });

    it('requires a rejection reason and forbids one when approving', async () => {
      const withoutReason = await request(`/admin/vendors/${vendorOneId}/verify`, {
        method: 'POST',
        token: adminToken,
        body: { status: 'REJECTED', rejectionReason: null },
      });
      expect(withoutReason.status).toBe(400);
      expect(JSON.stringify(withoutReason.body)).toContain('rejectionReason');

      const shortReason = await request(`/admin/vendors/${vendorOneId}/verify`, {
        method: 'POST',
        token: adminToken,
        body: { status: 'REJECTED', rejectionReason: 'کوتاه' },
      });
      expect(shortReason.status).toBe(400);

      const reasonOnApproval = await request(`/admin/vendors/${vendorOneId}/verify`, {
        method: 'POST',
        token: adminToken,
        body: { status: 'APPROVED', rejectionReason: 'نباید پذیرفته شود' },
      });
      expect(reasonOnApproval.status).toBe(400);
      expect(JSON.stringify(reasonOnApproval.body)).toContain('rejectionReason must be null when approving');
    });

    it('approves the store: status, reviewer stamp, role elevation and audit row commit together', async () => {
      const response = await request<{
        vendor: { id: string; status: VendorStatus; verifiedAt: string | null };
        previousStatus: VendorStatus;
        walletCreated: boolean;
        roleUpdated: boolean;
        auditLogId: string;
      }>(`/admin/vendors/${vendorOneId}/verify`, {
        method: 'POST',
        token: adminToken,
        body: { status: 'APPROVED', rejectionReason: null, commissionRateOverride: 7.5 },
      });

      expect(response.status).toBe(200);
      expect(response.body.previousStatus).toBe(VendorStatus.PENDING);
      expect(response.body.vendor.status).toBe(VendorStatus.APPROVED);
      expect(response.body.vendor.verifiedAt).not.toBeNull();
      // The wallet already existed from registration, so approval must not create another.
      expect(response.body.walletCreated).toBe(false);
      expect(response.body.roleUpdated).toBe(true);

      const vendor = await prisma.vendor.findUniqueOrThrow({
        where: { id: vendorOneId },
        include: { wallet: true, verifications: { orderBy: { createdAt: 'desc' }, take: 1 } },
      });
      expect(vendor.status).toBe(VendorStatus.APPROVED);
      expect(vendor.verifiedAt).not.toBeNull();
      expect(vendor.commissionRateOverride?.toFixed(2)).toBe('7.50');
      expect(vendor.wallet).not.toBeNull();
      expect(vendor.verifications[0]?.reviewedByUserId).toBe(adminUserId);
      expect(vendor.verifications[0]?.reviewedAt).not.toBeNull();
      expect(vendor.verifications[0]?.rejectionReason).toBeNull();

      const owner = await prisma.user.findUniqueOrThrow({ where: { id: applicantOne.userId } });
      expect(owner.role).toBe(UserRole.VENDOR);

      const audit = await prisma.auditLog.findUniqueOrThrow({ where: { id: response.body.auditLogId } });
      expect(audit.action).toBe('STATUS_CHANGE');
      expect(audit.entityName).toBe('Vendor');
      expect(audit.entityId).toBe(vendorOneId);
      expect(audit.userId).toBe(adminUserId);
      expect(audit.oldValue).toMatchObject({ status: 'PENDING' });
      expect(audit.newValue).toMatchObject({ status: 'APPROVED', roleUpdated: true, walletCreated: false });

      // Exactly one row for this decision: the route opts out of the interceptor so
      // the row written inside the transaction is the only one.
      const decisionRows = await prisma.auditLog.findMany({
        where: { entityName: 'Vendor', entityId: vendorOneId, action: 'STATUS_CHANGE' },
      });
      expect(decisionRows).toHaveLength(1);
    });

    it('keeps a single wallet when a store somehow has none before approval', async () => {
      // A store row without a wallet can only come from a legacy/manual write.
      // Approving it must still end with exactly one wallet — that is the invariant.
      const orphanUser = await prisma.user.create({
        data: { mobile: WALLET_LESS_OWNER, fullName: 'فروشندهٔ بدون کیف پول', role: UserRole.CUSTOMER },
      });
      const orphanVendor = await prisma.vendor.create({
        data: {
          userId: orphanUser.id,
          storeName: 'فروشگاه بدون کیف پول',
          storeSlug: `e2e-orphan-${Date.now()}`,
          bankIban: IBAN_TWO,
          bankAccountHolder: 'فروشگاه بدون کیف پول',
          status: VendorStatus.PENDING,
        },
      });
      await prisma.vendorVerification.create({
        data: { vendorId: orphanVendor.id, nationalCardDocUrl: nationalCardUrl },
      });

      const response = await request<{ walletCreated: boolean; roleUpdated: boolean }>(
        `/admin/vendors/${orphanVendor.id}/verify`,
        { method: 'POST', token: adminToken, body: { status: 'APPROVED', rejectionReason: null } },
      );

      expect(response.status).toBe(200);
      expect(response.body.walletCreated).toBe(true);
      expect(response.body.roleUpdated).toBe(true);

      const wallets = await prisma.vendorWallet.findMany({ where: { vendorId: orphanVendor.id } });
      expect(wallets).toHaveLength(1);
      expect(wallets[0]?.pendingBalance.toFixed(2)).toBe('0.00');

      const owner = await prisma.user.findUniqueOrThrow({ where: { id: orphanUser.id } });
      expect(owner.role).toBe(UserRole.VENDOR);

      await prisma.auditLog.deleteMany({ where: { entityId: orphanVendor.id } });
      await prisma.vendorVerification.deleteMany({ where: { vendorId: orphanVendor.id } });
      await prisma.vendorWallet.deleteMany({ where: { vendorId: orphanVendor.id } });
      await prisma.vendor.delete({ where: { id: orphanVendor.id } });
      await prisma.user.delete({ where: { id: orphanUser.id } });
    });

    it('refuses to approve a store that submitted no documents', async () => {
      const response = await request(`/admin/vendors/${vendorTwoId}/verify`, {
        method: 'POST',
        token: adminToken,
        body: { status: 'APPROVED', rejectionReason: null },
      });

      expect(response.status).toBe(409);
      expect(JSON.stringify(response.body)).toContain('nothing to approve');
    });

    it('rejects a store with a reason, keeps the reason visible, and allows a corrected resubmission', async () => {
      const submitted = await request('/vendors/verification/documents', {
        method: 'POST',
        token: applicantTwo.token,
        body: { nationalIdCardUrl: foreignDocumentUrl },
      });
      expect(submitted.status).toBe(200);

      const reason = 'تصویر کارت ملی خوانا نیست؛ لطفاً عکس واضح‌تری ارسال کنید.';
      const rejected = await request<{ vendor: { status: VendorStatus; verifiedAt: string | null }; roleUpdated: boolean }>(
        `/admin/vendors/${vendorTwoId}/verify`,
        { method: 'POST', token: adminToken, body: { status: 'REJECTED', rejectionReason: reason } },
      );

      expect(rejected.status).toBe(200);
      expect(rejected.body.vendor.status).toBe(VendorStatus.REJECTED);
      expect(rejected.body.vendor.verifiedAt).toBeNull();
      expect(rejected.body.roleUpdated).toBe(false);

      // The vendor sees the reason — that is the point of storing it.
      const profile = await request<{ status: VendorStatus; verification: { rejectionReason: string | null } | null }>(
        '/vendors/me',
        { token: applicantTwo.token },
      );
      expect(profile.body.status).toBe(VendorStatus.REJECTED);
      expect(profile.body.verification?.rejectionReason).toBe(reason);

      // The owner keeps the CUSTOMER role until an approval.
      const owner = await prisma.user.findUniqueOrThrow({ where: { id: applicantTwo.userId } });
      expect(owner.role).toBe(UserRole.CUSTOMER);

      // Re-reviewing the same submission is refused instead of overwriting history.
      const again = await request(`/admin/vendors/${vendorTwoId}/verify`, {
        method: 'POST',
        token: adminToken,
        body: { status: 'REJECTED', rejectionReason: 'دلیل دیگری برای همان مدارک بررسی‌شده.' },
      });
      expect(again.status).toBe(409);
      expect(JSON.stringify(again.body)).toContain('already been reviewed');

      // A corrected submission reopens the review and clears the old reason.
      const corrected = await uploadDocument(
        applicantTwo.token,
        await png(600, 400),
        'national-card-2.png',
        'kyc_national_id',
        'image/png',
      );
      expect(corrected.status).toBe(201);

      const resubmitted = await request<{ status: VendorStatus; verification: { rejectionReason: string | null } }>(
        '/vendors/verification/documents',
        {
          method: 'POST',
          token: applicantTwo.token,
          body: { nationalIdCardUrl: corrected.body.url },
        },
      );

      expect(resubmitted.status).toBe(200);
      expect(resubmitted.body.status).toBe(VendorStatus.PENDING);
      expect(resubmitted.body.verification?.rejectionReason).toBeNull();

      const history = await prisma.vendorVerification.findMany({ where: { vendorId: vendorTwoId } });
      expect(history).toHaveLength(2);
    });
  });

  // ─── 6. Store profile management ──────────────────────────────────────────

  describe('store profile updates', () => {
    it("refuses another store's logo on the profile with 403", async () => {
      const otherLogo = await uploadImage(applicantTwo.token, await png(128, 128), 'other-logo.png', 'store_logo');
      expect(otherLogo.status).toBe(201);

      const response = await request('/vendors/me', {
        method: 'PATCH',
        token: applicantOne.token,
        body: { logoUrl: otherLogo.body.url },
      });

      expect(response.status).toBe(403);
    });

    it('updates storeName, bio, instagramHandle and logoUrl', async () => {
      const response = await request<{
        vendor: { storeName: string; bio: string | null; instagramHandle: string | null; logoUrl: string | null };
        warnings: string[];
      }>('/vendors/me', {
        method: 'PATCH',
        token: applicantOne.token,
        body: {
          storeName: 'فروشگاه آزمون شبانه (به‌روزشده)',
          bio: 'ارسال سریع در تهران',
          instagramHandle: 'e2e.updated',
          logoUrl,
        },
      });

      expect(response.status).toBe(200);
      expect(response.body.warnings).toEqual([]);
      expect(response.body.vendor.storeName).toBe('فروشگاه آزمون شبانه (به‌روزشده)');
      expect(response.body.vendor.bio).toBe('ارسال سریع در تهران');
      expect(response.body.vendor.instagramHandle).toBe('e2e.updated');
      expect(response.body.vendor.logoUrl).toBe(logoUrl);

      const vendor = await prisma.vendor.findUniqueOrThrow({ where: { id: vendorOneId } });
      expect(vendor.logoUrl).toBe(logoUrl);
    });

    it('refuses an empty patch rather than reporting a silent no-op', async () => {
      const response = await request('/vendors/me', { method: 'PATCH', token: applicantOne.token, body: {} });

      expect(response.status).toBe(400);
      expect(JSON.stringify(response.body)).toContain('No updatable field');
    });

    it('changes the IBAN only with a fresh proof, warns the vendor, and returns the store to review', async () => {
      const proof = await uploadDocument(applicantOne.token, pdfBytes(64), 'new-bank-proof.pdf', 'kyc_bank_proof');
      expect(proof.status).toBe(201);

      const withoutProof = await request('/vendors/me', {
        method: 'PATCH',
        token: applicantOne.token,
        body: { bankIban: IBAN_TWO },
      });
      expect(withoutProof.status).toBe(400);
      expect(JSON.stringify(withoutProof.body)).toContain('proof of account ownership');

      const changed = await request<{ vendor: { bankIban: string; status: VendorStatus }; warnings: string[] }>(
        '/vendors/me',
        {
          method: 'PATCH',
          token: applicantOne.token,
          body: { bankIban: IBAN_TWO, bankAccountProofUrl: proof.body.url },
        },
      );

      expect(changed.status).toBe(200);
      expect(changed.body.vendor.bankIban).toBe(IBAN_TWO);
      expect(changed.body.vendor.status).toBe(VendorStatus.PENDING);
      expect(changed.body.warnings.length).toBeGreaterThan(0);
      expect(changed.body.warnings[0]).toContain('PENDING');

      const vendor = await prisma.vendor.findUniqueOrThrow({ where: { id: vendorOneId } });
      expect(vendor.status).toBe(VendorStatus.PENDING);
      expect(vendor.verifiedAt).toBeNull();
      expect(vendor.commissionRateOverride?.toFixed(2)).toBe('7.50');

      // A fresh verification row carries the new proof for the reviewer.
      const latest = await prisma.vendorVerification.findFirstOrThrow({
        where: { vendorId: vendorOneId },
        orderBy: { createdAt: 'desc' },
      });
      expect(latest.bankAccountProofUrl).toBe(proof.body.url);
      expect(latest.nationalCardDocUrl).toBe(nationalCardUrl);
      expect(latest.reviewedAt).toBeNull();
    });

    it('returns 404 for a user without a store', async () => {
      const stranger = await loginWithOtp(STORE_LESS_USER);

      expect((await request('/vendors/me', { token: stranger.token })).status).toBe(404);
      expect(
        (await request('/vendors/me', { method: 'PATCH', token: stranger.token, body: { bio: 'سلام' } })).status,
      ).toBe(404);

      await prisma.auditLog.deleteMany({ where: { userId: stranger.userId } });
      await prisma.user.delete({ where: { id: stranger.userId } });
    });
  });

  // ─── 7. Serving files and privacy ─────────────────────────────────────────

  describe('file serving and privacy', () => {
    it('serves a public image anonymously with hardening headers', async () => {
      const response = await fetchFile(logoUrl);

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('image/webp');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
      expect(response.headers.get('cache-control')).toContain('public');
      expect(response.bytes.byteLength).toBeGreaterThan(0);
    });

    it('serves the 300x300 thumbnail through its own key', async () => {
      const asset = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: logoAssetId } });
      const response = await fetchFile(asset.thumbnailUrl ?? '');

      expect(response.status).toBe(200);
      const metadata = await sharp(response.bytes).metadata();
      expect([metadata.width, metadata.height]).toEqual([300, 300]);
    });

    it('returns 404 for an unknown file path instead of touching the filesystem freely', async () => {
      const response = await fetchFile('/api/v1/media/files/images/store_logo/2026/09/not-a-real-file.webp');

      expect(response.status).toBe(404);
    });

    it('never exposes a private document through the public file route', async () => {
      const asset = await prisma.mediaAsset.findFirstOrThrow({
        where: { url: nationalCardUrl },
        select: { path: true },
      });

      const response = await fetchFile(`/api/v1/media/files/${asset.path}`);

      expect(response.status).toBe(404);
    });

    it('streams a private document to its owner and to staff, and refuses another vendor', async () => {
      const owner = await fetchFile(nationalCardUrl, applicantOne.token);
      expect(owner.status).toBe(200);
      expect(owner.headers.get('content-disposition')).toContain('attachment');
      expect(owner.headers.get('cache-control')).toContain('private');

      const staff = await fetchFile(nationalCardUrl, supportToken);
      expect(staff.status).toBe(200);

      const stranger = await fetchFile(nationalCardUrl, applicantTwo.token);
      expect(stranger.status).toBe(403);

      const anonymous = await fetchFile(nationalCardUrl);
      expect(anonymous.status).toBe(401);
    });

    it('records the document download in the audit trail', async () => {
      const asset = await prisma.mediaAsset.findFirstOrThrow({
        where: { url: nationalCardUrl },
        select: { id: true },
      });
      const rows = await prisma.auditLog.findMany({
        where: { entityName: 'MediaAsset', entityId: asset.id, action: 'STATUS_CHANGE' },
        orderBy: { createdAt: 'desc' },
      });

      // Reading somebody's identity document is an event for both readers: the
      // owner's own download and the support agent's review are both in the trail.
      expect(rows.length).toBeGreaterThanOrEqual(2);
      expect(rows.map((row) => row.userId)).toEqual(
        expect.arrayContaining([applicantOne.userId, supportUserId]),
      );
      expect(rows.every((row) => row.action === 'STATUS_CHANGE')).toBe(true);
    });

    it('never leaks the internal storage key through asset metadata', async () => {
      const response = await request<Record<string, unknown>>(`/media/assets/${logoAssetId}`, {
        token: applicantOne.token,
      });

      expect(response.status).toBe(200);
      expect(response.body['path']).toBeUndefined();
      expect(response.body['thumbnailPath']).toBeUndefined();
      expect(Object.keys(response.body)).toContain('url');
    });

    it('hides a private asset from an unrelated authenticated user', async () => {
      const asset = await prisma.mediaAsset.findFirstOrThrow({
        where: { url: nationalCardUrl },
        select: { id: true },
      });

      const stranger = await request(`/media/assets/${asset.id}`, { token: applicantTwo.token });
      expect(stranger.status).toBe(403);

      const owner = await request(`/media/assets/${asset.id}`, { token: applicantOne.token });
      expect(owner.status).toBe(200);
    });
  });

  // ─── 8. OpenAPI contract ──────────────────────────────────────────────────

  describe('OpenAPI contract', () => {
    it('documents every Phase-4 route with its security requirement and tags', () => {
      // Generated in-process: the Swagger UI route needs `@fastify/static`, which
      // is deliberately not loaded by the test bootstrap. The document is the same
      // object the UI would serve.
      const document = buildOpenApiDocument(app) as unknown as {
        paths: Record<string, Record<string, { tags?: string[]; security?: Array<Record<string, unknown>>; requestBody?: unknown; responses?: Record<string, unknown> }>>;
        tags?: Array<{ name: string }>;
      };

      for (const path of [
        '/api/v1/media/upload/image',
        '/api/v1/media/upload/document',
        '/api/v1/media/storage-provider',
        '/api/v1/media/assets/{id}',
        '/api/v1/media/files/{path}',
        '/api/v1/media/documents/{id}/download',
        '/api/v1/vendors/register',
        '/api/v1/vendors/me',
        '/api/v1/vendors/verification/documents',
        '/api/v1/admin/vendors',
        '/api/v1/admin/vendors/{id}',
        '/api/v1/admin/vendors/{id}/verify',
      ]) {
        expect(Object.keys(document.paths)).toContain(path);
      }

      const upload = document.paths['/api/v1/media/upload/image']?.['post'];
      expect(upload?.security).toEqual([{ 'access-token': [] }]);
      const requestBody = JSON.stringify(upload?.requestBody);
      expect(requestBody).toContain('multipart/form-data');
      expect(requestBody).toContain('binary');
      expect(requestBody).toContain('purpose');

      const decision = document.paths['/api/v1/admin/vendors/{id}/verify']?.['post'];
      expect(decision?.tags).toContain('admin-vendors');
      expect(decision?.responses).toHaveProperty('200');
      expect(decision?.responses).toHaveProperty('409');

      const publicFiles = document.paths['/api/v1/media/files/{path}']?.['get'];
      expect(publicFiles?.security ?? []).toEqual([]);

      expect((document.tags ?? []).map((tag) => tag.name)).toEqual(
        expect.arrayContaining(['media', 'vendors', 'admin-vendors']),
      );
    });
  });
});

/** Magic-byte probe used to verify what is actually stored, independently of the API. */
function detectMagic(buffer: Buffer): 'webp' | 'png' | 'jpeg' | 'pdf' | 'unknown' {
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'webp';
  }
  if (buffer.length >= 8 && buffer.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') {
    return 'png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'jpeg';
  }
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString('latin1') === '%PDF-') {
    return 'pdf';
  }
  return 'unknown';
}

const SUITE_MOBILES = [APPLICANT_ONE, APPLICANT_TWO, STORE_LESS_USER, WALLET_LESS_OWNER];


