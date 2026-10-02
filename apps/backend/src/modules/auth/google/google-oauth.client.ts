import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables } from '../../../config/env.validation';
import { resolveGoogleRedirectUri } from '../../../config/env.validation';
import { GoogleIdTokenError, parseGoogleIdToken, type GoogleProfile } from './google-id-token';

/** Google's OAuth 2.0 / OpenID Connect endpoints (injectable so tests can run a local OIDC fixture). */
export interface GoogleOAuthEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  issuers: readonly string[];
}

export const GOOGLE_OAUTH_ENDPOINTS = Symbol('GOOGLE_OAUTH_ENDPOINTS');

/** Values from https://accounts.google.com/.well-known/openid-configuration. */
export const GOOGLE_PUBLIC_ENDPOINTS: GoogleOAuthEndpoints = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  issuers: ['https://accounts.google.com', 'accounts.google.com'],
};

/** Why the code exchange failed: Google refused the code, or Google could not be reached. */
export class GoogleOAuthError extends Error {
  constructor(
    readonly reason: 'rejected' | 'unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'GoogleOAuthError';
  }
}

const TOKEN_TIMEOUT_MS = 10_000;

/**
 * The Google side of "Sign in with Google": builds the authorization URL
 * (authorization-code flow with PKCE S256 and a nonce) and exchanges the code
 * for the user's profile server-to-server. The client secret never leaves the
 * API.
 */
@Injectable()
export class GoogleOAuthClient {
  private readonly logger = new Logger(GoogleOAuthClient.name);
  private readonly clientId: string | null;
  private readonly clientSecret: string | null;
  readonly redirectUri: string;

  constructor(
    @Inject(GOOGLE_OAUTH_ENDPOINTS) private readonly endpoints: GoogleOAuthEndpoints,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.clientId = config.get<string | undefined>('GOOGLE_CLIENT_ID') ?? null;
    this.clientSecret = config.get<string | undefined>('GOOGLE_CLIENT_SECRET') ?? null;
    this.redirectUri = resolveGoogleRedirectUri({
      GOOGLE_REDIRECT_URI: config.get<string | undefined>('GOOGLE_REDIRECT_URI'),
      PUBLIC_WEB_ORIGIN: config.get<string | undefined>('PUBLIC_WEB_ORIGIN'),
      PUBLIC_API_ORIGIN: config.getOrThrow<string>('PUBLIC_API_ORIGIN'),
    });
  }

  get isConfigured(): boolean {
    return this.clientId !== null && this.clientSecret !== null;
  }

  authorizationUrl(params: { state: string; codeChallenge: string; nonce: string }): string {
    const url = new URL(this.endpoints.authorizationEndpoint);
    url.search = new URLSearchParams({
      client_id: this.requireClientId(),
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state: params.state,
      nonce: params.nonce,
      code_challenge: params.codeChallenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    }).toString();
    return url.toString();
  }

  /**
   * Redeems the authorization code (with the PKCE verifier) at the token
   * endpoint and returns the validated ID-token profile. Throws
   * {@link GoogleOAuthError} or {@link GoogleIdTokenError}.
   */
  async exchangeCode(code: string, codeVerifier: string, nonce: string): Promise<GoogleProfile> {
    const clientId = this.requireClientId();
    let response: Response;
    try {
      response = await fetch(this.endpoints.tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          code_verifier: codeVerifier,
          client_id: clientId,
          client_secret: this.clientSecret ?? '',
          redirect_uri: this.redirectUri,
        }).toString(),
        signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
        redirect: 'error',
      });
    } catch (error) {
      this.logger.warn(`Google token endpoint unreachable: ${error instanceof Error ? error.message : String(error)}`);
      throw new GoogleOAuthError('unavailable', 'Google could not be reached');
    }

    const body = (await response.json().catch(() => null)) as { id_token?: unknown; error?: unknown } | null;
    if (response.status >= 500) {
      throw new GoogleOAuthError('unavailable', `Google token endpoint answered ${response.status}`);
    }
    if (!response.ok || body === null || typeof body.id_token !== 'string') {
      const reason = body !== null && typeof body.error === 'string' ? body.error.slice(0, 60) : `HTTP ${response.status}`;
      this.logger.warn(`Google refused the authorization code (${reason})`);
      throw new GoogleOAuthError('rejected', 'Google refused the authorization code');
    }

    try {
      return parseGoogleIdToken(body.id_token, {
        clientId,
        issuers: this.endpoints.issuers,
        nonce,
        nowSeconds: Math.floor(Date.now() / 1000),
      });
    } catch (error) {
      if (error instanceof GoogleIdTokenError) this.logger.warn(error.message);
      throw error;
    }
  }

  private requireClientId(): string {
    if (this.clientId === null) throw new GoogleOAuthError('unavailable', 'Google sign-in is not configured');
    return this.clientId;
  }
}
