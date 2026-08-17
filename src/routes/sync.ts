/**
 * Sync: push local changes up, pull remote changes down.
 *
 * The device stays the source of truth. This endpoint is a durable, ordered
 * mailbox between a user's devices — it stores rows and hands them back in the
 * order it received them, and it computes nothing.
 *
 * Conflict resolution is last-write-wins on the client's `updatedAt`. That is a
 * real choice with a real cost: two devices editing the same transaction offline
 * means one edit is discarded, not merged. It is the right trade for this app
 * because the conflicting case is rare (one person, a phone and maybe a tablet)
 * and the alternative — CRDTs or per-field merge — is a large amount of
 * machinery to avoid losing an edit the user is about to notice and redo anyway.
 * The losing version is returned to the client rather than dropped silently, so
 * the app can tell the user something happened.
 */

import { Hono } from 'hono';

import { sql } from '@/db/client';
import { PullRequestSchema, PushRequestSchema, dedupeByLatest, type SyncedRecord } from '@/domain/sync';
import { ApiError } from '@/lib/errors';
import { requireAuth, type AuthVariables } from '@/middleware/auth';

type RecordRow = {
  table_name: string;
  row_id: string;
  payload: Record<string, unknown>;
  updated_at: string;
  deleted_at: string | null;
  server_seq: string;
};

export const syncRoutes = new Hono<{ Variables: AuthVariables }>();

syncRoutes.use('*', requireAuth);

/**
 * `BIGINT` arrives as a string from postgres.js, because a 64-bit integer does
 * not fit a JS number in general. These values do — a sequence counter and epoch
 * milliseconds are both far below 2^53 — so they are converted at this one
 * boundary and are plain numbers everywhere else.
 */
function toRecord(row: RecordRow): SyncedRecord {
  return {
    table: row.table_name as SyncedRecord['table'],
    id: row.row_id,
    payload: row.payload,
    updatedAt: Number(row.updated_at),
    deletedAt: row.deleted_at === null ? null : Number(row.deleted_at),
    serverSeq: Number(row.server_seq),
  };
}

async function sequenceHead(): Promise<number> {
  const [row] = await sql<{ seq: string }[]>`SELECT last_value AS seq FROM sync_seq`;
  return Number(row?.seq ?? 0);
}

/* ------------------------------------------------------------------ *
 * Push
 * ------------------------------------------------------------------ */

syncRoutes.post('/push', async (c) => {
  const parsed = PushRequestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw ApiError.validation('Invalid push payload', parsed.error.issues);

  const userId = c.get('userId');
  const changes = dedupeByLatest(parsed.data.changes);

  if (changes.length === 0) {
    return c.json({ applied: [], conflicts: [], cursor: await sequenceHead() });
  }

  /*
   * Columns are passed as parallel arrays and expanded with UNNEST rather than
   * built as a multi-row VALUES list. One statement either way, but this keeps
   * the parameter count fixed at five regardless of batch size — a 500-row VALUES
   * list is 3000 placeholders, and Postgres caps a statement at 65535.
   */
  const tableNames = changes.map((change) => change.table);
  const rowIds = changes.map((change) => change.id);
  const payloads = changes.map((change) => JSON.stringify(change.payload));
  const updatedAts = changes.map((change) => change.updatedAt);
  const deletedAts = changes.map((change) => change.deletedAt);

  const result = await sql.begin(async (tx) => {
    /*
     * Serialise this user's pushes.
     *
     * Without it two concurrent pushes can be assigned sequence values 5 and 6
     * and commit in the order 6, 5. A device pulling in between sees 6, advances
     * its cursor past 5, and never receives that row — a silent, permanent data
     * loss that reproduces roughly never in testing and eventually in the wild.
     *
     * The lock is per user and released with the transaction, so it costs
     * nothing beyond making one person's own devices take turns.
     */
    await tx`SELECT pg_advisory_xact_lock(hashtext(${userId}))`;

    // The WHERE on DO UPDATE is the conflict rule: an incoming row that is not
    // strictly newer than what is stored updates nothing and is left out of
    // RETURNING, which is how the rejected set is derived below.
    const applied = await tx<{ table_name: string; row_id: string }[]>`
      INSERT INTO sync_records (user_id, table_name, row_id, payload, updated_at, deleted_at)
      SELECT ${userId}::uuid, t.table_name, t.row_id, t.payload::jsonb, t.updated_at, t.deleted_at
        FROM UNNEST(
               ${tableNames}::text[],
               ${rowIds}::text[],
               ${payloads}::text[],
               ${updatedAts}::bigint[],
               ${deletedAts}::bigint[]
             ) AS t(table_name, row_id, payload, updated_at, deleted_at)
      ON CONFLICT (user_id, table_name, row_id) DO UPDATE
         SET payload    = EXCLUDED.payload,
             updated_at = EXCLUDED.updated_at,
             deleted_at = EXCLUDED.deleted_at,
             server_seq = nextval('sync_seq')
       WHERE sync_records.updated_at < EXCLUDED.updated_at
      RETURNING table_name, row_id
    `;

    const appliedKeys = new Set(applied.map((row) => `${row.table_name} ${row.row_id}`));
    const rejected = changes.filter((change) => !appliedKeys.has(`${change.table} ${change.id}`));

    // Hand back the version that won, so the client can overwrite its local copy
    // instead of retrying a push that will keep losing.
    const conflicts = rejected.length
      ? await tx<RecordRow[]>`
          SELECT table_name, row_id, payload, updated_at, deleted_at, server_seq
            FROM sync_records
           WHERE user_id = ${userId}
             AND (table_name, row_id) IN (
                   SELECT * FROM UNNEST(
                     ${rejected.map((change) => change.table)}::text[],
                     ${rejected.map((change) => change.id)}::text[]
                   )
                 )
        `
      : [];

    const [head] = await tx<{ seq: string }[]>`SELECT last_value AS seq FROM sync_seq`;

    return {
      applied: applied.map((row) => ({ table: row.table_name, id: row.row_id })),
      conflicts: conflicts.map(toRecord),
      cursor: Number(head?.seq ?? 0),
    };
  });

  return c.json(result);
});

/* ------------------------------------------------------------------ *
 * Pull
 * ------------------------------------------------------------------ */

syncRoutes.post('/pull', async (c) => {
  const parsed = PullRequestSchema.safeParse((await c.req.json().catch(() => null)) ?? {});
  if (!parsed.success) throw ApiError.validation('Invalid pull payload', parsed.error.issues);

  const { since, limit, tables } = parsed.data;
  const userId = c.get('userId');

  // Null rather than a conditional SQL fragment, so there is one query text and
  // therefore one plan Postgres can cache, whether or not the filter is used.
  const tableFilter = tables?.length ? tables : null;

  const rows = await sql<RecordRow[]>`
    SELECT table_name, row_id, payload, updated_at, deleted_at, server_seq
      FROM sync_records
     WHERE user_id = ${userId}
       AND server_seq > ${since}
       AND (${tableFilter}::text[] IS NULL OR table_name = ANY(${tableFilter}::text[]))
     ORDER BY server_seq ASC
     LIMIT ${limit}
  `;

  const changes = rows.map(toRecord);

  /*
   * The cursor only advances to the last row actually returned. Reporting the
   * sequence head instead would skip anything written between this query and the
   * response — the rows are there, but the client would never ask for them again.
   */
  const cursor = changes.length ? changes[changes.length - 1]!.serverSeq : since;

  return c.json({ changes, cursor, hasMore: changes.length === limit });
});

/* ------------------------------------------------------------------ *
 * Status
 * ------------------------------------------------------------------ */

/** Lets a client show "12 changes waiting" without downloading them. */
syncRoutes.get('/status', async (c) => {
  const userId = c.get('userId');
  const since = Number(c.req.query('since') ?? 0);

  if (!Number.isInteger(since) || since < 0) {
    throw ApiError.validation('`since` must be a non-negative integer');
  }

  const [row] = await sql<{ pending: string; total: string }[]>`
    SELECT COUNT(*) FILTER (WHERE server_seq > ${since}) AS pending,
           COUNT(*)                                      AS total
      FROM sync_records
     WHERE user_id = ${userId}
  `;

  return c.json({ pending: Number(row?.pending ?? 0), total: Number(row?.total ?? 0) });
});
