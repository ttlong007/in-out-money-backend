/**
 * Server entry point.
 */

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';

import { closeDatabase, describeConnection, sql } from '@/db/client';
import { migrate } from '@/db/migrate';
import { aiEnabled, corsOrigins, env } from '@/env';
import { errorResponse } from '@/lib/errors';
import { aiRoutes } from '@/routes/ai';
import { authRoutes } from '@/routes/auth';
import { syncRoutes } from '@/routes/sync';
import { aiRateLimit, authRateLimit, syncRateLimit } from '@/middleware/rateLimit';
import type { AuthVariables } from '@/middleware/auth';

const app = new Hono<{ Variables: AuthVariables }>();

app.use('*', logger());

/*
 * A React Native app is not a browser and sends no Origin header, so CORS is
 * irrelevant to the real client — it exists only for a browser devtool or a web
 * build. In development anything is allowed; in production the allowlist is
 * empty unless CORS_ORIGINS names something, which is the safe default for an
 * API whose only legitimate caller is not a browser.
 */
app.use(
  '*',
  cors({
    origin: (origin) => {
      if (env.NODE_ENV !== 'production') return origin ?? '*';
      return corsOrigins.includes(origin) ? origin : null;
    },
    allowHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86400,
  }),
);

app.onError((error, c) => errorResponse(c, error));
app.notFound((c) => c.json({ error: { code: 'not_found', message: 'No such route' } }, 404));

/** Liveness plus a real database round trip, so a half-up server reports unhealthy. */
app.get('/health', async (c) => {
  try {
    await sql`SELECT 1`;
    return c.json({ ok: true, database: 'up', ai: aiEnabled ? 'configured' : 'disabled' });
  } catch {
    return c.json({ ok: false, database: 'down', ai: aiEnabled ? 'configured' : 'disabled' }, 503);
  }
});

// Rate limits go on before the routes so a rejected request never reaches
// scrypt or the Anthropic API — the two things that actually cost something.
app.use('/v1/auth/*', authRateLimit);
app.use('/v1/sync/*', syncRateLimit);
app.use('/v1/ai/*', aiRateLimit);

app.route('/v1/auth', authRoutes);
app.route('/v1/sync', syncRoutes);
app.route('/v1/ai', aiRoutes);

async function main(): Promise<void> {
  await migrate();

  const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
    console.log(`\n  in-out-money backend`);
    console.log(`  http://localhost:${info.port}`);
    console.log(`  db: ${describeConnection()}`);
    console.log(`  ai: ${aiEnabled ? 'configured' : 'disabled (offline parser only)'}\n`);
  });

  // Finish in-flight requests before dropping the pool, so a deploy does not
  // fail a sync push that was mid-transaction.
  const shutdown = async (signal: string) => {
    console.log(`\n[${signal}] shutting down…`);
    server.close();
    await closeDatabase();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  console.error('[startup] failed:', error);
  process.exit(1);
});
