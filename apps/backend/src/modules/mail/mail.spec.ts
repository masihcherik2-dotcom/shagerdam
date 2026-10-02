import type { HttpException } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import { SMTPServer, type SMTPServerAuthentication, type SMTPServerSession } from 'smtp-server';
import { EmailService } from './email.service';
import { MailDeliveryError, type MailMessage, type MailProvider } from './mail-provider.interface';
import { SandboxMailProvider } from './providers/sandbox-mail.provider';
import { SmtpMailProvider } from './providers/smtp-mail.provider';
import { renderOtpEmail } from './templates/otp-email.template';

describe('renderOtpEmail', () => {
  it('builds a Persian RTL message whose only digits in the text body are the code', () => {
    const mail = renderOtpEmail({ to: 'sara@gmail.com', code: '04821', expiresInSeconds: 120 });
    expect(mail.to).toBe('sara@gmail.com');
    expect(mail.subject).toBe('کد ورود به شاگردم');
    expect(mail.text.match(/\d+/g)).toEqual(['04821']);
    expect(mail.text).toContain('۲ دقیقه');
    expect(mail.html).toContain('dir="rtl"');
    expect(mail.html).toContain('>04821<');
    expect(mail.html).not.toMatch(/<link|<script|<style/);
  });

  it('shows seconds when the lifetime is not whole minutes, and refuses a malformed code', () => {
    expect(renderOtpEmail({ to: 'a@b.ir', code: '1234', expiresInSeconds: 90 }).text).toContain('۹۰ ثانیه');
    expect(() => renderOtpEmail({ to: 'a@b.ir', code: '<b>1</b>', expiresInSeconds: 120 })).toThrow(/malformed code/);
  });
});

describe('SandboxMailProvider', () => {
  const message: MailMessage = renderOtpEmail({ to: 'sara@gmail.com', code: '55555', expiresInSeconds: 120 });

  it('keeps messages in memory, exposes the latest code per recipient and never delivers', async () => {
    const provider = new SandboxMailProvider(false);
    expect(provider.isTestProvider).toBe(true);
    await provider.send(message);
    await provider.send(renderOtpEmail({ to: 'sara@gmail.com', code: '66666', expiresInSeconds: 120 }));
    const result = await provider.send(renderOtpEmail({ to: 'other@gmail.com', code: '77777', expiresInSeconds: 120 }));
    expect(result).toMatchObject({ provider: 'sandbox', status: 'sent' });
    expect(result.messageId).toMatch(/^MAIL-SBX-/);
    expect(provider.latestCode('sara@gmail.com')).toBe('66666');
    expect(provider.recent(10, 'sara@gmail.com')).toHaveLength(2);
    expect(provider.latestCode('nobody@gmail.com')).toBeUndefined();
  });
});

describe('EmailService', () => {
  it('is disabled without a provider and answers 503 EMAIL_NOT_CONFIGURED', async () => {
    const service = new EmailService(null);
    expect(service.describe()).toEqual({ enabled: false, provider: 'none', isTestProvider: false });
    await expect(service.sendOtp('a@b.ir', '12345', 120, 'email_login')).rejects.toMatchObject({ status: 503, response: { code: 'EMAIL_NOT_CONFIGURED' } });
  });

  it('turns provider failures into 502 EMAIL_DELIVERY_FAILED without leaking the SMTP detail', async () => {
    const failing: MailProvider = { kind: 'smtp', isTestProvider: false, send: () => Promise.reject(new MailDeliveryError('smtp', 'auth', 'SMTP smtp.gmail.com EAUTH 535 5.7.8 Username and Password not accepted')) };
    const error = (await new EmailService(failing).sendOtp('a@b.ir', '12345', 120, 'email_login').catch((caught: unknown) => caught)) as HttpException;
    expect(error.getStatus()).toBe(502);
    expect(error.getResponse()).toMatchObject({ code: 'EMAIL_DELIVERY_FAILED' });
    expect(JSON.stringify(error.getResponse())).not.toMatch(/535|Password|gmail/);
  });
});

describe('SmtpMailProvider (against a real local SMTP server)', () => {
  interface Received {
    from: string | undefined;
    to: string[];
    raw: string;
    user: string | undefined;
  }
  let server: SMTPServer;
  let port: number;
  const received: Received[] = [];

  beforeAll(async () => {
    server = new SMTPServer({
      authOptional: false,
      disabledCommands: ['STARTTLS'],
      logger: false,
      onAuth(auth: SMTPServerAuthentication, _session: SMTPServerSession, callback): void {
        if (auth.username === 'shop@gmail.com' && auth.password === 'app-password-16ch') {
          callback(null, { user: auth.username });
          return;
        }
        callback(Object.assign(new Error('Invalid login'), { responseCode: 535 }));
      },
      onRcptTo(address, _session, callback): void {
        if (address.address.endsWith('@blocked.example')) {
          callback(Object.assign(new Error('Mailbox unavailable'), { responseCode: 550 }));
          return;
        }
        callback();
      },
      onData(stream, session, callback): void {
        const chunks: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', () => {
          received.push({
            from: session.envelope.mailFrom ? session.envelope.mailFrom.address : undefined,
            to: session.envelope.rcptTo.map((rcpt) => rcpt.address),
            raw: Buffer.concat(chunks).toString('utf8'),
            user: typeof session.user === 'string' ? session.user : undefined,
          });
          callback();
        });
      },
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const provider = (overrides: Partial<ConstructorParameters<typeof SmtpMailProvider>[0]> = {}): SmtpMailProvider =>
    new SmtpMailProvider({ host: '127.0.0.1', port, secure: false, user: 'shop@gmail.com', pass: 'app-password-16ch', from: 'شاگردم <shop@gmail.com>', requireTls: false, ...overrides });

  it('authenticates and delivers the code e-mail with sender, recipient and auto-reply suppression', async () => {
    const smtp = provider();
    const result = await smtp.send(renderOtpEmail({ to: 'sara@gmail.com', code: '31415', expiresInSeconds: 120 }));
    smtp.close();
    expect(result.provider).toBe('smtp');
    expect(result.messageId).toMatch(/^<.+>$/);
    const mail = received.at(-1)!;
    expect(mail.user).toBe('shop@gmail.com');
    expect(mail.from).toBe('shop@gmail.com');
    expect(mail.to).toEqual(['sara@gmail.com']);
    expect(mail.raw).toMatch(/^Auto-Submitted: auto-generated/m);
    expect(mail.raw).toMatch(/^Content-Type: multipart\/alternative/m);
    expect(mail.raw).toContain('31415');
  });

  it('reports a wrong password as an auth failure', async () => {
    const smtp = provider({ pass: 'wrong' });
    await expect(smtp.send(renderOtpEmail({ to: 'sara@gmail.com', code: '31415', expiresInSeconds: 120 }))).rejects.toMatchObject({ name: 'MailDeliveryError', reason: 'auth' });
    smtp.close();
  });

  it('reports a refused recipient as rejected', async () => {
    const smtp = provider();
    await expect(smtp.send(renderOtpEmail({ to: 'x@blocked.example', code: '31415', expiresInSeconds: 120 }))).rejects.toMatchObject({ reason: 'rejected' });
    smtp.close();
  });

  it('refuses to send in clear text when TLS is required and the server cannot upgrade', async () => {
    const smtp = provider({ requireTls: true });
    await expect(smtp.send(renderOtpEmail({ to: 'sara@gmail.com', code: '31415', expiresInSeconds: 120 }))).rejects.toBeInstanceOf(MailDeliveryError);
    smtp.close();
  });

  it('reports an unreachable server as unavailable', async () => {
    const smtp = provider({ port: 1 });
    await expect(smtp.send(renderOtpEmail({ to: 'sara@gmail.com', code: '31415', expiresInSeconds: 120 }))).rejects.toMatchObject({ reason: 'unavailable' });
    smtp.close();
  });
});
