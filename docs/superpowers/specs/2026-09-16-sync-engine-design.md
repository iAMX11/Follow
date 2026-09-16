# Sync Engine Design

## Summary

This document maps the design of Linear's sync engine (as reverse-engineered in
[wzhudev/reverse-linear-sync-engine](https://github.com/wzhudev/reverse-linear-sync-engine))
onto Folo, evaluates which parts of it fit a feed reader, and lays out a phased plan for
the client (`Folo`) and the server (`follow-server`).

Phase 1 (client transaction queue) is implemented in this branch. Phases 2 and 3 need
server changes and are specified here so they can be picked up without re-deriving the
design.

## How Linear does it

Linear's client keeps a full copy of the workspace in IndexedDB and never writes to it
from user actions. The moving parts:

- **Sync id.** Every server-side write gets a monotonically increasing integer. The
  client stores `lastSyncId`, the highest id it has applied. Clients that share the same
  `lastSyncId` hold the same state.
- **Bootstrap.** A first launch downloads a JSONL snapshot plus `lastSyncId`. Later
  launches load from IndexedDB and ask the server for everything after `lastSyncId`
  ("local bootstrap"), so there is no full refetch.
- **Delta packets.** After bootstrap a WebSocket streams sync actions:
  `{ id, modelName, modelId, action: "I" | "U" | "D" | "A" | "V" | "C" | "G" | "S", data }`.
  Each packet advances `lastSyncId`; a gap means missed packets and triggers a catch-up.
- **Transactions.** User actions become transactions. The in-memory model is updated at
  once (optimistic), the transaction is serialized into an IndexedDB `_transaction` table,
  queued, batched, and sent as a GraphQL mutation. The mutation response carries the
  `lastSyncId` it produced; the transaction stays in `completedButUnsyncedTransactions`
  until that packet arrives. Unsent transactions are replayed after a restart.
- **Rebase.** When a delta touches a model with pending transactions, the server value
  becomes the transaction's new `original` and the local intent is re-applied on top
  (last writer wins, no operational transform).
- **Sync groups.** The server only sends packets for groups the user is subscribed to
  (their user id, their teams). Joining a team triggers a partial bootstrap of that group.
- **Partial and lazy models.** Large collections (comments, documents) are loaded on demand
  through partial indexes so the local database stays bounded.

## Where Folo stands today

Folo already has the skeleton of this architecture:

| Linear                    | Folo today                                                                    | Gap                                                                     |
| ------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Object pool + MobX models | Zustand stores per module (`@follow/store`)                                   | Equivalent                                                              |
| IndexedDB tables          | SQLite via Drizzle (`@follow/database`), one table per model                  | Equivalent                                                              |
| Local bootstrap           | `hydrateDatabaseToStore` loads SQLite into the stores on launch               | Equivalent                                                              |
| Transaction               | `createTransaction()` with `store` / `request` / `rollback` / `persist`       | Not persisted, not ordered, not retried                                 |
| `_transaction` table      | none                                                                          | Offline mutations and mutations pending at exit are lost                |
| Rebase                    | `LOCAL_READ_PROTECTION_WINDOW` (30 s timer per entry)                         | Heuristic; covers only read marks; fails past 30 s                      |
| `lastSyncId`              | none                                                                          | No way to know what changed since the last fetch                        |
| Delta packets             | none; `/entries/check-new` is deprecated and returns `false`                  | Everything is polling of full snapshots                                 |
| Bootstrap snapshot        | `/subscriptions`, `/reads`, `/entries` fetched separately with TanStack Query | Subscriptions and unread counts are replaced wholesale on every refetch |
| Sync groups               | Per-user `timeline` rows on the server                                        | Equivalent concept; no change feed                                      |

The consequences show up as workarounds spread over the client:

- `feedUnreadDirty` atoms force unread-only lists to refetch after a read mark.
- `useSyncUnreadWhenUnMatch` refetches all unread counts whenever local entries disagree
  with the count map.
- `InvalidateQueryProvider` invalidates every query when the window becomes visible after
  ten minutes.
- `subscriptionSyncService.fetch()` resets the subscription store before upserting.
- The server keeps 24 cache tags per user for subscriptions and invalidates them by hand.

## What to take from Linear, and what not to

Take:

- The transaction queue: persisted, ordered, batched, retried, rolled back only on a
  definitive rejection, with pending intent replayed on top of server data.
- The sync id and a per-user change log, so a client can ask "what changed since X" for
  the models it owns.
- Local bootstrap plus catch-up instead of full refetch on every launch.
- A push channel that tells clients a change happened, with HTTP catch-up as the source
  of truth.

Leave:

- Loading the whole workspace. Folo's entries are unbounded and mostly server-generated;
  the current cursor-paginated `timeline` queries are the right shape and stay as they are.
- Per-entry sync actions from the crawler. A feed refresh can fan out to thousands of
  subscribers; the change log must record "feed X delivered N entries to user U" rather
  than one action per timeline row.
- MobX decorators and a generic model registry. Folo has a handful of user-owned models
  (subscription, read state, collection, unread count); explicit transaction kinds are
  simpler than a metadata-driven engine.

## Phase 1: client transaction queue (implemented)

### Goals

- Read marks, unread marks, mark-all and star/unstar survive a restart and an offline
  period, and are sent in order once the network is back.
- A server snapshot fetched while a mutation is in flight can no longer undo it.
- Adjacent mutations of the same kind go to the server in one request.

### Design

`packages/internal/store/src/sync/transaction-queue.ts` is the queue. A transaction kind
declares:

```ts
interface TransactionKind<P, R> {
  kind: string
  apply(payload: P): void // optimistic, idempotent, replayed on restart
  rollback(payload: P): void | Promise<void> // only on a definitive server rejection
  execute(payloads: P[]): Promise<R> // one request for a batch
  persist?(payloads: P[], result: R) // write confirmed state to SQLite
  batchKey?(payload: P): string // adjacent transactions with equal keys batch
  overlays?(payload: P): { key; value }[] // local intent per resource, for rebase
  rebaseUnread?(payload: P, counts) // re-apply the unread delta on a server snapshot
  ackGraceMs?: number // keep overlays after the ack (replica lag)
}
```

Lifecycle:

1. `enqueue(kind, payload)` runs `apply`, appends the record to the in-memory queue, and
   inserts it into the `sync_transactions` SQLite table (migration `0038`). It resolves
   once the intent is recorded, not when the server acknowledges it.
2. A flush runs 100 ms later, or immediately on `resume()` (network back, app foregrounded).
   The head of the queue is expanded into a batch of adjacent records with the same kind
   and batch key and sent with a single `execute` call.
3. On success `persist` writes the confirmed state, the rows are deleted from the outbox,
   and the records stay visible through `getOverlays()` for `ackGraceMs` (30 s by default)
   to cover the server's read-replica lag.
4. Transport errors, timeouts, 5xx and 429 are retried with exponential backoff up to eight
   attempts. A 401 pauses the queue until the next trigger. Any other 4xx is definitive:
   `rollback` runs, the rows are deleted, and `onFailure` listeners are notified.
5. `restore()` runs after `hydrateDatabaseToStore`: rows left in the outbox are replayed
   with `apply` on top of the hydrated stores and queued for sending. Rows of unknown kinds
   are dropped.

The database only ever holds server-confirmed state. Optimistic effects live in memory and
are re-derived from the outbox on restart, which is Linear's rule that transactions never
write to the local tables directly.

Rebase happens at two read points:

- `entryActions.upsertManyInSession` consults the `entry-read:<id>` overlay and keeps the
  local read flag for entries with a pending or just-acknowledged mark.
- `unreadActions.upsertManyInSession({ fromRemote: true })` subtracts the deltas of
  pending transactions from the counts that came from the server.
- `collectionActions.reconcileFromRemote` keeps pending stars and unstars when the entry
  list response disagrees.

Transaction kinds in this phase: `reads.mark-entries-read`, `reads.mark-entry-unread`,
`reads.mark-all-read`, `collections.star`, `collections.unstar`.

### What changed for callers

- `unreadSyncService.markEntriesAsRead` and friends resolve after the intent is recorded.
  `queueEntriesAsRead` is kept as an alias; the queue batches on its own.
- `entryActions.clearLocalReadProtectionInSession` and the 30 s window are gone.
- `collectionActions.reconcileFromRemote` replaces the `upsertMany` + `delete` pair in
  `fetchEntries`.
- Logging out clears the outbox: the desktop deletes the database, the mobile app deletes
  the database file, and `resetStore` resets the queue.

### Not in this phase

- Subscription edits (`subscriptionSyncService.edit`, `batchUpdateSubscription`, category
  rename/delete) still use `createTransaction`. Their forms await the server response to
  close, so moving them needs a failure toast wired through `transactionQueue.onFailure`.
- Surfacing definitive failures in the UI. The queue emits them; nothing renders them yet.

## Phase 2: server change log and delta catch-up

### Goals

- Replace "refetch everything on focus" with "fetch what changed since `lastSyncId`".
- Remove `feedUnreadDirty`, `useSyncUnreadWhenUnMatch` and the subscription reset.
- Let mutations return a sync id so the client knows when its own change is visible.

### Data model

A per-user, append-only change log in Postgres:

```sql
create sequence sync_action_id_seq;

create table sync_actions (
  id         bigint primary key default nextval('sync_action_id_seq'),
  user_id    text   not null references "user"(id) on delete cascade,
  model      text   not null,   -- 'subscription' | 'list_subscription' | 'inbox' | 'timeline' | 'collection' | 'unread'
  model_id   text   not null,   -- feedId / listId / inboxId / entryId
  action     text   not null,   -- 'I' | 'U' | 'D' | 'N'
  data       jsonb,
  created_at timestamptz not null default now()
);

create index sync_actions_user_id_id_idx on sync_actions (user_id, id);
```

The sequence is global, like Linear's `lastSyncId`, so ids are comparable across users and
the client never needs to know which writer produced them. Rows older than the timeline
retention window (14 or 28 days) are deleted by the cleaner; a client whose `lastSyncId`
predates the oldest row must bootstrap again.

Action semantics:

| model               | action          | data                                         | produced by                                                                        |
| ------------------- | --------------- | -------------------------------------------- | ---------------------------------------------------------------------------------- |
| `subscription`      | `I` / `U` / `D` | the subscription row (with feed for `I`)     | `/subscriptions` post, patch, batch, delete; `/categories`                         |
| `list_subscription` | `I` / `U` / `D` | the list subscription row                    | `/subscriptions`, `/lists`                                                         |
| `inbox`             | `I` / `U` / `D` | the inbox row                                | `/inboxes`                                                                         |
| `collection`        | `I` / `D`       | `{ entryId, feedId, view, createdAt }`       | `/collections`                                                                     |
| `timeline`          | `U`             | `{ entryIds, read }`                         | `/reads` post, delete, post-all (post-all lists the affected ids in chunks of 500) |
| `timeline`          | `N`             | `{ feedId, count, latestPublishedAt, from }` | crawler fan-out, one row per (user, feed) per refresh that inserted rows           |

The `N` action ("new entries arrived") is the coalesced form of Linear's `I` for timeline
rows. It is enough for the client to bump the unread count, mark the feed as having new
content, and refetch the visible list if that feed is on screen. The entries themselves
keep coming through the existing paginated `/entries` endpoint, which stays the source of
entry content.

Writers call one helper inside the same transaction as the write they describe:

```ts
recordSyncActions(tx, userId, actions: Array<{ model, modelId, action, data }>)
```

For the crawler fan-out (`chunkInsertTimeline` in `services/feed.ts`), the helper runs
after the timeline insert with one `N` row per user in the chunk. This is the hot path;
the extra insert is one row per subscriber per refresh, an order of magnitude below the
timeline rows already written.

### Routes

Both the Node app (`routes/sync/*.ts`) and the Worker (`routes/sync/index.worker.ts`)
need the routes, following the pattern of the existing groups. Add `/sync` to
`migratedWorkerRouteGroups`.

`GET /sync/bootstrap`

Returns everything the client needs in one round trip:

```json
{
  "code": 0,
  "data": {
    "lastSyncId": 123456,
    "subscriptions": [...],   // same shape as GET /subscriptions
    "unread": { "feedId": 3 } // same shape as GET /reads
  }
}
```

The client stores `lastSyncId` in a new `sync_meta` SQLite table (key/value) next to the
snapshot it just applied.

`GET /sync/delta?lastSyncId=123456&limit=1000`

```json
{
  "code": 0,
  "data": {
    "actions": [
      { "id": 123457, "model": "timeline", "modelId": "feed-1", "action": "N", "data": { "feedId": "feed-1", "count": 4, "latestPublishedAt": "...", "from": ["feed"] } },
      { "id": 123458, "model": "subscription", "modelId": "feed-2", "action": "U", "data": { ... } }
    ],
    "lastSyncId": 123458,
    "hasMore": false,
    "reset": false
  }
}
```

`reset: true` is returned when `lastSyncId` is older than the oldest row for the user;
the client then calls `/sync/bootstrap` again.

Mutation responses gain `lastSyncId` (the highest id they produced). The client uses it
to close the "completed but unsynced" window exactly instead of the 30 s grace: a
transaction is settled once the delta stream has passed its `lastSyncId`.

### Client

- `sync/sync-engine.ts` in `@follow/store`: `bootstrap()`, `pull()` (loop on `hasMore`),
  `applyActions()` dispatching by model to the existing `*Actions.upsertManyInSession`
  and `delete*InSession` methods, then `transactionQueue.rebase()`.
- `pull()` runs on launch after `restore()`, on `online`/foreground, after every own
  mutation ack, and on a 60 s interval while the window is visible. This replaces the
  10-minute `InvalidateQueryProvider` sweep for user-owned models. Entry list queries keep
  their own staleness rules.
- Remove `feedUnreadDirty` and `useSyncUnreadWhenUnMatch` once `N` and `timeline U`
  actions drive unread counts.
- `subscriptionSyncService.fetch()` becomes the bootstrap path only.

## Phase 3: push channel

Linear pushes deltas over a WebSocket. On Cloudflare the equivalent is a per-user Durable
Object with the WebSocket hibernation API, which the AI chat stream already uses
(`AiChatStreamDurableObject`). The server does not need to push the actions themselves: a
`{ "lastSyncId": 123458 }` poke is enough, and the client runs `pull()`. This keeps the
HTTP delta endpoint as the only source of truth and makes reconnects trivial.

Mobile keeps the existing FCM channel (`sendNewEntryNotification`) and adds a silent data
message with the same poke so background fetches can catch up.

## Rollout notes

- Phase 1 needs no server change and can ship on its own.
- Phase 2 can ship the change log writers first (dark launch), then the routes, then the
  client. The client falls back to today's full refetch when `/sync/*` is unavailable.
- `sync_actions` grows with user activity, not with crawl volume, because timeline inserts
  are coalesced. Expected volume is well under one row per timeline insert.

## Open questions

- Whether `N` actions should carry the new entry ids (bounded to, say, 50) so the client can
  avoid a list refetch when the feed is on screen.
- Whether list subscriptions and inbox entries need their own `N` actions or can reuse the
  feed one with `from`.
- Retention of `sync_actions` for paid users beyond the timeline window.
