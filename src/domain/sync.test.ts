import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PushRequestSchema, SYNC_CONTRACT, SYNC_TABLES, dedupeByLatest, type SyncRecord } from './sync';

const record = (table: string, id: string, updatedAt: number): SyncRecord =>
  ({ table, id, payload: { id }, updatedAt, deletedAt: null }) as SyncRecord;

describe('SYNC_TABLES', () => {
  it('accepts the tables the app pushes', () => {
    for (const table of ['wallets', 'categories', 'transactions', 'preferences']) {
      assert.ok((SYNC_TABLES as readonly string[]).includes(table), `missing ${table}`);
    }
  });

  it('still refuses settings, which holds a device-local sync cursor', () => {
    assert.ok(!(SYNC_TABLES as readonly string[]).includes('settings'));
  });

  it('rejects an unknown table, and with it the whole batch', () => {
    // The behaviour that made a client-only table change break all syncing:
    // one bad name fails the request, not just the offending record.
    const parsed = PushRequestSchema.safeParse({
      changes: [record('wallets', 'w1', 1), record('made_up', 'x', 1)],
    });
    assert.equal(parsed.success, false);
  });
});

describe('SYNC_CONTRACT', () => {
  it('is a short hex digest', () => {
    assert.match(SYNC_CONTRACT, /^[0-9a-f]{8}$/);
  });

  it('changes when the accepted-table list changes', async () => {
    // The whole point: a deployed server reports this on /health, so the list
    // it is actually running can be compared against the list that was pushed.
    // Recomputed here the same way rather than hardcoded, so adding a table is
    // not a test failure — only a digest that ignores the list would be.
    const { createHash } = await import('node:crypto');
    const expected = createHash('sha256').update(SYNC_TABLES.join(',')).digest('hex').slice(0, 8);
    const different = createHash('sha256').update([...SYNC_TABLES, 'extra'].join(',')).digest('hex').slice(0, 8);
    assert.equal(SYNC_CONTRACT, expected);
    assert.notEqual(SYNC_CONTRACT, different);
  });
});

describe('dedupeByLatest', () => {
  it('keeps the newest version of a repeated row', () => {
    const result = dedupeByLatest([record('wallets', 'w1', 1), record('wallets', 'w1', 9)]);
    assert.equal(result.length, 1);
    assert.equal(result[0]?.updatedAt, 9);
  });

  it('keeps the later record when timestamps tie', () => {
    const first = record('wallets', 'w1', 5);
    const second = { ...record('wallets', 'w1', 5), payload: { id: 'w1', name: 'second' } };
    assert.deepEqual(dedupeByLatest([first, second])[0]?.payload, { id: 'w1', name: 'second' });
  });

  /*
   * The composite key is `table` + U+0000 + `id`. NUL is the separator because
   * it cannot occur in either half, so no id can be crafted that collides with
   * another table's row.
   *
   * In `sync.ts` it is written as a `\u0000` escape rather than as a literal
   * NUL byte. The byte form was indistinguishable from a space on screen, made
   * git treat this whole file as binary, and made grep silently report no
   * matches in it — which is how it came to be believed that grep itself was
   * broken on this machine.
   */
  it('does not confuse the same id in two different tables', () => {
    const result = dedupeByLatest([record('wallets', 'same', 1), record('jars', 'same', 1)]);
    assert.equal(result.length, 2);
  });

  it('separates rows that would collide under a weaker separator', () => {
    // 'wallets' + 'x' must not be reachable by any other (table, id) pair.
    const result = dedupeByLatest([record('wallets', 'x', 1), record('wallets', 'x', 2)]);
    assert.equal(result.length, 1);

    const spread = dedupeByLatest([record('wallets', 'a', 1), record('wallets', 'b', 1)]);
    assert.equal(spread.length, 2);
  });

  it('passes an empty batch through', () => {
    assert.deepEqual(dedupeByLatest([]), []);
  });
});
