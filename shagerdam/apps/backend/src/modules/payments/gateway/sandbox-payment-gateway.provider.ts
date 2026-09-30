import { Prisma } from '@prisma/client';
import { randomBytes, randomInt } from 'node:crypto';
import type { RedisService } from '../../../infra/redis/redis.service';
import {
  bankStatusOf,
  firstString,
  PaymentGatewayError,
  toWholeRials,
  type GatewayCallback,
  type GatewayInitiation,
  type GatewayOrder,
  type GatewayVerification,
  type PaymentGatewayProvider,
} from './payment-gateway.interface';

/** Bank session lifetime; longer than any order payment window. */
export const SANDBOX_SESSION_TTL_SECONDS = 2 * 60 * 60;

const SESSION_KEY = (authority: string): string => `payment:sandbox:session:${authority}`;
const PAYMENT_KEY = (paymentId: string): string => `payment:sandbox:payment:${paymentId}`;

export type SandboxSessionStatus = 'AWAITING_PAYER' | 'PAID' | 'DECLINED';

/** State of one simulated bank session, as the "bank" (Redis) keeps it. */
export interface SandboxSession {
  authority: string;
  paymentId: string;
  orderNumber: string;
  amount: string;
  callbackUrl: string;
  status: SandboxSessionStatus;
  bankRrn: string | null;
  cardPanMasked: string | null;
  verifiedAt: string | null;
  createdAt: string;
}

/**
 * DEVELOPMENT / TEST ONLY. A self-contained simulated bank that follows the
 * Zarinpal-style flow end to end, so the whole payment path (initiate →
 * redirect → payer decision → callback → server-side verify) runs for real
 * without a merchant account:
 *
 * - `initiatePayment` opens a session in Redis and returns the URL of the
 *   built-in bank page (`GET /api/v1/sandbox/payment-page/:paymentId`);
 * - the page's Pay / Decline buttons settle the session (with a random 12-digit
 *   RRN on success) and redirect the browser to the callback with
 *   `Authority` + `Status=OK|NOK`;
 * - `verifyPayment` checks the session state *and the amount*, like a bank:
 *   100 on the first verify, 101 afterwards.
 *
 * No money moves. The API refuses to boot with this provider in production
 * (env.validation.ts) and the bank page answers 404 unless it is active.
 */
export class SandboxPaymentGatewayProvider implements PaymentGatewayProvider {
  readonly name = 'SANDBOX' as const;

  constructor(
    private readonly redis: RedisService,
    private readonly publicApiOrigin: string,
  ) {}

  async initiatePayment(order: GatewayOrder, callbackUrl: string): Promise<GatewayInitiation> {
    const amount = toWholeRials(order.amount);
    const authority = `SBX${randomBytes(16).toString('hex').toUpperCase()}`;
    const session: SandboxSession = {
      authority,
      paymentId: order.paymentId,
      orderNumber: order.orderNumber,
      amount: String(amount),
      callbackUrl,
      status: 'AWAITING_PAYER',
      bankRrn: null,
      cardPanMasked: null,
      verifiedAt: null,
      createdAt: new Date().toISOString(),
    };
    await this.redis.client
      .multi()
      .set(SESSION_KEY(authority), JSON.stringify(session), 'EX', SANDBOX_SESSION_TTL_SECONDS)
      .set(PAYMENT_KEY(order.paymentId), authority, 'EX', SANDBOX_SESSION_TTL_SECONDS)
      .exec();
    return {
      gatewayToken: authority,
      redirectUrl: `${this.publicApiOrigin}/api/v1/sandbox/payment-page/${order.paymentId}`,
      details: { simulated: true },
    };
  }

  parseCallback(params: Record<string, unknown>): GatewayCallback {
    return { gatewayToken: firstString(params['Authority']), bankStatus: bankStatusOf(params['Status']) };
  }

  async verifyPayment(gatewayToken: string, params: { amount: Prisma.Decimal; bankStatus: 'OK' | 'NOK' | null }): Promise<GatewayVerification> {
    if (params.bankStatus !== 'OK') {
      return failure('NOK', 'The payment was cancelled or declined at the (sandbox) bank');
    }
    const session = await this.sessionByAuthority(gatewayToken);
    if (!session) {
      return failure('SESSION_NOT_FOUND', 'Unknown or expired sandbox bank session');
    }
    if (session.status !== 'PAID') {
      return failure('NOT_PAID', `The sandbox bank session is ${session.status}`);
    }
    if (!new Prisma.Decimal(session.amount).equals(params.amount)) {
      return failure('AMOUNT_MISMATCH', `Verified amount ${params.amount.toFixed(0)} does not match the paid amount ${session.amount}`);
    }
    const alreadyVerified = session.verifiedAt !== null;
    if (!alreadyVerified) {
      await this.save({ ...session, verifiedAt: new Date().toISOString() });
    }
    return {
      success: true,
      alreadyVerified,
      bankRrn: session.bankRrn,
      cardPanMasked: session.cardPanMasked,
      code: alreadyVerified ? '101' : '100',
      message: alreadyVerified ? 'Already verified' : 'Verified',
    };
  }

  // ─── used by the sandbox bank page ────────────────────────────────────────

  async sessionByPayment(paymentId: string): Promise<SandboxSession | null> {
    const authority = await this.redis.client.get(PAYMENT_KEY(paymentId));
    return authority ? this.sessionByAuthority(authority) : null;
  }

  /**
   * The payer's decision on the bank page. Only an AWAITING_PAYER session can be
   * settled (a second click cannot turn a decline into a payment). Returns the
   * callback URL the browser must be sent to.
   */
  async settle(paymentId: string, decision: 'PAY' | 'DECLINE'): Promise<{ session: SandboxSession; redirectTo: string }> {
    const session = await this.sessionByPayment(paymentId);
    if (!session) {
      throw new PaymentGatewayError('Unknown or expired sandbox bank session', 'SESSION_NOT_FOUND', false);
    }
    let settled = session;
    if (session.status === 'AWAITING_PAYER') {
      settled =
        decision === 'PAY'
          ? { ...session, status: 'PAID', bankRrn: randomRrn(), cardPanMasked: `603799******${String(randomInt(0, 10_000)).padStart(4, '0')}` }
          : { ...session, status: 'DECLINED' };
      await this.save(settled);
    }
    const url = new URL(settled.callbackUrl);
    url.searchParams.set('Authority', settled.authority);
    url.searchParams.set('Status', settled.status === 'PAID' ? 'OK' : 'NOK');
    return { session: settled, redirectTo: url.toString() };
  }

  private async sessionByAuthority(authority: string): Promise<SandboxSession | null> {
    const raw = await this.redis.client.get(SESSION_KEY(authority));
    return raw ? (JSON.parse(raw) as SandboxSession) : null;
  }

  private async save(session: SandboxSession): Promise<void> {
    await this.redis.client.set(SESSION_KEY(session.authority), JSON.stringify(session), 'KEEPTTL');
  }
}

function failure(code: string, message: string): GatewayVerification {
  return { success: false, alreadyVerified: false, bankRrn: null, cardPanMasked: null, code, message };
}

/** 12-digit retrieval reference number, the format Shaparak RRNs have. */
function randomRrn(): string {
  return `${randomInt(1, 10)}${String(randomInt(0, 100_000)).padStart(5, '0')}${String(randomInt(0, 1_000_000)).padStart(6, '0')}`;
}
