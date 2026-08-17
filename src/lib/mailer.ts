/**
 * Outgoing email, over Gmail SMTP.
 *
 * Optional, like the AI key: a server with no SMTP credentials still runs, and
 * the password-reset endpoint reports that recovery is unavailable rather than
 * failing in a way the caller has to guess about.
 *
 * Gmail needs an **app password**, not the account password — generated at
 * myaccount.google.com/apppasswords with two-factor authentication turned on.
 * Its own limit is roughly 500 messages a day, which is far beyond what password
 * recovery for a household app produces.
 */

import nodemailer from 'nodemailer';

import { env } from '@/env';

export const mailEnabled = Boolean(env.SMTP_USER && env.SMTP_PASS);

/**
 * Built once, lazily.
 *
 * nodemailer pools connections, so creating a transport per message would open a
 * new TLS session to Gmail every time — slow, and a good way to be rate limited
 * for something other than volume.
 */
let transport: nodemailer.Transporter | null = null;

function getTransport(): nodemailer.Transporter | null {
  if (!mailEnabled) return null;

  transport ??= nodemailer.createTransport({
    service: 'gmail',
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    pool: true,
    maxConnections: 1,
  });

  return transport;
}

/**
 * Sends the reset code.
 *
 * Both a plain-text and an HTML body: some clients render neither well, and a
 * six-digit code that arrives as an unreadable blob is worse than no email.
 */
export async function sendResetCode(to: string, code: string, expiresInMinutes: number): Promise<void> {
  const mailer = getTransport();
  if (!mailer) throw new Error('SMTP is not configured');

  const text = [
    'Mã đặt lại mật khẩu In/Out Money của bạn:',
    '',
    `    ${code}`,
    '',
    `Mã có hiệu lực trong ${expiresInMinutes} phút và chỉ dùng được một lần.`,
    '',
    'Nếu bạn không yêu cầu đặt lại mật khẩu, bỏ qua email này — mật khẩu hiện tại vẫn giữ nguyên.',
  ].join('\n');

  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:420px;margin:0 auto;padding:24px">
      <p style="font-size:15px;color:#111">Mã đặt lại mật khẩu <strong>In/Out Money</strong> của bạn:</p>
      <p style="font-size:34px;font-weight:700;letter-spacing:8px;text-align:center;
                background:#f4f2ff;color:#4a3ad0;border-radius:12px;padding:18px 0;margin:20px 0">${code}</p>
      <p style="font-size:13px;color:#555">Mã có hiệu lực trong ${expiresInMinutes} phút và chỉ dùng được một lần.</p>
      <p style="font-size:13px;color:#888">Nếu bạn không yêu cầu đặt lại mật khẩu, bỏ qua email này — mật khẩu hiện tại vẫn giữ nguyên.</p>
    </div>
  `;

  await mailer.sendMail({
    from: `In/Out Money <${env.SMTP_USER}>`,
    to,
    subject: `${code} là mã đặt lại mật khẩu của bạn`,
    text,
    html,
  });
}
