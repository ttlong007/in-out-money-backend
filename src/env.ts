/**
 * Environment parsing.
 *
 * Validated once at startup and exported as a frozen object, so a missing
 * variable fails the process immediately with a readable message instead of
 * surfacing as `undefined` inside a request handler at 2am.
 */

import { z } from 'zod';

const Schema = z.object({
  PORT: z.coerce.number().int().positive().default(8787),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required — see .env.example'),
  JWT_SECRET: z
    .string()
    .min(32, 'JWT_SECRET must be at least 32 characters. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"'),

  // Optional on purpose. The app's offline parser is the primary path; AI
  // categorisation is an enhancement, so a server without a key is a valid
  // deployment rather than a broken one.
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-opus-5'),

  /**
   * Comma-separated origins allowed to call this API from a browser.
   *
   * Empty means "no browser origin" — which is the correct production default,
   * because the real client is a React Native app and sends no Origin header at
   * all. A web build or a devtool needs its origin naming here explicitly.
   */
  CORS_ORIGINS: z.string().default(''),

  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

const parsed = Schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`);
  console.error(`Invalid environment:\n${issues.join('\n')}`);
  process.exit(1);
}

export const env = Object.freeze(parsed.data);

export const aiEnabled = Boolean(env.ANTHROPIC_API_KEY);

export const corsOrigins = env.CORS_ORIGINS.split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
