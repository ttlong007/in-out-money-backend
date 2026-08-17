/**
 * Migration runner.
 *
 * Mirrors the mobile app's approach: a version number recorded in the database,
 * and every pending migration applied in order inside its own transaction. Run
 * with `npm run migrate`; also invoked at startup so a fresh clone works after
 * `npm run db:up && npm run dev`.
 */

import { LATEST_VERSION, MIGRATIONS } from './schema';
import { closeDatabase, sql } from './client';

/** Arbitrary constant. Any concurrent migrator blocks here rather than racing. */
const MIGRATION_LOCK_ID = 947_223_001;

export async function migrate(): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_version (
      version    INTEGER     NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  // Two processes starting at once (a dev server and a `npm run migrate`, or two
  // instances rolling out) would otherwise both see version 0 and both try to
  // CREATE TABLE. The advisory lock is released when the session ends.
  await sql`SELECT pg_advisory_lock(${MIGRATION_LOCK_ID})`;

  try {
    const [row] = await sql<{ version: number }[]>`
      SELECT COALESCE(MAX(version), 0) AS version FROM schema_version
    `;
    const current = row?.version ?? 0;

    if (current >= LATEST_VERSION) {
      console.log(`[migrate] up to date (version ${current})`);
      return;
    }

    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue;

      console.log(`[migrate] applying version ${migration.version}…`);
      await sql.begin(async (tx) => {
        for (const statement of migration.statements) {
          await tx.unsafe(statement);
        }
        await tx`INSERT INTO schema_version (version) VALUES (${migration.version})`;
      });
      console.log(`[migrate] version ${migration.version} applied`);
    }
  } finally {
    await sql`SELECT pg_advisory_unlock(${MIGRATION_LOCK_ID})`;
  }
}

// Allow running this file directly: `npm run migrate`.
if (import.meta.url === `file://${process.argv[1]}`) {
  migrate()
    .then(() => closeDatabase())
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      console.error('[migrate] failed:', error);
      process.exit(1);
    });
}
