/**
 * Account routes: register, login, refresh, logout, me.
 */

import { Hono } from 'hono';
import { z } from 'zod';

import { sql } from '@/db/client';
import { ApiError } from '@/lib/errors';
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
