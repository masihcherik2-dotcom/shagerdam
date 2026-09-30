import { AuditAction, UserRole } from '@prisma/client';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import type { Reflector } from '@nestjs/core';
import { AUDIT_METADATA_KEY, SKIP_AUDIT_KEY, type AuditableOptions } from './audit.decorator';
import { AUDIT_CONTEXT_PROPERTY } from './audit-context';
import { AuditInterceptor, deriveAction, deriveEntityName } from './audit.interceptor';
import type { AuditLogService, AuditEntryInput } from './audit-log.service';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';

/**
 * Direct coverage of the audit interceptor, which the mission defines as the
 * component that "automatically records non-GET mutating actions (CREATE,
 * UPDATE, DELETE, STATUS_CHANGE)".
 *
 * The end-to-end suite proves the interceptor works on a real route; this spec
 * pins down the rules that no single route can exercise on its own: the full
 * HTTP-method → action mapping, the `@Auditable` override that produces
 * `STATUS_CHANGE` (used by domain transitions such as a sub-order moving to
 * SHIPPED, or a settlement being processed), the skip rules, EntityId
 * resolution, redaction of the request body, and the guarantee that a request
 * which fails writes nothing.
 */

interface FakeRequest {
  method: string;
  url: string;
  body?: unknown;
  params?: Record<string, unknown>;
  user?: AuthenticatedUser;
  ip?: string;
  headers?: Record<string, string | string[] | undefined>;
  [AUDIT_CONTEXT_PROPERTY]?: unknown;
}

/**
 * A function whose `name` matches a real controller method. `Function#name` is
 * read-only, so it is set through `defineProperty`; the interceptor only ever
 * reads it as a last-resort fallback for the entity name.
 */
function namedHandler(name: string): () => void {
  const handler = (): void => undefined;
  Object.defineProperty(handler, 'name', { value: name, configurable: true });
  return handler;
}

const handlerContext = (request: FakeRequest, handlerName = 'handler'): ExecutionContext =>
  ({
    getType: () => 'http',
    getHandler: () => namedHandler(handlerName),
    getClass: () => class TestController {},
    switchToHttp: () => ({ getRequest: () => request }),
  }) as unknown as ExecutionContext;

const reflectorWith = (metadata: Record<string, unknown>): Reflector =>
  ({ getAllAndOverride: (key: string) => metadata[key] }) as unknown as Reflector;

const handlerReturning = (value: unknown): CallHandler => ({ handle: () => of(value) });
const handlerFailing = (error: Error): CallHandler => ({ handle: () => throwError(() => error) });

const actor: AuthenticatedUser = {
  id: '11111111-1111-1111-1111-111111111111',
  mobile: '+989120000001',
  role: UserRole.SUPER_ADMIN,
  sessionId: '22222222-2222-2222-2222-222222222222',
};

/** Captures what the interceptor tried to persist. */
function capturingAuditLog(): { service: AuditLogService; entries: AuditEntryInput[] } {
  const entries: AuditEntryInput[] = [];
  const service = {
    record: (entry: AuditEntryInput): Promise<string | null> => {
      entries.push(entry);
      return Promise.resolve('audit-id');
    },
  } as unknown as AuditLogService;
  return { service, entries };
}

const run = async (
  interceptor: AuditInterceptor,
  context: ExecutionContext,
  next: CallHandler,
): Promise<unknown> => {
  let emitted: unknown;
  await new Promise<void>((resolve, reject) => {
    interceptor.intercept(context, next).subscribe({
      next: (value) => {
        emitted = value;
      },
      error: reject,
      complete: resolve,
    });
  });
  return emitted;
};

describe('deriveAction (HTTP method → audit vocabulary)', () => {
  it('maps the mutating methods the mission names', () => {
    expect(deriveAction('POST')).toBe(AuditAction.CREATE);
    expect(deriveAction('PATCH')).toBe(AuditAction.UPDATE);
    expect(deriveAction('PUT')).toBe(AuditAction.UPDATE);
    expect(deriveAction('DELETE')).toBe(AuditAction.DELETE);
  });

  it('is case-insensitive', () => {
    expect(deriveAction('post')).toBe(AuditAction.CREATE);
    expect(deriveAction('Delete')).toBe(AuditAction.DELETE);
  });

  it('never invents an unsupported action', () => {
    // Anything outside the vocabulary falls back to UPDATE rather than throwing:
    // an unknown verb must still leave a trail (e.g. a future QUERY-ish verb).
    expect(deriveAction('OPTIONS')).toBe(AuditAction.UPDATE);
    expect(Object.values(AuditAction)).toContain(deriveAction('POST'));
  });
});

describe('deriveEntityName', () => {
  it('uses the last static segment of the path', () => {
    expect(deriveEntityName(handlerContext({ method: 'POST', url: '/api/v1/auth/profile' }), '/api/v1/auth/profile')).toBe(
      'profile',
    );
    expect(deriveEntityName(handlerContext({ method: 'POST', url: '/api/v1/vendors' }), '/api/v1/vendors')).toBe(
      'vendors',
    );
  });

  it('ignores the query string', () => {
    expect(
      deriveEntityName(handlerContext({ method: 'PATCH', url: '/api/v1/products?page=2' }), '/api/v1/products?page=2'),
    ).toBe('products');
  });

  it('skips a trailing UUID so a nested resource names its collection', () => {
    const url = '/api/v1/admin/users/6f9619ff-8b86-d011-b42d-00cf4fc964ff';
    expect(deriveEntityName(handlerContext({ method: 'PATCH', url }), url)).toBe('users');
  });
});

describe('AuditInterceptor', () => {
  it('ignores read-only requests entirely', async () => {
    const { service, entries } = capturingAuditLog();
    const interceptor = new AuditInterceptor(reflectorWith({}), service);

    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      await run(interceptor, handlerContext({ method, url: '/api/v1/health' }), handlerReturning({ status: 'ok' }));
    }

    expect(entries).toHaveLength(0);
  });

  it('records CREATE for a POST from the authenticated actor, with IP and user agent', async () => {
    const { service, entries } = capturingAuditLog();
    const interceptor = new AuditInterceptor(reflectorWith({}), service);
    const request: FakeRequest = {
      method: 'POST',
      url: '/api/v1/vendors',
      body: { storeName: 'فروشگاه نمونه' },
      user: actor,
      headers: { 'user-agent': 'jest-unit', 'x-forwarded-for': '203.0.113.10, 10.0.0.1' },
    };

    await run(interceptor, handlerContext(request), handlerReturning({ id: 'vendor-id', storeName: 'فروشگاه نمونه' }));

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      userId: actor.id,
      action: AuditAction.CREATE,
      entityName: 'vendors',
      entityId: 'vendor-id',
      ipAddress: '203.0.113.10',
      userAgent: 'jest-unit',
    });
  });

  it('records UPDATE for a PATCH and keeps the before/after snapshot from the handler', async () => {
    const { service, entries } = capturingAuditLog();
    const interceptor = new AuditInterceptor(reflectorWith({}), service);
    const request: FakeRequest = {
      method: 'PATCH',
      url: '/api/v1/auth/profile',
      body: { fullName: 'سارا محمدی', password: 'must-not-be-stored' },
      user: actor,
      ip: '127.0.0.1',
    };
    // What a handler publishes through `setAuditSnapshot()` after loading the
    // previous state — the reason `oldValue` is real data rather than a guess.
    request[AUDIT_CONTEXT_PROPERTY] = {
      entityId: actor.id,
      oldValue: { fullName: 'نام قبلی' },
      newValue: { fullName: 'سارا محمدی' },
    };

    await run(interceptor, handlerContext(request), handlerReturning({ id: actor.id, updated: true }));

    expect(entries).toHaveLength(1);
    expect(entries[0]?.action).toBe(AuditAction.UPDATE);
    expect(entries[0]?.entityId).toBe(actor.id);
    expect(entries[0]?.oldValue).toEqual({ fullName: 'نام قبلی' });

    const newValue = entries[0]?.newValue as { request: Record<string, unknown>; result: unknown };
    expect(newValue.request.fullName).toBe('سارا محمدی');
    expect(newValue.request.password).toBe('[REDACTED]');
    expect(newValue.result).toEqual({ fullName: 'سارا محمدی' });
    expect(JSON.stringify(entries[0])).not.toContain('must-not-be-stored');
  });

  it('records DELETE for a DELETE request', async () => {
    const { service, entries } = capturingAuditLog();
    const interceptor = new AuditInterceptor(reflectorWith({}), service);
    const request: FakeRequest = {
      method: 'DELETE',
      url: '/api/v1/products',
      params: { id: 'product-id' },
      user: actor,
    };

    await run(interceptor, handlerContext(request), handlerReturning({ deleted: true }));

    expect(entries[0]?.action).toBe(AuditAction.DELETE);
    expect(entries[0]?.entityId).toBe('product-id');
  });

  it('records STATUS_CHANGE when a handler declares it, and lets it override the method mapping', async () => {
    const { service, entries } = capturingAuditLog();
    const metadata: AuditableOptions = { action: AuditAction.STATUS_CHANGE, entityName: 'SubOrder' };
    const interceptor = new AuditInterceptor(reflectorWith({ [AUDIT_METADATA_KEY]: metadata }), service);
    const request: FakeRequest = {
      method: 'PATCH',
      url: '/api/v1/vendor/sub-orders/6f9619ff-8b86-d011-b42d-00cf4fc964ff/status',
      body: { status: 'SHIPPED', trackingCode: 'TRK-1' },
      user: actor,
      params: { id: '6f9619ff-8b86-d011-b42d-00cf4fc964ff' },
    };
    request[AUDIT_CONTEXT_PROPERTY] = { oldValue: { status: 'PROCESSING' }, newValue: { status: 'SHIPPED' } };

    await run(interceptor, handlerContext(request), handlerReturning({ status: 'SHIPPED' }));

    expect(entries[0]?.action).toBe(AuditAction.STATUS_CHANGE);
    expect(entries[0]?.entityName).toBe('SubOrder');
    expect(entries[0]?.entityId).toBe('6f9619ff-8b86-d011-b42d-00cf4fc964ff');
    expect(entries[0]?.oldValue).toEqual({ status: 'PROCESSING' });
  });

  it('honours the entityIdParam override', async () => {
    const { service, entries } = capturingAuditLog();
    const metadata: AuditableOptions = { entityName: 'Vendor', entityIdParam: 'vendorId' };
    const interceptor = new AuditInterceptor(reflectorWith({ [AUDIT_METADATA_KEY]: metadata }), service);
    const request: FakeRequest = {
      method: 'PATCH',
      url: '/api/v1/admin/vendors/ven-1/approve',
      params: { vendorId: 'ven-1', id: 'ignored' },
      user: actor,
    };

    await run(interceptor, handlerContext(request), handlerReturning({ status: 'APPROVED' }));

    expect(entries[0]?.entityId).toBe('ven-1');
    expect(entries[0]?.entityName).toBe('Vendor');
  });

  it('respects @SkipAudit', async () => {
    const { service, entries } = capturingAuditLog();
    const interceptor = new AuditInterceptor(reflectorWith({ [SKIP_AUDIT_KEY]: true }), service);

    await run(
      interceptor,
      handlerContext({ method: 'POST', url: '/api/v1/auth/otp/request', body: { mobile: '+989120000001' } }),
      handlerReturning({ status: 'sent' }),
    );

    expect(entries).toHaveLength(0);
  });

  it('attributes anonymous routes to the actor the handler discovered', async () => {
    // Login and OTP verification run before any JWT exists, so the handler
    // publishes the authenticated account through the audit context.
    const { service, entries } = capturingAuditLog();
    const interceptor = new AuditInterceptor(reflectorWith({}), service);
    const request: FakeRequest = {
      method: 'POST',
      url: '/api/v1/auth/otp/verify',
      body: { mobile: '+989120000001', code: '48213' },
    };
    request[AUDIT_CONTEXT_PROPERTY] = { actorId: 'user-from-otp', entityId: 'user-from-otp' };

    await run(interceptor, handlerContext(request), handlerReturning({ accessToken: 'a.b.c', refreshToken: 'd.e.f' }));

    expect(entries[0]?.userId).toBe('user-from-otp');
    expect(entries[0]?.entityId).toBe('user-from-otp');
    // The issued tokens must never be persisted in the trail.
    expect(JSON.stringify(entries[0])).not.toContain('a.b.c');
    expect(JSON.stringify(entries[0])).not.toContain('d.e.f');
  });

  it('leaves userId null when nobody is identifiable', async () => {
    const { service, entries } = capturingAuditLog();
    const interceptor = new AuditInterceptor(reflectorWith({}), service);

    await run(
      interceptor,
      handlerContext({ method: 'POST', url: '/api/v1/public/enquiry', body: { message: 'hello' } }),
      handlerReturning({ received: true }),
    );

    expect(entries[0]?.userId).toBeNull();
  });

  it('writes nothing when the handler fails', async () => {
    const { service, entries } = capturingAuditLog();
    const interceptor = new AuditInterceptor(reflectorWith({}), service);
    const request: FakeRequest = { method: 'POST', url: '/api/v1/vendors', body: {}, user: actor };

    await expect(
      run(interceptor, handlerContext(request), handlerFailing(new Error('validation failed'))),
    ).rejects.toThrow('validation failed');

    // A rejected request is not an event in the entity's history.
    expect(entries).toHaveLength(0);
  });

  it('does not fail the request when the audit write itself throws', async () => {
    const service = {
      record: (): Promise<string | null> => Promise.reject(new Error('database down')),
    } as unknown as AuditLogService;
    const interceptor = new AuditInterceptor(reflectorWith({}), service);
    const request: FakeRequest = { method: 'POST', url: '/api/v1/vendors', body: {}, user: actor };

    // Auditing must never break a business operation that already succeeded.
    await expect(
      run(interceptor, handlerContext(request), handlerReturning({ id: 'vendor-id' })),
    ).resolves.toEqual({ id: 'vendor-id' });
  });

  it('passes non-HTTP contexts straight through', async () => {
    const { service, entries } = capturingAuditLog();
    const interceptor = new AuditInterceptor(reflectorWith({}), service);
    const rpcContext = { getType: () => 'rpc' } as unknown as ExecutionContext;

    await expect(run(interceptor, rpcContext, handlerReturning('pong'))).resolves.toBe('pong');
    expect(entries).toHaveLength(0);
  });
  it('records a read that declares @Auditable: streaming a KYC document is an event', async () => {
    const { service, entries } = capturingAuditLog();
    const interceptor = new AuditInterceptor(
      reflectorWith({ [AUDIT_METADATA_KEY]: { action: AuditAction.STATUS_CHANGE, entityName: 'MediaAsset', entityIdParam: 'id' } }),
      service,
    );
    const documentId = '6f1b0d2e-3c4a-4f5b-8c9d-0e1f2a3b4c5d';

    await run(
      interceptor,
      handlerContext({ method: 'GET', url: `/api/v1/media/documents/${documentId}/download`, params: { id: documentId }, user: actor }),
      handlerReturning(undefined),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      userId: actor.id,
      action: AuditAction.STATUS_CHANGE,
      entityName: 'MediaAsset',
      entityId: documentId,
    });
    // A GET has no body: the trail keeps what the caller asked for instead.
    expect(entries[0]?.newValue).toEqual({ params: { id: documentId } });
  });

  it('leaves an undeclared read unaudited, and @SkipAudit beats a declared one', async () => {
    const plain = capturingAuditLog();
    await run(
      new AuditInterceptor(reflectorWith({}), plain.service),
      handlerContext({ method: 'GET', url: '/api/v1/health' }),
      handlerReturning({ status: 'ok' }),
    );
    expect(plain.entries).toHaveLength(0);

    const skipped = capturingAuditLog();
    await run(
      new AuditInterceptor(
        reflectorWith({ [SKIP_AUDIT_KEY]: true, [AUDIT_METADATA_KEY]: { entityName: 'MediaAsset' } }),
        skipped.service,
      ),
      handlerContext({ method: 'GET', url: '/api/v1/media/files/images/store_logo/2026/09/logo.webp' }),
      handlerReturning(undefined),
    );
    expect(skipped.entries).toHaveLength(0);
  });

});
