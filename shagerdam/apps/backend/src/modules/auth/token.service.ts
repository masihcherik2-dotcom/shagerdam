import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { UserRole } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import type { EnvironmentVariables } from '../../config/env.validation';
import type { DurationString } from '../../common/types/duration';
import { RedisService } from '../../infra/redis/redis.service';
import type { RequestContext } from '../../common/types/request-context';

/** Discriminator that stops an access token from being replayed as a refresh token. */
export type TokenType = 'access' | 'refresh';

export interface AccessTokenPayload {
  /** `users.id`. */
  sub: string;
  mobile: string;
  role: UserRole;
  typ: 'access';
  /** Session (refresh-token) identifier this access token belongs to. */
  sid: string;
  /** Token identifier, unique per issued access token. */
  jti: string;
}

export interface RefreshTokenPayload {
  sub: string;
  typ: 'refresh';
  jti: string;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  /** Access-token lifetime in seconds, mirrors the JWT `exp`. */
  expiresIn: number;
  refreshExpiresIn: number;
  /** Session id, so callers can correlate logs without decoding the token. */
  sessionId: string;
}

export interface SessionRecord {
  userId: string;
  /** sha256 of the refresh token: a Redis dump never yields a usable token. */
  refreshTokenHash: string;
  createdAt: string;
  lastUsedAt: string;
  ipAddress: string | null;
  userAgent: string | null;
}

/** `auth:session:<jti>` → {@link SessionRecord}, TTL = refresh lifetime. */
export const sessionKey = (sessionId: string): string => `auth:session:${sessionId}`;

/** `auth:user-sessions:<userId>` → set of active session ids. */
export const userSessionsKey = (userId: string): string => `auth:user-sessions:${userId}`;

/** `auth:login-attempts:<identifier>` → failed password attempts counter. */
export const loginAttemptsKey = (identifier: string): string => `auth:login-attempts:${identifier}`;

/** `auth:login-lock:<identifier>` → present while password login is locked. */
export const loginLockKey = (identifier: string): string => `auth:login-lock:${identifier}`;

/**
 * Issues and validates tokens.
 *
 * The model is deliberately *stateful* on top of stateless JWTs:
 *
 * - the **access token** is a short-lived (15m) stateless JWT — no database or
 *   Redis round-trip on the hot path;
 * - the **refresh token** is persistent (7d) and is tracked server-side in
 *   Redis, so it can be revoked instantly on logout.
 *
 * Refresh **rotates**: every successful refresh deletes the old session and
 * creates a new one. If a refresh token is presented whose session no longer
 * exists, that token was either already used or revoked — both are treated as a
 * replay and rejected, which is what makes stolen refresh tokens detectable
 * rather than silently reusable until they expire.
 */
@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);
  private readonly accessSecret: string;
  private readonly refreshSecret: string;
  private readonly accessTtl: DurationString;
  private readonly refreshTtl: DurationString;
  private readonly accessTtlSeconds: number;
  private readonly refreshTtlSeconds: number;
  private readonly issuer = 'shopino';
  private readonly audience = 'shopino-api';

  constructor(
    private readonly jwt: JwtService,
    private readonly redis: RedisService,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.accessSecret = config.getOrThrow<string>('JWT_ACCESS_SECRET');
    this.refreshSecret = config.getOrThrow<string>('JWT_REFRESH_SECRET');
    this.accessTtl = config.getOrThrow<DurationString>('JWT_ACCESS_TTL');
    this.refreshTtl = config.getOrThrow<DurationString>('JWT_REFRESH_TTL');
    this.accessTtlSeconds = durationToSeconds(this.accessTtl);
    this.refreshTtlSeconds = durationToSeconds(this.refreshTtl);
  }

  get accessTokenTtlSeconds(): number {
    return this.accessTtlSeconds;
  }

  get refreshTokenTtlSeconds(): number {
    return this.refreshTtlSeconds;
  }

  /** Signs a fresh access/refresh pair and registers the session. */
  async issue(
    user: { id: string; mobile: string; role: UserRole },
    context: RequestContext,
  ): Promise<IssuedTokens> {
    const sessionId = randomUUID();

    const accessToken = await this.jwt.signAsync(
      {
        sub: user.id,
        mobile: user.mobile,
        role: user.role,
        typ: 'access' satisfies TokenType,
        sid: sessionId,
      },
      {
        secret: this.accessSecret,
        expiresIn: this.accessTtl,
        issuer: this.issuer,
        audience: this.audience,
        jwtid: randomUUID(),
      },
    );

    const refreshToken = await this.jwt.signAsync(
      { sub: user.id, typ: 'refresh' satisfies TokenType },
      {
        secret: this.refreshSecret,
        expiresIn: this.refreshTtl,
        issuer: this.issuer,
        audience: this.audience,
        jwtid: sessionId,
      },
    );

    const now = new Date().toISOString();
    const record: SessionRecord = {
      userId: user.id,
      refreshTokenHash: hashToken(refreshToken),
      createdAt: now,
      lastUsedAt: now,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    };

    await this.redis.client
      .multi()
      .set(sessionKey(sessionId), JSON.stringify(record), 'EX', this.refreshTtlSeconds)
      .sadd(userSessionsKey(user.id), sessionId)
      .expire(userSessionsKey(user.id), this.refreshTtlSeconds)
      .exec();

    return {
      accessToken,
      refreshToken,
      expiresIn: this.accessTtlSeconds,
      refreshExpiresIn: this.refreshTtlSeconds,
      sessionId,
    };
  }

  /**
   * Validates an access token's signature and claims. The identity is *not*
   * trusted from the payload alone — callers re-read the user row so a
   * deactivated account or a changed role takes effect immediately.
   */
  async verifyAccessToken(token: string): Promise<AccessTokenPayload> {
    try {
      const payload = await this.jwt.verifyAsync<AccessTokenPayload>(token, {
        secret: this.accessSecret,
        issuer: this.issuer,
        audience: this.audience,
      });

      if (payload.typ !== 'access' || typeof payload.sub !== 'string' || typeof payload.sid !== 'string') {
        throw new UnauthorizedException('Invalid access token');
      }
      return payload;
    } catch (error) {
      throw new UnauthorizedException(
        error instanceof UnauthorizedException ? error.message : 'Invalid or expired access token',
      );
    }
  }

  /**
   * Rotates a refresh token: validates it, consumes the session and returns a
   * new pair. Throws `401` when the session is unknown, already rotated, or the
   * stored hash does not match the presented token.
   */
  async rotate(
    refreshToken: string,
    user: { id: string; mobile: string; role: UserRole },
    context: RequestContext,
  ): Promise<IssuedTokens> {
    const payload = await this.decodeRefreshToken(refreshToken);
    const key = sessionKey(payload.jti);
    const raw = await this.redis.client.get(key);

    if (raw === null) {
      this.logger.warn(`Refresh rejected: session ${payload.jti} is unknown or already rotated`);
      throw new UnauthorizedException('Refresh token is no longer valid');
    }

    const session = JSON.parse(raw) as SessionRecord;
    if (
      session.userId !== user.id ||
      session.userId !== payload.sub ||
      session.refreshTokenHash !== hashToken(refreshToken)
    ) {
      // A mismatch here means a *different* token claims the same session id.
      // Revoke the session outright: the legitimate client will simply log in again.
      await this.revoke(payload.jti);
      this.logger.warn(`Refresh rejected: token does not match session ${payload.jti}; session revoked`);
      throw new UnauthorizedException('Refresh token is no longer valid');
    }

    await this.revoke(payload.jti);
    return this.issue(user, context);
  }

  /** Session id (`jti`) carried by a refresh token, after signature validation. */
  async sessionIdOfRefreshToken(token: string): Promise<string> {
    return (await this.decodeRefreshToken(token)).jti;
  }

  /** Reads a stored session. Returns `null` when it no longer exists. */
  async getSession(sessionId: string): Promise<SessionRecord | null> {
    const raw = await this.redis.client.get(sessionKey(sessionId));
    return raw === null ? null : (JSON.parse(raw) as SessionRecord);
  }

  /** Revokes one session. Returns `true` when a session was actually removed. */
  async revoke(sessionId: string): Promise<boolean> {
    const raw = await this.redis.client.get(sessionKey(sessionId));
    const removed = await this.redis.client.del(sessionKey(sessionId));

    if (raw !== null) {
      const session = JSON.parse(raw) as SessionRecord;
      await this.redis.client.srem(userSessionsKey(session.userId), sessionId);
    }

    return removed > 0;
  }

  /** Revokes every session of a user (logout everywhere, password change, ban). */
  async revokeAllForUser(userId: string): Promise<number> {
    const sessionIds = await this.redis.client.smembers(userSessionsKey(userId));
    if (sessionIds.length === 0) {
      return 0;
    }
    await this.redis.client.del(...sessionIds.map((id) => sessionKey(id)), userSessionsKey(userId));
    return sessionIds.length;
  }

  /** Active sessions of a user, newest first. Never exposes any token material. */
  async listSessions(userId: string): Promise<Array<Omit<SessionRecord, 'refreshTokenHash'> & { sessionId: string }>> {
    const sessionIds = await this.redis.client.smembers(userSessionsKey(userId));
    if (sessionIds.length === 0) {
      return [];
    }

    const raws = await this.redis.client.mget(...sessionIds.map((id) => sessionKey(id)));
    const sessions = raws
      .map((raw, index) => {
        if (raw === null) {
          return null;
        }
        const session = JSON.parse(raw) as SessionRecord;
        // The refresh-token hash is deliberately not part of the projection.
        return {
          sessionId: sessionIds[index] as string,
          userId: session.userId,
          createdAt: session.createdAt,
          lastUsedAt: session.lastUsedAt,
          ipAddress: session.ipAddress,
          userAgent: session.userAgent,
        };
      })
      .filter((session): session is Omit<SessionRecord, 'refreshTokenHash'> & { sessionId: string } => session !== null);

    return sessions.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  private async decodeRefreshToken(token: string): Promise<RefreshTokenPayload> {
    try {
      const payload = await this.jwt.verifyAsync<RefreshTokenPayload>(token, {
        secret: this.refreshSecret,
        issuer: this.issuer,
        audience: this.audience,
      });
      if (payload.typ !== 'refresh' || typeof payload.sub !== 'string' || typeof payload.jti !== 'string') {
        throw new UnauthorizedException('Invalid refresh token');
      }
      return payload;
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
  }
}

/** sha256 hex digest, used for every stored token/secret material. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Converts the `@nestjs/jwt` duration shorthand (`15m`, `7d`, `12h`, `30s`) into
 * seconds. Used for Redis TTLs so a session never outlives its own token, and
 * for the `expiresIn` values returned to clients.
 */
export function durationToSeconds(value: string): number {
  const match = /^([1-9][0-9]*)([smhd])$/.exec(value.trim());
  if (match === null) {
    throw new Error(`Unsupported duration "${value}": expected forms like 30s, 15m, 12h or 7d`);
  }
  const amount = Number(match[1]);
  const unit = match[2] as 's' | 'm' | 'h' | 'd';

  switch (unit) {
    case 's':
      return amount;
    case 'm':
      return amount * 60;
    case 'h':
      return amount * 3_600;
    case 'd':
      return amount * 86_400;
  }
}
