/**
 * Access and refresh tokens.
 *
 * Two different things on purpose:
 *
 * - The **access token** is a short-lived JWT. It is verified with a signature
 *   check and no database round trip, which is what keeps the sync endpoints
 *   cheap. The cost of that is that it cannot be revoked before it expires,
 *   hence the short life.
 *
 * - The **refresh token** is a long-lived opaque random string, stored hashed.
 *   It is checked against the database on every use, so logging out a stolen
 *   session actually works. Making this a JWT too would mean a token that
 *   survives revocation for a month, which is the whole problem.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { sign, verify } from 'hono/jwt';

import { env } from '@/env';
import { ApiError } from './errors';

const ACCESS_TTL_SECONDS = 15 * 60;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type AccessPayload = {
  sub: string;
  email: string;
  exp: number;
  iat: number;
};

/**
 * Pinned rather than left to the library default.
 *
 * Naming the algorithm on both sides is what stops an attacker handing us a
 * token whose own header claims `none` or a weaker algorithm and having it
 * honoured — the classic JWT confusion attack.
 */
const ALGORITHM = 'HS256' as const;

export async function issueAccessToken(userId: string, email: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return sign({ sub: userId, email, iat: now, exp: now + ACCESS_TTL_SECONDS }, env.JWT_SECRET, ALGORITHM);
}

export async function verifyAccessToken(token: string): Promise<AccessPayload> {
  try {
    return (await verify(token, env.JWT_SECRET, ALGORITHM)) as AccessPayload;
  } catch {
    // hono/jwt distinguishes expiry from a bad signature, but the client's
    // reaction is identical — refresh, then retry — so both collapse to one code.
    throw new ApiError('token_expired', 401, 'Access token is invalid or expired');
  }
}

/** Returns the token to hand out and the hash to store. The raw value is never persisted. */
export function createRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(48).toString('base64url');
  return { token, hash: hashRefreshToken(token) };
}

export function hashRefreshToken(token: string): string {
  // SHA-256 rather than scrypt: this is a 48-byte random value, not a
  // user-chosen password, so there is no dictionary to slow an attacker down to
  // and no reason to pay scrypt's cost on every token refresh.
  return createHash('sha256').update(token).digest('base64url');
}

export function refreshTokensMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export const ACCESS_TTL = ACCESS_TTL_SECONDS;
