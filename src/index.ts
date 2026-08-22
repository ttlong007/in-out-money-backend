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
import { SYNC_CONTRACT } from '@/domain/sync';
import { errorResponse } from '@/lib/errors';
import { aiRoutes } from '@/routes/ai';
import { authRoutes } from '@/routes/auth';
import { syncRoutes } from '@/routes/sync';
import { aiRateLimit, authRateLimit, syncRateLimit } from '@/middleware/rateLimit';
import type { AuthVariables } from '@/middleware/auth';

const app = new Hono<{ Variables: AuthVariables }>();

app.use('*', logger());

/*
 * There is now a browser client, and this comment used to say there was not.
 *
 * The phone app sends no Origin header at all, so CORS never applied to it and
 * an empty allowlist was the right production default. The PWA changed that: it
 * runs on its own origin and every request it makes is preflighted, so a login
 * from the web fails with "no Access-Control-Allow-Origin" until CORS_ORIGINS
 * names that origin — which looks from the app like a button that does nothing.
 *
 * Still an allowlist rather than `*`. Sync carries a Bearer token, and any
 * origin being allowed to call this API is a different security posture than
 * naming the one that should.
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

/**
 * Whether migrations have finished. Set once, never unset.
 *
 * Requests are answered before this is true, but only to say so — see the guard
 * on `/v1/*` below.
 */
let migrated = false;
let migrationError: string | null = null;

/**
 * Always answers while the process is listening, and says what is wrong in the
 * body rather than by refusing to exist.
 *
 * This used to return 503 when the database was unreachable, on the reasoning
 * that a server with a dead database should report itself unhealthy so the host
 * restarts it. That reasoning had a hole: the process exited if the *first*
 * connection failed, so it never reached the point of listening, and the one
 * endpoint built to explain a database problem could never be asked. The
 * symptom was hours of an opaque 502 from the host's proxy with no way to tell a
 * dead database from a failed build from an exhausted quota.
 *
 * Restarting does not fix an unreachable database anyway. Staying up and saying
 * which of the two is broken does.
 */
app.get('/health', async (c) => {
  let database: 'up' | 'down' = 'down';
  try {
    await sql`SELECT 1`;
    database = 'up';
  } catch {
    database = 'down';
  }

  return c.json({
    ok: database === 'up' && migrated,
    database,
    migrated,
    // Named, not a stack: enough to act on, and it never carries a connection
    // string because `migrate` failures are reported by message only.
    migrationError,
    ai: aiEnabled ? 'configured' : 'disabled',
    contract: SYNC_CONTRACT,
  });
});

// Rate limits go on before the routes so a rejected request never reaches
// scrypt or the Anthropic API — the two things that actually cost something.
app.use('/v1/auth/*', authRateLimit);
app.use('/v1/sync/*', syncRateLimit);
app.use('/v1/ai/*', aiRateLimit);

/*
 * Nothing touches the schema until it is known to be the right shape.
 *
 * The port opens before migrations finish, so this is what stops a request
 * reaching a half-migrated table. A 503 with a code the client already
 * understands, rather than a query against columns that may not exist yet.
 */
app.use('/v1/*', async (c, next) => {
  if (!migrated) {
    return c.json(
      { error: { code: 'internal_error', message: 'Server is still starting up', details: { migrationError } } },
      503,
    );
  }
  return next();
});

app.route('/v1/auth', authRoutes);
app.route('/v1/sync', syncRoutes);
app.route('/v1/ai', aiRoutes);

/**
 * Runs migrations, retrying until they succeed.
 *
 * Separated from startup so a database that is briefly unreachable — asleep,
 * rate-limited, mid-failover — costs a delay rather than the whole service. It
 * previously ran before `serve`, with a failure exiting the process: one bad
 * moment at boot and the host had nothing to route to, indefinitely, with no
 * endpoint left to explain why.
 *
 * Backs off to a ceiling rather than growing without bound, because the thing
 * being waited for usually comes back and should be picked up promptly when it
 * does.
 */
async function migrateWhenPossible(): Promise<void> {
  const CEILING_MS = 30_000;
  let attempt = 0;

  for (;;) {
    try {
      await migrate();
      migrated = true;
      migrationError = null;
      console.log('[startup] migrations applied');
      return;
    } catch (error: unknown) {
      attempt += 1;
      migrationError = error instanceof Error ? error.message : String(error);
      const wait = Math.min(CEILING_MS, 1000 * 2 ** Math.min(attempt, 5));

      console.error(`[startup] migration attempt ${attempt} failed, retrying in ${wait}ms:`, migrationError);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

async function main(): Promise<void> {
  // Listening first is the whole point: the host can reach /health, and a
  // database problem is reportable instead of invisible.
  const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
    console.log(`\n  in-out-money backend`);
    console.log(`  http://localhost:${info.port}`);
    console.log(`  db: ${describeConnection()}`);
    console.log(`  ai: ${aiEnabled ? 'configured' : 'disabled (offline parser only)'}\n`);
  });

  void migrateWhenPossible();

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
