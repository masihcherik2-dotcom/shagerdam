import type { Prisma } from '@prisma/client';

/** DI token of the active `PaymentGatewayProvider` (selected by PAYMENT_GATEWAY_PROVIDER at boot). */
export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');

/** Name stored in `payments.gateway_name`; callbacks are matched on (name, token). */
export type PaymentGatewayName = 'SANDBOX' | 'ZARINPAL';

/** What a gateway needs to open a payment session for an order. */
export interface GatewayOrder {
  paymentId: string;
  orderNumber: string;
  /** Amount to charge, in IRR (the platform currency). Must be a whole number of rials. */
  amount: Prisma.Decimal;
  description: string;
  customerMobile: string | null;
}

export interface GatewayInitiation {
  /** Gateway session token (Zarinpal "authority"); comes back in the callback. */
  gatewayToken: string;
  /** Where the customer's browser is sent to pay. */
  redirectUrl: string;
  /** Non-sensitive gateway data kept in `payments.metadata` (fees etc.). */
  details: Record<string, unknown>;
}

/** The fields a callback carries, normalised across gateways. */
export interface GatewayCallback {
  gatewayToken: string | null;
  /** The bank's own verdict in the redirect (`OK` / `NOK`); never trusted without `verifyPayment`. */
  bankStatus: 'OK' | 'NOK' | null;
}

export interface GatewayVerification {
  /** True only when the gateway confirmed the money was captured for exactly this amount. */
  success: boolean;
  /** Gateway said "already verified" (Zarinpal 101): still a success, returned on repeat calls. */
  alreadyVerified: boolean;
  /** Bank reference (RRN / Zarinpal ref_id) of a successful payment. */
  bankRrn: string | null;
  /** Masked card number, e.g. 502229******5995 (never the full PAN). */
  cardPanMasked: string | null;
  code: string;
  message: string;
}

/**
 * A card-payment gateway (IPG). Implementations must be stateless apart from
 * the gateway itself: the payment service persists everything that matters.
 *
 * - `initiatePayment` opens a bank session and returns where to send the customer.
 * - `parseCallback` extracts the session token and the bank's redirect status.
 * - `verifyPayment` asks the gateway server-to-server whether the money was
 *   captured; it is the only source of truth for success.
 *
 * Transport problems (timeout, 5xx, unreadable answer) throw a retryable
 * `PaymentGatewayError`; a definitive "not paid" is a `success: false` result.
 */
export interface PaymentGatewayProvider {
  readonly name: PaymentGatewayName;
  initiatePayment(order: GatewayOrder, callbackUrl: string): Promise<GatewayInitiation>;
  parseCallback(params: Record<string, unknown>): GatewayCallback;
  verifyPayment(gatewayToken: string, params: { amount: Prisma.Decimal; bankStatus: 'OK' | 'NOK' | null }): Promise<GatewayVerification>;
}

/** A gateway call failed. `retryable` = transport problem, the outcome is unknown. */
export class PaymentGatewayError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'PaymentGatewayError';
  }
}

/** IRR amount as the integer gateways expect; refuses fractions instead of rounding money. */
export function toWholeRials(amount: Prisma.Decimal): number {
  if (!amount.isInteger() || !amount.greaterThan(0)) {
    throw new PaymentGatewayError(`Amount ${amount.toFixed(2)} is not a positive whole number of rials`, 'INVALID_AMOUNT', false);
  }
  const value = amount.toNumber();
  if (!Number.isSafeInteger(value)) {
    throw new PaymentGatewayError(`Amount ${amount.toFixed(0)} is too large`, 'INVALID_AMOUNT', false);
  }
  return value;
}

export function firstString(value: unknown): string | null {
  const candidate = Array.isArray(value) ? (value[0] as unknown) : value;
  return typeof candidate === 'string' && candidate.trim() !== '' ? candidate.trim() : null;
}

export function bankStatusOf(value: unknown): 'OK' | 'NOK' | null {
  const status = firstString(value)?.toUpperCase();
  return status === 'OK' || status === 'NOK' ? status : null;
}
