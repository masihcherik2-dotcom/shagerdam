import { Body, Controller, Get, HttpStatus, Inject, NotFoundException, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import { ApiBadRequestResponse, ApiNotFoundResponse, ApiOperation, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { Public } from '../../common/decorators/public.decorator';
import { SkipAudit } from '../audit/audit.decorator';
import { SandboxDecisionDto } from './dto/sandbox.dto';
import { PAYMENT_GATEWAY, PaymentGatewayError, type PaymentGatewayProvider } from './gateway/payment-gateway.interface';
import { SandboxPaymentGatewayProvider, type SandboxSession } from './gateway/sandbox-payment-gateway.provider';

const UUID = new ParseUUIDPipe({ version: '4' });

/**
 * DEVELOPMENT / TEST ONLY — the simulated bank page of the sandbox gateway.
 * Every route answers 404 unless PAYMENT_GATEWAY_PROVIDER=sandbox, and the API
 * cannot boot with the sandbox provider in production, so this page never
 * exists in production.
 */
@ApiTags('sandbox-payments')
@Public()
@Controller('sandbox/payment-page')
export class SandboxBankController {
  private readonly sandbox: SandboxPaymentGatewayProvider | null;

  constructor(@Inject(PAYMENT_GATEWAY) gateway: PaymentGatewayProvider) {
    this.sandbox = gateway instanceof SandboxPaymentGatewayProvider ? gateway : null;
  }

  @Get(':paymentId')
  @ApiOperation({ summary: 'Simulated bank payment page (HTML)', description: 'Shows the order and amount with “Pay” and “Decline” buttons.' })
  @ApiProduces('text/html')
  @ApiResponse({ status: HttpStatus.OK, description: 'HTML page' })
  @ApiNotFoundResponse({ description: 'Sandbox gateway not active, or unknown/expired session' })
  async page(@Param('paymentId', UUID) paymentId: string, @Res() reply: FastifyReply): Promise<void> {
    const session = await this.requireSandbox().sessionByPayment(paymentId);
    if (!session) {
      throw new NotFoundException('Unknown or expired sandbox bank session');
    }
    await reply
      .status(HttpStatus.OK)
      .header('Content-Type', 'text/html; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .header('X-Robots-Tag', 'noindex')
      .send(renderPage(session));
  }

  @Post(':paymentId/decision')
  @SkipAudit() // the resulting callback is audited
  @ApiOperation({
    summary: 'Simulated payer decision',
    description: 'PAY settles the session with a 12-digit RRN, DECLINE fails it; then 303-redirects the browser to the payment callback with Authority and Status=OK|NOK.',
  })
  @ApiResponse({ status: HttpStatus.SEE_OTHER, description: 'Redirect to /api/v1/payments/callback?Authority=…&Status=OK|NOK' })
  @ApiBadRequestResponse({ description: 'decision must be PAY or DECLINE' })
  @ApiNotFoundResponse({ description: 'Sandbox gateway not active, or unknown/expired session' })
  async decide(@Param('paymentId', UUID) paymentId: string, @Body() dto: SandboxDecisionDto, @Res() reply: FastifyReply): Promise<void> {
    try {
      const { redirectTo } = await this.requireSandbox().settle(paymentId, dto.decision);
      await reply.status(HttpStatus.SEE_OTHER).header('Location', redirectTo).header('Cache-Control', 'no-store').send();
    } catch (error) {
      if (error instanceof PaymentGatewayError && error.code === 'SESSION_NOT_FOUND') {
        throw new NotFoundException(error.message);
      }
      throw error;
    }
  }

  private requireSandbox(): SandboxPaymentGatewayProvider {
    if (!this.sandbox) {
      throw new NotFoundException();
    }
    return this.sandbox;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);
}

function renderPage(session: SandboxSession): string {
  const amount = new Intl.NumberFormat('fa-IR').format(Number(session.amount));
  const action = `/api/v1/sandbox/payment-page/${encodeURIComponent(session.paymentId)}/decision`;
  const settled = session.status !== 'AWAITING_PAYER';
  const statusText = session.status === 'PAID' ? 'پرداخت شده' : session.status === 'DECLINED' ? 'رد شده' : 'در انتظار پرداخت';
  const buttons = settled
    ? `<form method="post" action="${action}"><input type="hidden" name="decision" value="PAY"><button class="btn secondary" type="submit">بازگشت به فروشگاه</button></form>`
    : `<form method="post" action="${action}"><input type="hidden" name="decision" value="PAY"><button class="btn pay" type="submit">پرداخت موفق</button></form>
       <form method="post" action="${action}"><input type="hidden" name="decision" value="DECLINE"><button class="btn fail" type="submit">انصراف / پرداخت ناموفق</button></form>`;
  return `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>درگاه پرداخت آزمایشی شاگردم</title>
<style>
  body { margin: 0; font-family: Tahoma, "Segoe UI", sans-serif; background: #f1f5f9; color: #0f172a; }
  .banner { background: #b45309; color: #fff; text-align: center; padding: 10px; font-size: 14px; }
  .card { max-width: 420px; margin: 40px auto; background: #fff; border-radius: 12px; box-shadow: 0 4px 20px rgba(15,23,42,.08); padding: 28px; }
  h1 { font-size: 20px; margin: 0 0 20px; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 10px 16px; margin: 0 0 24px; }
  dt { color: #64748b; } dd { margin: 0; font-weight: bold; direction: ltr; text-align: left; }
  .amount { font-size: 22px; color: #047857; }
  form { margin: 0 0 10px; }
  .btn { width: 100%; border: 0; border-radius: 8px; padding: 14px; font-size: 16px; cursor: pointer; font-family: inherit; }
  .pay { background: #059669; color: #fff; } .fail { background: #e2e8f0; color: #b91c1c; } .secondary { background: #1d4ed8; color: #fff; }
</style>
</head>
<body>
<div class="banner">محیط آزمایشی (SANDBOX) — هیچ پولی جابه‌جا نمی‌شود. این صفحه فقط در محیط توسعه وجود دارد.</div>
<main class="card">
  <h1>درگاه پرداخت آزمایشی</h1>
  <dl>
    <dt>پذیرنده</dt><dd>Shagerdam (sandbox)</dd>
    <dt>شماره سفارش</dt><dd>${escapeHtml(session.orderNumber)}</dd>
    <dt>مبلغ</dt><dd class="amount">${escapeHtml(amount)} ریال</dd>
    <dt>وضعیت</dt><dd>${escapeHtml(statusText)}</dd>
    ${session.bankRrn ? `<dt>شماره مرجع</dt><dd>${escapeHtml(session.bankRrn)}</dd>` : ''}
  </dl>
  ${buttons}
</main>
</body>
</html>`;
}
