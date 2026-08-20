/**
 * The sync contract.
 *
 * This is the one piece of shape the app and the server must agree on. Keep it
 * boring and additive — a client running an older build has to keep syncing
 * against a newer server, and the App Store makes "just update both" impossible.
 */

import { createHash } from 'node:crypto';

import { z } from 'zod';

/**
 * Tables the server will accept rows for.
 *
 * A whitelist rather than "any string", so a bug in a client cannot fill the
 * table with junk namespaces that nothing will ever read or clean up.
 *
 * Adding a table here is a server change; adding a *column* to an existing table
 * is not, because the row is stored whole. That asymmetry is the point — new
 * fields ship with the app, new entities ship with the server.
 */
export const SYNC_TABLES = [
  'wallets',
  'categories',
  'transactions',
  'budgets',
  'saving_goals',
  'saving_goal_contributions',
  'recurring_rules',
  'groups',
  'group_members',
  'splits',
  'jars',
  'jar_allocations',
  // Appearance choices that belong to the person: the accent colour and the
  // light/dark preference. This is the table the note below prescribed.
  'preferences',
  // `settings` is deliberately absent. It holds this device's sync cursor, and
  // syncing that would hand device B device A's cursor — B would skip every row
  // between the two and never ask for them again. Preferences that genuinely
  // should follow a user (theme, default wallet) live in `preferences` above,
  // which carries only keys that mean the same thing on every device; that is a
  // feature, not an oversight to fix by adding `settings` here.
] as const;

export type SyncTable = (typeof SYNC_TABLES)[number];

/**
 * A short fingerprint of the accepted-table list, for `/health`.
 *
 * The client and the server have to agree on this list, and when they disagree
 * the whole push fails validation — but nothing outside the process could tell
 * which version of the list was actually running. Diagnosing a rejected push
 * then means guessing whether a deploy has landed yet, which is how an already
 * fixed and pushed whitelist looked identical to a broken one for several
 * minutes.
 *
 * A digest rather than the names themselves: it answers "is the running code the
 * code I pushed" without publishing the internal schema on an open endpoint.
 */
export const SYNC_CONTRACT = createHash('sha256').update(SYNC_TABLES.join(',')).digest('hex').slice(0, 8);

/** Guards against one oversized row wedging a client's whole push forever. */
const MAX_PAYLOAD_BYTES = 256 * 1024;

export const SyncRecordSchema = z.object({
  table: z.enum(SYNC_TABLES),
  /** The client-generated id. Also the primary key on the device. */
  id: z.string().min(1).max(200),
  /** The full domain object, camelCase, exactly as the device holds it. */
  payload: z
    .record(z.string(), z.unknown())
    .refine((value) => JSON.stringify(value).length <= MAX_PAYLOAD_BYTES, {
      message: `Payload exceeds ${MAX_PAYLOAD_BYTES} bytes`,
    }),
  /** Client clock, epoch ms. Decides which version of a row wins. */
  updatedAt: z.number().int().nonnegative(),
  /** Epoch ms when tombstoned, else null. Deletes sync like any other change. */
  deletedAt: z.number().int().nonnegative().nullable().default(null),
});

export type SyncRecord = z.infer<typeof SyncRecordSchema>;

/**
 * A push is capped so one request cannot hold the per-user lock for minutes on a
 * first sync. A client with more than this pushes in several batches, which is
 * also what makes progress reporting possible on its side.
 */
export const MAX_PUSH_RECORDS = 500;

export const PushRequestSchema = z.object({
  changes: z.array(SyncRecordSchema).max(MAX_PUSH_RECORDS),
});

export const DEFAULT_PULL_LIMIT = 500;
export const MAX_PULL_LIMIT = 1000;

export const PullRequestSchema = z.object({
  /** Highest `serverSeq` this device has already stored. 0 for a first sync. */
  since: z.number().int().nonnegative().default(0),
  limit: z.number().int().positive().max(MAX_PULL_LIMIT).default(DEFAULT_PULL_LIMIT),
  /** Optional narrowing, e.g. pulling only wallets to render a first screen. */
  tables: z.array(z.enum(SYNC_TABLES)).optional(),
});

/** What a pull hands back. `serverSeq` becomes the client's next cursor. */
export type SyncedRecord = SyncRecord & { serverSeq: number };

/**
 * Collapses duplicate ids within one push, keeping the newest.
 *
 * Postgres refuses an `ON CONFLICT DO UPDATE` that would touch the same row
 * twice in a single statement, and a client that edited a row twice between
 * syncs will legitimately send it twice. Resolving that here rather than
 * rejecting the batch keeps a normal offline session from failing to sync.
 */
export function dedupeByLatest(changes: SyncRecord[]): SyncRecord[] {
  const newest = new Map<string, SyncRecord>();

  for (const change of changes) {
    const key = `${change.table}\u0000${change.id}`;
    const existing = newest.get(key);
    if (!existing || change.updatedAt >= existing.updatedAt) newest.set(key, change);
  }

  return [...newest.values()];
}
