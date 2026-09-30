import { Prisma } from '@prisma/client';
import { PaymentGatewayError } from './payment-gateway.interface';
import { ZarinpalPaymentGatewayProvider, type FetchLike } from './zarinpal-payment-gateway.provider';

/**
 * Unit tests with an injected HTTP transport returning the response shapes
 * published in Zarinpal's v4 documentation. They pin the request contract and
 * the interpretation of every answer; they do NOT prove connectivity with
 * Zarinpal's servers (no merchant id exists in this environment).
 */
const MERCHANT = '1344b5d4-0048-11e8-94db-005056a205be';
const AUTHORITY = 'A00000000000000000000000000217885159';

function transport(status: number, body: unknown): { fetch: FetchLike; calls: Array<{ url: string; body: Record<string, unknown> }> } {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
    return Promise.resolve({ status, text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)) });
  };
  return { fetch, calls };
}

function provider(fetch: FetchLike): ZarinpalPaymentGatewayProvider {
  return new ZarinpalPaymentGatewayProvider({ merchantId: MERCHANT, apiBaseUrl: 'https://payment.zarinpal.com', timeoutMs: 5000, fetch });
}

const order = {
  paymentId: 'b3c7d3a4-8b2f-4a57-9a55-1f7d0f1c2e3a',
  orderNumber: 'SHP-100000001',
  amount: new Prisma.Decimal('5750000.00'),
  description: 'پرداخت سفارش',
  customerMobile: '+989121234567',
};

describe('ZarinpalPaymentGatewayProvider', () => {
  it('requests a payment in IRR and builds the StartPay URL', async () => {
    const { fetch, calls } = transport(200, { data: { code: 100, message: 'Success', authority: AUTHORITY, fee_type: 'Merchant', fee: 100 }, errors: [] });
    const result = await provider(fetch).initiatePayment(order, 'https://api.shopino.ir/api/v1/payments/callback');

    expect(calls[0]?.url).toBe('https://payment.zarinpal.com/pg/v4/payment/request.json');
    expect(calls[0]?.body).toEqual({
      merchant_id: MERCHANT,
      amount: 5_750_000,
      currency: 'IRR',
      callback_url: 'https://api.shopino.ir/api/v1/payments/callback',
      description: 'پرداخت سفارش',
      metadata: { order_id: 'SHP-100000001', mobile: '09121234567' },
    });
    expect(result.gatewayToken).toBe(AUTHORITY);
    expect(result.redirectUrl).toBe(`https://payment.zarinpal.com/pg/StartPay/${AUTHORITY}`);
  });

  it('refuses fractional rial amounts instead of rounding money', async () => {
    const { fetch, calls } = transport(200, {});
    await expect(provider(fetch).initiatePayment({ ...order, amount: new Prisma.Decimal('1000.50') }, 'https://x/cb')).rejects.toMatchObject({
      code: 'INVALID_AMOUNT',
    });
    expect(calls).toHaveLength(0);
  });

  it('turns a documented error envelope into a non-retryable gateway error', async () => {
    const { fetch } = transport(400, { data: [], errors: { code: -9, message: 'The input params invalid, validation error.', validations: [] } });
    const error = (await provider(fetch).initiatePayment(order, 'https://x/cb').catch((e: unknown) => e)) as PaymentGatewayError;
    expect(error).toBeInstanceOf(PaymentGatewayError);
    expect(error.code).toBe('ZARINPAL_-9');
    expect(error.retryable).toBe(false);
  });

  it('treats transport failures and 5xx as retryable (outcome unknown)', async () => {
    const down: FetchLike = () => Promise.reject(new Error('ECONNRESET'));
    await expect(provider(down).initiatePayment(order, 'https://x/cb')).rejects.toMatchObject({ code: 'GATEWAY_UNREACHABLE', retryable: true });
    const { fetch } = transport(502, '<html>Bad gateway</html>');
    await expect(provider(fetch).verifyPayment(AUTHORITY, { amount: order.amount, bankStatus: 'OK' })).rejects.toMatchObject({
      code: 'GATEWAY_UNAVAILABLE',
      retryable: true,
    });
  });

  it('verifies with the stored amount: 100 = verified, with ref_id and masked card', async () => {
    const { fetch, calls } = transport(200, {
      data: { code: 100, message: 'Verified', card_hash: '1EBE3EBEBE35C7EC0F8D6EE4F2F859107A87822CA179BC9528767EA7B5489B69', card_pan: '502229******5995', ref_id: 201, fee_type: 'Merchant', fee: 0 },
      errors: [],
    });
    const result = await provider(fetch).verifyPayment(AUTHORITY, { amount: order.amount, bankStatus: 'OK' });
    expect(calls[0]?.url).toBe('https://payment.zarinpal.com/pg/v4/payment/verify.json');
    expect(calls[0]?.body).toEqual({ merchant_id: MERCHANT, amount: 5_750_000, authority: AUTHORITY });
    expect(result).toMatchObject({ success: true, alreadyVerified: false, bankRrn: '201', cardPanMasked: '502229******5995', code: '100' });
  });

  it('treats 101 (already verified) as success on repeated verification', async () => {
    const { fetch } = transport(200, { data: { code: 101, message: 'Verified', card_pan: '502229******5995', ref_id: 201 }, errors: [] });
    const result = await provider(fetch).verifyPayment(AUTHORITY, { amount: order.amount, bankStatus: 'OK' });
    expect(result).toMatchObject({ success: true, alreadyVerified: true, bankRrn: '201' });
  });

  it('does not call verify when the bank redirected with Status=NOK', async () => {
    const { fetch, calls } = transport(200, {});
    const result = await provider(fetch).verifyPayment(AUTHORITY, { amount: order.amount, bankStatus: 'NOK' });
    expect(result).toMatchObject({ success: false, code: 'NOK' });
    expect(calls).toHaveLength(0);
  });

  it('reports a definitive verification refusal as an unsuccessful result', async () => {
    const { fetch } = transport(400, { data: [], errors: { code: -51, message: 'Session is not valid, session is not active paid try.' } });
    const result = await provider(fetch).verifyPayment(AUTHORITY, { amount: order.amount, bankStatus: 'OK' });
    expect(result).toMatchObject({ success: false, code: 'ZARINPAL_-51' });
  });

  it('parses the callback query', () => {
    const { fetch } = transport(200, {});
    expect(provider(fetch).parseCallback({ Authority: AUTHORITY, Status: 'OK' })).toEqual({ gatewayToken: AUTHORITY, bankStatus: 'OK' });
    expect(provider(fetch).parseCallback({ Authority: ['x', 'y'], Status: 'nok' })).toEqual({ gatewayToken: 'x', bankStatus: 'NOK' });
    expect(provider(fetch).parseCallback({ Status: 'BOGUS' })).toEqual({ gatewayToken: null, bankStatus: null });
  });
});
