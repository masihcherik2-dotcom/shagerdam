import type { Prisma } from '@prisma/client';

/** Result of the provider's credit/score inquiry for a person. */
export interface EligibilityResult {
  eligible: boolean;
  /** Credit score reported by the provider (null if it does not disclose one). */
  score: number | null;
  /** Highest limit the provider would grant (null = no cap disclosed). */
  maxEligibleLimit: Prisma.Decimal | null;
  /** Provider's inquiry reference. */
  inquiryRef: string;
  /** Machine-readable reason when not eligible. */
  reason: string | null;
  /** Non-sensitive provider answer, stored in `credit_applications.bank_score_response`. */
  details: Record<string, unknown>;
}

/** A supporting document the customer uploaded (media asset of kind DOCUMENT). */
export interface ApplicationDocument {
  mediaAssetId: string;
  mimeType: string;
  sizeBytes: number;
}

export type ProviderApplicationStatus = 'APPROVED' | 'REJECTED' | 'DOCS_REQUIRED';

export interface ApplicationDecision {
  status: ProviderApplicationStatus;
  /** Granted limit (whole rials) when APPROVED. */
  approvedLimit: Prisma.Decimal | null;
  /** Provider's application tracking code. */
  trackingCode: string;
  reason: string | null;
  details: Record<string, unknown>;
}

export interface CreditReservation {
  /** Provider reference of the hold; commit/release address it. */
  reservationRef: string;
  details: Record<string, unknown>;
}

/**
 * A bank / fintech credit provider (TM brief §1). Implementations talk to the
 * provider only; the platform's own ledger (`CreditLedgerService`) mirrors every
 * movement in the database.
 *
 * - `inquireEligibility` — credit/score inquiry for a national code + mobile;
 * - `submitApplication`  — asks for a credit line of `requestedLimit`;
 * - `reserveCredit`      — holds an amount of an open line for an order;
 * - `commitCredit`       — converts a hold into a purchase (idempotent);
 * - `releaseCredit`      — cancels a hold (idempotent).
 *
 * Transport problems throw a `CreditProviderError` with `retryable: true`;
 * a definitive refusal is either a result (`eligible: false`, `REJECTED`) or a
 * non-retryable error.
 */
export interface CreditProviderAdapter {
  /** `credit_providers.code` this adapter serves. */
  readonly code: string;
  /** True for development/test providers that move no money. */
  readonly isSandbox: boolean;
  inquireEligibility(nationalCode: string, mobile: string): Promise<EligibilityResult>;
  submitApplication(userId: string, requestedLimit: Prisma.Decimal, docs: readonly ApplicationDocument[]): Promise<ApplicationDecision>;
  reserveCredit(creditAccountId: string, amount: Prisma.Decimal, parentOrderId: string): Promise<CreditReservation>;
  commitCredit(reservationRef: string): Promise<void>;
  releaseCredit(reservationRef: string): Promise<void>;
}

export class CreditProviderError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'CreditProviderError';
  }
}
