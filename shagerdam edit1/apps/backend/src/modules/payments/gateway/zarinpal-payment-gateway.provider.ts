import type { Prisma } from '@prisma/client';
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

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{
  status: number;
  text(): Promise<string>;
}>;

export interface ZarinpalOptions {
  merchantId: string;
  /** https://payment.zarinpal.com (live) or https://sandbox.zarinpal.com. */
  apiBaseUrl: string;
  timeoutMs: number;
  fetch: FetchLike;
}

interface ZarinpalEnvelope {
  data?: unknown;
  errors?: unknown;
}

const OK = 100;
const ALREADY_VERIFIED = 101;

/**
 * Zarinpal IPG, REST API v4 (https://www.zarinpal.com/docs/paymentGateway/).
 *
 * - request: POST {base}/pg/v4/payment/request.json → `authority`, then the
 *   customer goes to {base}/pg/StartPay/{authority};
 * - callback: GET with `Authority` and `Status=OK|NOK`;
 * - verify:  POST {base}/pg/v4/payment/verify.json → code 100 (verified) or
 *   101 (already verified), `ref_id`, `card_pan`.
 *
 * Amounts are sent in IRR with `currency: "IRR"` explicitly, matching the
 * platform currency, so no Toman conversion can go wrong. A payment that is
 * never verified is reversed to the payer by the bank.
 *
 * Status: implemented against the published documentation and unit-tested
 * with recorded response shapes; NOT yet exercised against Zarinpal's servers
 * (no merchant id is configured in this environment).
 */
export class ZarinpalPaymentGatewayProvider implements PaymentGatewayProvider {
  readonly name = 'ZARINPAL' as const;

  constructor(private readonly options: ZarinpalOptions) {}

  async initiatePayment(order: GatewayOrder, callbackUrl: string): Promise<GatewayInitiation> {
    const body = {
      merchant_id: this.options.merchantId,
      amount: toWholeRials(order.amount),
      currency: 'IRR',
      callback_url: callbackUrl,
      description: order.description.slice(0, 500),
      metadata: {
        order_id: order.orderNumber,
        ...(order.customerMobile ? { mobile: toLocalMobile(order.customerMobile) } : {}),
      },
    };
    const data = await this.call('/pg/v4/payment/request.json', body);
    const code = numberField(data, 'code');
    const authority = stringField(data, 'authority');
    if (code !== OK || authority === null) {
      throw new PaymentGatewayError(`Zarinpal refused the payment request (code ${String(code)})`, `ZARINPAL_${String(code)}`, false);
    }
    return {
      gatewayToken: authority,
      redirectUrl: `${this.options.apiBaseUrl}/pg/StartPay/${encodeURIComponent(authority)}`,
      details: { feeType: stringField(data, 'fee_type'), fee: numberField(data, 'fee') },
    };
  }

  parseCallback(params: Record<string, unknown>): GatewayCallback {
    return { gatewayToken: firstString(params['Authority']), bankStatus: bankStatusOf(params['Status']) };
  }

  async verifyPayment(gatewayToken: string, params: { amount: Prisma.Decimal; bankStatus: 'OK' | 'NOK' | null }): Promise<GatewayVerification> {
    if (params.bankStatus !== 'OK') {
      // Zarinpal: verify only when Status=OK; NOK means the payer cancelled or the bank declined.
      return failure('NOK', 'The payment was cancelled or declined at the bank');
    }
    let data: Record<string, unknown>;
    try {
      data = await this.call('/pg/v4/payment/verify.json', {
        merchant_id: this.options.merchantId,
        amount: toWholeRials(params.amount),
        authority: gatewayToken,
      });
    } catch (error) {
      if (error instanceof PaymentGatewayError && !error.retryable) {
        return failure(error.code, error.message);
      }
      throw error;
    }
    const code = numberField(data, 'code');
    if (code === OK || code === ALREADY_VERIFIED) {
      const refId = data['ref_id'];
      return {
        success: true,
        alreadyVerified: code === ALREADY_VERIFIED,
        bankRrn: typeof refId === 'number' || typeof refId === 'string' ? String(refId) : null,
        cardPanMasked: stringField(data, 'card_pan'),
        code: String(code),
        message: stringField(data, 'message') ?? 'Verified',
      };
    }
    return failure(`ZARINPAL_${String(code)}`, stringField(data, 'message') ?? 'Payment not verified');
  }

  /** POSTs JSON; returns `data` on a well-formed answer, throws otherwise. */
  private async call(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    let status: number;
    let text: string;
    try {
      const response = await this.options.fetch(`${this.options.apiBaseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      status = response.status;
      text = await response.text();
    } catch (error) {
      throw new PaymentGatewayError(
        `Zarinpal is unreachable: ${error instanceof Error ? error.message : String(error)}`,
        'GATEWAY_UNREACHABLE',
        true,
      );
    } finally {
      clearTimeout(timer);
    }
    if (status >= 500) {
      throw new PaymentGatewayError(`Zarinpal answered HTTP ${status}`, 'GATEWAY_UNAVAILABLE', true);
    }
    let envelope: ZarinpalEnvelope;
    try {
      envelope = JSON.parse(text) as ZarinpalEnvelope;
    } catch {
      throw new PaymentGatewayError(`Zarinpal answered HTTP ${status} with a non-JSON body`, 'GATEWAY_BAD_RESPONSE', true);
    }
    // Errors come back as { data: [], errors: { code, message } } (HTTP 4xx).
    if (isRecord(envelope.errors) && typeof envelope.errors['code'] === 'number') {
      const code = envelope.errors['code'];
      const message = typeof envelope.errors['message'] === 'string' ? envelope.errors['message'] : 'Zarinpal error';
      throw new PaymentGatewayError(`Zarinpal error ${code}: ${message}`, `ZARINPAL_${code}`, false);
    }
    if (!isRecord(envelope.data)) {
      throw new PaymentGatewayError(`Zarinpal answered HTTP ${status} without data`, 'GATEWAY_BAD_RESPONSE', true);
    }
    return envelope.data;
  }
}

function failure(code: string, message: string): GatewayVerification {
  return { success: false, alreadyVerified: false, bankRrn: null, cardPanMasked: null, code, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberField(data: Record<string, unknown>, key: string): number | null {
  const value = data[key];
  return typeof value === 'number' ? value : null;
}

function stringField(data: Record<string, unknown>, key: string): string | null {
  const value = data[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Zarinpal expects the local 09… form. */
function toLocalMobile(e164: string): string {
  return e164.startsWith('+98') ? `0${e164.slice(3)}` : e164;
}
