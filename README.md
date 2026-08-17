# in-out-money — backend

Sync and AI backend for the In/Out Money app.

## What this server is, and is not

The app is **local-first**. Every balance, budget, jar split and report is computed
on the device against its own SQLite database, and the app works completely
offline. This server does two jobs and no others:

1. **Sync** — a durable, ordered mailbox between one user's devices. It stores
   rows and hands them back in the order it received them. It computes nothing.
2. **AI extraction** — turns one Vietnamese sentence into several draft
   transactions, which the on-device rule parser cannot do. Optional; the app
   falls back to that parser whenever this is unavailable.

It is deliberately **not** the source of truth. If this server is down, the app
keeps working; the only thing a user loses is sync between devices.

## Requirements

- Node 22+
- Docker (for Postgres) — or any Postgres 14+ reachable via `DATABASE_URL`

## Running locally

```bash
cp .env.example .env

# JWT_SECRET is required and has no default.
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
# paste into .env

npm install
npm run db:up      # Postgres on port 55432
npm run dev        # migrates on boot, then serves on :8787
```

Verify:

```bash
curl localhost:8787/health
# {"ok":true,"database":"up","ai":"disabled"}

npm run smoke      # 30 end-to-end checks against a running server
```

`ANTHROPIC_API_KEY` is optional. Without it the server runs normally and
`/v1/ai/*` returns `503 ai_unavailable`, which the app treats as "use the
offline parser" — the same path it takes with no network.

## API

All responses are JSON. Errors are `{ "error": { "code", "message", "details"? } }`,
and clients should branch on `code`, never on `message`.

### Auth

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/v1/auth/register` | `{ email, password, displayName? }` | 201; `password` min 8 |
| POST | `/v1/auth/login` | `{ email, password }` | |
| POST | `/v1/auth/refresh` | `{ refreshToken }` | Rotates: the presented token is revoked |
| POST | `/v1/auth/logout` | `{ refreshToken }` | 204 whether or not it was valid |
| GET | `/v1/auth/me` | — | Bearer |

Access tokens are JWTs valid for 15 minutes and are verified without touching the
database. Refresh tokens are opaque, stored hashed, valid 30 days, and revocable.

### Sync

Everything below is Bearer-authenticated and scoped to the calling user.

**`POST /v1/sync/push`**

```jsonc
{ "changes": [ {
    "table": "transactions",     // must be in the whitelist in src/domain/sync.ts
    "id": "uuid-from-the-device",
    "payload": { },              // the whole domain object, camelCase
    "updatedAt": 1755244800000,  // client clock, epoch ms
    "deletedAt": null            // set to tombstone
} ] }
```

→ `{ applied: [{table, id}], conflicts: [record], cursor }`

A record whose `updatedAt` is not strictly newer than the stored one is
**rejected**, and the stored version is returned in `conflicts` so the client can
overwrite its local copy rather than retry a push that will keep losing.

Max 500 records per push. Duplicate ids within one batch are collapsed to the
newest rather than rejected — a client that edited a row twice between syncs
legitimately sends it twice.

**`POST /v1/sync/pull`**

```jsonc
{ "since": 0, "limit": 500, "tables": ["wallets"] }   // tables optional
```

→ `{ changes: [record & {serverSeq}], cursor, hasMore }`

Store `cursor` and pass it as the next `since`. Loop while `hasMore`.

**`GET /v1/sync/status?since=N`** → `{ pending, total }`, for a badge without
downloading anything.

### AI

**`POST /v1/ai/categorize`**

```jsonc
{
  "text": "Hôm nay đi chợ hết 50k, ăn uống 100k, đổ xăng 90k",
  "categories": [ { "id": "cat_food_groceries", "name": "Đi chợ, siêu thị", "kind": "expense" } ],
  "now": 1755244800000,
  "currency": "VND"
}
```

→ `{ transactions: [{ categoryId, kind, amountMinor, note, occurredAt, confidence }], usage }`

The client sends **its own** category list, because users create their own
categories and the server cannot know them. This also means no category taxonomy
is duplicated between the two repos to drift apart.

The server drops any transaction whose `categoryId` was not in the list it was
given, and takes `kind` from that list rather than from the model — a model that
labels a salary category as an expense must not be able to invert a report.

Only send multi-transaction utterances here. Single transactions are handled by
the on-device parser: free, instant, offline.

## Design decisions worth knowing

**Sync rows are stored as opaque JSON, not mirrored columns.** The app's schema
is still moving (jars arrived in v2, saving-goal contributions in v3). Mirrored
columns would mean every app migration needs a matching server deploy in
lockstep — impossible when app updates ship through the App Store. Storing the
row whole lets a client add a column and keep syncing against a server that has
never heard of it. The cost is that the server cannot filter or aggregate this
data. See the long note in `src/db/schema.ts`.

**`server_seq`, not `updated_at`, is the pull cursor.** Client clocks are wrong,
often by minutes. A cursor based on client time silently skips rows written by a
device whose clock runs behind.

**Pushes are serialised per user with an advisory lock.** Without it two
concurrent pushes can be assigned sequence values 5 and 6 and commit in the order
6, 5 — a device pulling in between advances its cursor past 5 and never receives
that row. Silent, permanent, and reproduces roughly never in testing.

**Conflict resolution is last-write-wins.** Two devices editing the same
transaction offline means one edit is discarded rather than merged. That is the
right trade here — one person with a phone and maybe a tablet — and the losing
version is returned rather than dropped silently.

**Passwords use scrypt from Node's standard library**, not argon2 or bcrypt.
Those are native modules, and a native build can fail on a new Node release, a
different CPU architecture, or a slim container image — at deploy time, on the
one component nobody can work around.

## Deploying

Nothing here is tied to a host. Set `DATABASE_URL`, `JWT_SECRET`, and
`ANTHROPIC_API_KEY` as environment variables and run `npm start`; migrations run
on boot. The server binds every interface and reads `PORT`, which is what
Render, Fly and Railway all expect.

Before exposing it publicly:

- [ ] Restrict CORS in `src/index.ts` (currently `*` for local development)
- [ ] Put rate limiting in front of `/v1/auth/*` and `/v1/ai/*`
- [ ] Set up TLS termination
- [ ] Schedule cleanup of expired rows in `refresh_tokens`

### Pointing the app at the deployed server

The app must not ask a user to type a server address — that field exists only
because a LAN IP changes between machines. Bake the address into the build
instead:

```bash
# in the app repo
EXPO_PUBLIC_SYNC_URL=https://your-service.onrender.com npx expo prebuild --platform android
cd android && ./gradlew assembleRelease
```

Expo inlines any `EXPO_PUBLIC_*` variable into the bundle at build time. With one
set, the app hides the server field entirely and users see only email and
password. Seven taps on the "Đồng bộ" title reveals it again, for pointing a
build at staging.

Once the address is `https://`, drop the Android cleartext exemption — remove the
`expo-build-properties` block from the app's `app.json`. It was only ever there
so a release build could reach a plain-HTTP server on the LAN, and leaving it on
lets any future `http://` call through silently.
