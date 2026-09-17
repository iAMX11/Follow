/**
 * Wire types of the server's `/sync` endpoints. They mirror the `sync` module of the client
 * SDK, so the apps hand `followApi.sync` to the store through `syncApiContext`.
 */

export type SyncActionModelName =
  | "subscription"
  | "list_subscription"
  | "collection"
  | "timeline"
  | "list"
  | "inbox"
  | "inbox_entry"

export type SyncActionType = "I" | "U" | "D" | "N"

export interface SyncAction {
  /** Global, monotonically increasing sync id */
  id: number
  model: SyncActionModelName
  /** feedId, listId or entryId; null for batch timeline updates */
  modelId: string | null
  action: SyncActionType
  data: unknown
  createdAt: string
}

export interface SyncStateResponse {
  code: 0
  data: {
    lastSyncId: number
  }
}

export interface SyncDeltaQuery {
  lastSyncId: number
  limit?: number
}

export interface SyncDeltaResponse {
  code: 0
  data: {
    actions: SyncAction[]
    lastSyncId: number
    hasMore: boolean
    /** The cursor predates the retained log; fetch a fresh snapshot and start over */
    reset: boolean
  }
}

export interface SyncAPI {
  state: () => Promise<SyncStateResponse>
  delta: (query: SyncDeltaQuery) => Promise<SyncDeltaResponse>
}

export interface TimelineReadActionData {
  entryIds: string[]
  read: boolean
  isInbox?: boolean
}

export interface TimelineNewEntriesActionData {
  /** Set for entries delivered by a feed or a list */
  feedId?: string
  /** Set together with `isInbox` for entries delivered to an inbox */
  inboxId?: string
  isInbox?: boolean
  count: number
  latestPublishedAt: string
  from: string[]
  entryIds?: string[]
}

export interface ListActionData {
  title?: string
  description?: string | null
  image?: string | null
  view?: number
  fee?: number
  feedIds?: string[]
}

export interface InboxEntryActionData {
  inboxId?: string
}

export interface CollectionActionData {
  entryId: string
  feedId: string
  view: number
  createdAt: string
}
