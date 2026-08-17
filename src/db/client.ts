/**
 * Postgres connection.
 *
 * A module-level singleton pool. postgres.js manages the connections; every
 * query in this codebase goes through `sql`.
 */

import postgres from 'postgres';

import { env } from '@/env';

/**
 * Managed Postgres (Neon, Supabase, Render) terminates TLS and rejects plain
 * connections, while a local Docker Postgres has no certificate at all. Deciding
 * from the host rather than an extra env var means neither deployment needs a
 * setting the other would get wrong.
 */
const isLocal = /@(localhost|127\.0\.0\.1|host\.docker\.internal|db)[:/]/.test(env.DATABASE_URL);

export const sql = postgres(env.DATABASE_URL, {
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

  ...(isLocal ? {} : { ssl: 'require' as const }),
  // Dates and bigints come back as strings by default in some configurations.
  // Being explicit here keeps `server_seq` handling in the sync routes honest:
  // it is a bigint in the database and a JS number at the boundary, and the
  // conversion happens in exactly one place (the sync route's row mapper).
  transform: { undefined: null },
  onnotice: env.NODE_ENV === 'development' ? undefined : () => {},
});

export type Sql = typeof sql;

export async function closeDatabase(): Promise<void> {
  await sql.end({ timeout: 5 });
}
