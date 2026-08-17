/**
 * Database schema and migrations.
 *
 * Same rule as the mobile app's schema: migrations are an append-only list keyed
 * by a version number. Never edit a migration that has run somewhere — edit
 * produces two different schemas in the wild with no way to tell them apart.
 * Add a new entry instead.
 */

export const LATEST_VERSION = 2;

export type Migration = {
  version: number;
  /** Statements run inside a single transaction, in order. */
  statements: string[];
};

/*
 * Version 1 — accounts and the sync log.
 *
 * ## Why sync rows are stored as opaque JSON
 *
 * The obvious design mirrors every client table (wallets, transactions, jars…)
 * as a real Postgres table with real columns. That is the right shape *once the
 * server needs to query inside a row* — group splitting will, because two people
 * must see the same split. It is the wrong shape today, for one reason:
 *
 *   The app's schema is still moving. It gained jars in v2 and saving-goal
 *   contributions in v3.
 *
 * With mirrored columns, every app migration needs a matching server migration
 * deployed in lockstep, or sync breaks for anyone who updated their app first —
 * and app updates roll out through the App Store, which no backend deploy can
 * synchronise with. Storing the row whole means a client can add a column and
 * keep syncing against a server that has never heard of it.
 *
 * The cost is real and worth stating: the server cannot filter, aggregate, or
 * enforce foreign keys on this data. It is a courier, not an accountant. Every
 * balance, budget and split is computed on the device.
 *
 * The promotion path when that stops being enough: add a real table for that one
 * entity, dual-write it from the push handler, backfill from `payload`, then move
 * reads over. Nothing here has to be torn down first.
 *
 * ## Why `server_seq` and not `updated_at` as the pull cursor
 *
 * Client clocks are wrong — often by minutes, occasionally by years. A cursor
 * based on the client's `updated_at` silently skips rows written by a device
 * whose clock runs behind. `server_seq` is assigned here, on commit, and is the
 * only value in this table the server actually trusts.
 */
const V1 = `
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  display_name  TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Emails are lowercased before they reach the database, so a plain unique index
-- is enough and the citext extension is not needed.
CREATE UNIQUE INDEX idx_users_email ON users(email);

CREATE TABLE refresh_tokens (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The raw token is never stored. A database dump must not be enough to
  -- impersonate a user, which is the whole point of hashing it.
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_refresh_hash ON refresh_tokens(token_hash);
CREATE INDEX idx_refresh_user ON refresh_tokens(user_id) WHERE revoked_at IS NULL;

-- Assigned on every write. Global rather than per-user: the pull query is
-- already filtered by user_id, so gaps in a single user's sequence are harmless.
CREATE SEQUENCE sync_seq;

CREATE TABLE sync_records (
  user_id    UUID   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  table_name TEXT   NOT NULL,
  row_id     TEXT   NOT NULL,
  payload    JSONB  NOT NULL,
  -- The client's clock. Used only to decide which of two versions of a row wins;
  -- never used to order the pull stream. See the note above.
  updated_at BIGINT NOT NULL,
  deleted_at BIGINT,
  -- Defaulted so a multi-row INSERT ... ON CONFLICT can omit the column and
  -- still give every row its own value; the update branch calls nextval again.
  server_seq BIGINT NOT NULL DEFAULT nextval('sync_seq'),
  PRIMARY KEY (user_id, table_name, row_id)
);

-- The pull query, exactly: everything for this user above a cursor, in order.
CREATE INDEX idx_sync_pull ON sync_records(user_id, server_seq);
`;

/*
 * Version 2 — password resets.
 *
 * A six-digit code rather than a link. A link has to survive being opened on a
 * different device from the one running the app, which means universal links,
 * an association file, and a failure mode where the address bar wins and the
 * user stares at a website. A code is read on any device and typed into the app
 * that is already open.
 *
 * The code is stored hashed for the same reason the refresh token is: a database
 * dump must not be enough to take over an account. `attempts` is what makes six
 * digits safe — a million combinations is nothing to a script, so the code dies
 * after five wrong guesses rather than relying on its own length.
 */
const V2 = `
CREATE TABLE password_resets (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_reset_user ON password_resets(user_id, created_at DESC);
`;

export const MIGRATIONS: Migration[] = [
  { version: 1, statements: splitStatements(V1) },
  { version: 2, statements: splitStatements(V2) },
];

/**
 * Splits a SQL blob into statements on `;`, ignoring semicolons that are inside
 * a comment or a string literal.
 *
 * A plain `sql.split(';')` looks adequate and is not. A `;` in an ordinary
 * English sentence inside a `--` comment cuts the surrounding CREATE TABLE in
 * half, and the resulting error points at a syntax position in a fragment that
 * appears nowhere in the source file. This function exists because that happened
 * while writing the migration above.
 */
function splitStatements(sql: string): string[] {
  // Dollar-quoted bodies (`$$ … $$`, `$tag$ … $tag$`) are not handled. They only
  // appear in PL/pgSQL, which no migration here uses; failing loudly is better
  // than mis-splitting one silently later.
  if (/\$[A-Za-z_]*\$/.test(sql)) {
    throw new Error('splitStatements does not support dollar-quoted bodies — run that statement separately.');
  }

  const statements: string[] = [];
  let current = '';
  let index = 0;

  while (index < sql.length) {
    const char = sql[index]!;
    const next = sql[index + 1];

    // `-- …` to end of line.
    if (char === '-' && next === '-') {
      const newline = sql.indexOf('\n', index);
      const stop = newline === -1 ? sql.length : newline;
      current += sql.slice(index, stop);
      index = stop;
      continue;
    }

    // `/* … */`, which Postgres allows to nest but migrations here do not.
    if (char === '/' && next === '*') {
      const close = sql.indexOf('*/', index + 2);
      const stop = close === -1 ? sql.length : close + 2;
      current += sql.slice(index, stop);
      index = stop;
      continue;
    }

    // `'…'`, where a literal quote is written as `''`.
    if (char === "'") {
      let cursor = index + 1;
      while (cursor < sql.length) {
        if (sql[cursor] === "'" && sql[cursor + 1] === "'") {
          cursor += 2;
          continue;
        }
        if (sql[cursor] === "'") {
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      current += sql.slice(index, cursor);
      index = cursor;
      continue;
    }

    if (char === ';') {
      statements.push(current);
      current = '';
      index += 1;
      continue;
    }

    current += char;
    index += 1;
  }

  statements.push(current);

  return statements.map((statement) => statement.trim()).filter((statement) => statement.length > 0);
}
