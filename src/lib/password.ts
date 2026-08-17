/**
 * Password hashing with scrypt.
 *
 * scrypt over argon2 or bcrypt for one deliberate reason: it ships inside Node's
 * standard library. The alternatives are native modules, and a native module is
 * a build that can fail on a new Node release, a different CPU architecture, or
 * a slim container image — a failure mode that shows up at deploy time, on the
 * one component nobody can work around. scrypt is memory-hard and well
 * understood; the parameters below are the practical cost of a login.
 *
 * Parameters are stored inside the hash string, so raising them later applies to
 * new passwords while existing hashes keep verifying against their own settings.
 */

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const PARAMS = { N: 2 ** 15, r: 8, p: 1 } as const;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

// Node's default maxmem (32 MB) is below what N=2^15, r=8 needs (~64 MB), and
// the resulting error is an opaque "memory limit exceeded" at hash time.
const MAX_MEM = 128 * 1024 * 1024;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scryptAsync(password.normalize('NFKC'), salt, KEY_LENGTH, { ...PARAMS, maxmem: MAX_MEM });
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4]!, 'base64url');
  const expected = Buffer.from(parts[5]!, 'base64url');

  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  const derived = await scryptAsync(password.normalize('NFKC'), salt, expected.length, { N, r, p, maxmem: MAX_MEM });

  // Lengths are equal by construction above, but timingSafeEqual throws rather
  // than returning false on a mismatch, so the guard stays.
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}
