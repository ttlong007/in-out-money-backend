/**
 * Postgres connection.
 *
 * A module-level singleton pool. postgres.js manages the connections; every
 * query in this codebase goes through `sql`.
 *
 * The connection string is whatever a hosting console handed the operator, and
 * those consoles disagree about what belongs in a URL. Everything below adapts
 * to the string rather than demanding a particular one, because the failure mode
 * for getting it wrong is a deploy that starts cleanly and then cannot talk to
 * its database.
 */

import postgres from 'postgres';

import { env } from '@/env';

/**
 * Parameters that belong to libpq, not to Postgres.
 *
 * `sslmode` and `channel_binding` configure the *client*; Neon puts both in the
 * string it gives you. postgres.js forwards unrecognised query parameters to the
 * server as startup options, where they are rejected with `unrecognized
 * configuration parameter`. Stripping them and configuring TLS through the
 * options object instead means the string can be pasted in unedited.
 */
const CLIENT_ONLY_PARAMS = ['sslmode', 'channel_binding', 'options', 'application_name', 'connect_timeout'];

function cleanUrl(raw: string): string {
  try {
    const url = new URL(raw);
    for (const param of CLIENT_ONLY_PARAMS) url.searchParams.delete(param);
    return url.toString();
  } catch {
    // Not a parseable URL. Hand it to postgres.js unchanged and let its own
    // error say so, rather than masking the problem with one from here.
    return raw;
  }
}

const DATABASE_URL = cleanUrl(env.DATABASE_URL);

/**
 * Managed Postgres (Neon, Supabase, Render) terminates TLS and rejects plain
 * connections, while a local Docker Postgres has no certificate at all. Deciding
 * from the host rather than an extra env var means neither deployment needs a
 * setting the other would get wrong.
 */
const isLocal = /@(localhost|127\.0\.0\.1|host\.docker\.internal|db)[:/]/.test(DATABASE_URL);

/**
 * True when pointed at a connection pooler rather than the database directly.
 *
 * Both Neon and Supabase expose one, and their consoles often default to it.
 * A pooler in transaction mode hands a different backend to each transaction,
 * which breaks the prepared statements postgres.js uses by default — the symptom
 * is an intermittent `prepared statement "xyz" does not exist` under load, which
 * is a miserable thing to debug.
 *
 * Detecting it here means either connection string works. Direct is still the
 * better choice for this server (its pool is three connections, so there is
 * nothing for a pooler to save), but nobody has to know that to deploy.
 */
const isPooled = /-pooler\.|:6543\//.test(DATABASE_URL);

export const sql = postgres(DATABASE_URL, {
  /*
   * Small on purpose.
   *
   * Free Postgres tiers cap connections far below what a default pool assumes,
   * and exhausting them fails every request rather than slowing them down. A
   * single free web instance serving one household needs very few; queueing
   * behind three is invisible, being refused by the database is not.
   */
  max: isLocal ? 10 : 3,

  // Neon and friends scale to zero; the first query after an idle period waits
  // for the compute to wake. The default would give up before that finishes.
  connect_timeout: 30,

  // Free tiers also drop idle connections server-side. Recycling ours first
  // avoids handing a dead socket to the next request.
  idle_timeout: 20,

  // See `isPooled`. Costs a little per-query planning time and buys immunity to
  // the whole class of pooler-related failures.
  ...(isPooled ? { prepare: false } : {}),

  ...(isLocal ? {} : { ssl: 'require' as const }),

  // Dates and bigints come back as strings by default in some configurations.
  // Being explicit here keeps `server_seq` handling in the sync routes honest:
  // it is a bigint in the database and a JS number at the boundary, and the
  // conversion happens in exactly one place (the sync route's row mapper).
  transform: { undefined: null },
  onnotice: env.NODE_ENV === 'development' ? undefined : () => {},
});

export type Sql = typeof sql;

/** Logged once at startup, so a connection problem can be diagnosed from the log alone. */
export function describeConnection(): string {
  const host = (() => {
    try {
      return new URL(DATABASE_URL).host;
    } catch {
      return 'unknown host';
    }
  })();

  return `${host} · ${isLocal ? 'local' : 'tls'} · ${isPooled ? 'pooled (prepare off)' : 'direct'} · max ${isLocal ? 10 : 3}`;
}

export async function closeDatabase(): Promise<void> {
  await sql.end({ timeout: 5 });
}
