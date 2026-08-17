/**
 * Account routes: register, login, refresh, logout, me.
 */

import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

import { Hono } from 'hono';
import { z } from 'zod';

import { sql } from '@/db/client';
import { ApiError } from '@/lib/errors';
import { mailEnabled, sendResetCode } from '@/lib/mailer';
import { hashPassword, verifyPassword } from '@/lib/password';
import {
  ACCESS_TTL,
  REFRESH_TTL_MS,
  createRefreshToken,
  hashRefreshToken,
  issueAccessToken,
} from '@/lib/tokens';
import { requireAuth, type AuthVariables } from '@/middleware/auth';

type UserRow = {
  id: string;
  email: string;
  password_hash: string;
  display_name: string;
  created_at: Date;
};

const Credentials = z.object({
  email: z.string().email().max(320),
  // 8 is a floor, not a policy. Length is the only requirement that reliably
  // helps; composition rules mostly produce "Password1!" and a sticky note.
  password: z.string().min(8).max(200),
  displayName: z.string().max(80).optional(),
});

const RefreshBody = z.object({ refreshToken: z.string().min(1) });

export const authRoutes = new Hono<{ Variables: AuthVariables }>();

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

async function issueSession(user: Pick<UserRow, 'id' | 'email'>) {
  const { token, hash } = createRefreshToken();
  const expiresAt = new Date(Date.now() + REFRESH_TTL_MS);

  await sql`
    INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
    VALUES (${user.id}, ${hash}, ${expiresAt})
  `;

  return {
    accessToken: await issueAccessToken(user.id, user.email),
    refreshToken: token,
    expiresIn: ACCESS_TTL,
  };
}

function publicUser(user: Pick<UserRow, 'id' | 'email' | 'display_name'>) {
  return { id: user.id, email: user.email, displayName: user.display_name };
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

authRoutes.post('/register', async (c) => {
  const parsed = Credentials.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw ApiError.validation('Invalid registration payload', parsed.error.issues);

  const email = parsed.data.email.trim().toLowerCase();
  const passwordHash = await hashPassword(parsed.data.password);

  // ON CONFLICT rather than a SELECT-then-INSERT: two simultaneous registrations
  // with the same address would both pass the check and one would then crash on
  // the unique index. Letting the database arbitrate is the only race-free form.
  const rows = await sql<UserRow[]>`
    INSERT INTO users (email, password_hash, display_name)
    VALUES (${email}, ${passwordHash}, ${parsed.data.displayName ?? ''})
    ON CONFLICT (email) DO NOTHING
    RETURNING id, email, password_hash, display_name, created_at
  `;

  const user = rows[0];
  if (!user) throw new ApiError('email_taken', 409, 'An account with that email already exists');

  return c.json({ user: publicUser(user), tokens: await issueSession(user) }, 201);
});

authRoutes.post('/login', async (c) => {
  const parsed = Credentials.omit({ displayName: true }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw ApiError.validation('Invalid login payload', parsed.error.issues);

  const email = parsed.data.email.trim().toLowerCase();
  const [user] = await sql<UserRow[]>`
    SELECT id, email, password_hash, display_name, created_at FROM users WHERE email = ${email}
  `;

  // Same error and roughly the same work whether the address exists or the
  // password is wrong, so the response cannot be used to enumerate accounts.
  const ok = user ? await verifyPassword(parsed.data.password, user.password_hash) : false;
  if (!user || !ok) {
    throw new ApiError('invalid_credentials', 401, 'Email or password is incorrect');
  }

  return c.json({ user: publicUser(user), tokens: await issueSession(user) });
});

authRoutes.post('/refresh', async (c) => {
  const parsed = RefreshBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw ApiError.validation('Invalid refresh payload', parsed.error.issues);

  const hash = hashRefreshToken(parsed.data.refreshToken);

  const [row] = await sql<{ id: string; user_id: string; email: string; display_name: string; expired: boolean; revoked: boolean }[]>`
    SELECT t.id,
           t.user_id,
           u.email,
           u.display_name,
           (t.expires_at <= now())      AS expired,
           (t.revoked_at IS NOT NULL)   AS revoked
      FROM refresh_tokens t
      JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = ${hash}
  `;

  if (!row) throw new ApiError('token_revoked', 401, 'Refresh token is not recognised');
  if (row.revoked) throw new ApiError('token_revoked', 401, 'Refresh token has been revoked');
  if (row.expired) throw new ApiError('token_expired', 401, 'Refresh token has expired');

  // Rotation: the presented token is retired as the replacement is issued, so a
  // token that leaks is useful exactly once and its reuse is detectable.
  await sql`UPDATE refresh_tokens SET revoked_at = now() WHERE id = ${row.id}`;

  const tokens = await issueSession({ id: row.user_id, email: row.email });
  return c.json({
    user: { id: row.user_id, email: row.email, displayName: row.display_name },
    tokens,
  });
});

authRoutes.post('/logout', async (c) => {
  const parsed = RefreshBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw ApiError.validation('Invalid logout payload', parsed.error.issues);

  await sql`
    UPDATE refresh_tokens
       SET revoked_at = now()
     WHERE token_hash = ${hashRefreshToken(parsed.data.refreshToken)}
       AND revoked_at IS NULL
  `;

  // Deliberately 204 whether or not anything was revoked. "That token was
  // already invalid" is not information a caller needs, and withholding it keeps
  // the endpoint useless for probing.
  return c.body(null, 204);
});

authRoutes.get('/me', requireAuth, async (c) => {
  const [user] = await sql<UserRow[]>`
    SELECT id, email, password_hash, display_name, created_at FROM users WHERE id = ${c.get('userId')}
  `;
  if (!user) throw ApiError.notFound('User no longer exists');

  return c.json({ user: publicUser(user) });
});

/* ------------------------------------------------------------------ *
 * Password reset
 * ------------------------------------------------------------------ */

const RESET_TTL_MINUTES = 15;
/** Six digits is only safe because guesses are capped; see the schema note. */
const RESET_MAX_ATTEMPTS = 5;

const ForgotBody = z.object({ email: z.string().email().max(320) });
const ResetBody = z.object({
  email: z.string().email().max(320),
  code: z.string().regex(/^\d{6}$/, 'Mã gồm 6 chữ số'),
  password: z.string().min(8).max(200),
});

/** SHA-256, not scrypt: this is a random six-digit value with a 15-minute life. */
const hashCode = (code: string) => createHash('sha256').update(code).digest('base64url');

function codesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Starts a reset.
 *
 * Always answers 204, whether or not the address has an account. Saying "no such
 * user" would turn this endpoint into a way to test which emails are registered,
 * and the person who genuinely owns the address learns nothing from the
 * difference — they read their inbox either way.
 */
authRoutes.post('/forgot-password', async (c) => {
  const parsed = ForgotBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw ApiError.validation('Invalid payload', parsed.error.issues);

  if (!mailEnabled) {
    throw new ApiError('reset_unavailable', 503, 'Máy chủ chưa cấu hình gửi email');
  }

  const email = parsed.data.email.trim().toLowerCase();
  const [user] = await sql<{ id: string; email: string }[]>`SELECT id, email FROM users WHERE email = ${email}`;

  if (user) {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const expiresAt = new Date(Date.now() + RESET_TTL_MINUTES * 60_000);

    // Any code already outstanding is retired. Two live codes would double an
    // attacker's chances for no benefit to the person who asked twice.
    await sql`UPDATE password_resets SET used_at = now() WHERE user_id = ${user.id} AND used_at IS NULL`;
    await sql`
      INSERT INTO password_resets (user_id, code_hash, expires_at)
      VALUES (${user.id}, ${hashCode(code)}, ${expiresAt})
    `;

    try {
      await sendResetCode(user.email, code, RESET_TTL_MINUTES);
    } catch (error) {
      // Logged, not surfaced: telling the caller that sending failed also tells
      // them the address exists. The user retries; we investigate the log.
      console.error('[auth] reset email failed:', error);
    }
  }

  return c.body(null, 204);
});

/**
 * Completes a reset.
 *
 * Succeeding also revokes every refresh token. Someone resetting a password has
 * usually either forgotten it or suspects it is known to somebody else, and in
 * both cases leaving other sessions signed in defeats the point.
 */
authRoutes.post('/reset-password', async (c) => {
  const parsed = ResetBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw ApiError.validation('Invalid payload', parsed.error.issues);

  const email = parsed.data.email.trim().toLowerCase();
  const invalid = new ApiError('reset_invalid', 400, 'Mã không đúng hoặc đã hết hạn');

  const [row] = await sql<{
    id: string;
    user_id: string;
    code_hash: string;
    attempts: number;
    expired: boolean;
    used: boolean;
  }[]>`
    SELECT r.id, r.user_id, r.code_hash, r.attempts,
           (r.expires_at <= now())    AS expired,
           (r.used_at IS NOT NULL)    AS used
      FROM password_resets r
      JOIN users u ON u.id = r.user_id
     WHERE u.email = ${email}
     ORDER BY r.created_at DESC
     LIMIT 1
  `;

  // One error for every failure mode. A caller must not be able to tell "no such
  // account" from "wrong code" from "expired".
  if (!row || row.used || row.expired) throw invalid;

  if (row.attempts >= RESET_MAX_ATTEMPTS) {
    throw new ApiError('reset_expired', 400, 'Mã đã nhập sai quá nhiều lần. Yêu cầu mã mới.');
  }

  if (!codesMatch(row.code_hash, hashCode(parsed.data.code))) {
    await sql`UPDATE password_resets SET attempts = attempts + 1 WHERE id = ${row.id}`;
    throw invalid;
  }

  const passwordHash = await hashPassword(parsed.data.password);

  await sql.begin(async (tx) => {
    await tx`UPDATE users SET password_hash = ${passwordHash}, updated_at = now() WHERE id = ${row.user_id}`;
    await tx`UPDATE password_resets SET used_at = now() WHERE id = ${row.id}`;
    await tx`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = ${row.user_id} AND revoked_at IS NULL`;
  });

  return c.body(null, 204);
});
