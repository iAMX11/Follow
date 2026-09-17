import { FeedViewType } from "@follow/constants"
import { EntryService } from "@follow/database/services/entry"
import { InboxService } from "@follow/database/services/inbox"
import { ListService } from "@follow/database/services/list"
import { SubscriptionService } from "@follow/database/services/subscription"
import { SyncMetaService } from "@follow/database/services/sync-meta"
import { FollowAPIError } from "@follow-app/client-sdk"

import { syncApi } from "../context"
import type { Resetable } from "../lib/base"
import { collectionActions } from "../modules/collection/store"
import { invalidateEntriesQuery } from "../modules/entry/hooks"
import { entryActions } from "../modules/entry/store"
import { setFeedUnreadDirty } from "../modules/feed/hooks"
import { feedActions } from "../modules/feed/store"
import { inboxActions, useInboxStore } from "../modules/inbox/store"
import { getListById } from "../modules/list/getters"
import { listActions } from "../modules/list/store"
import { getSubscriptionById } from "../modules/subscription/getter"
import { subscriptionActions, subscriptionSyncService } from "../modules/subscription/store"
import type { SubscriptionModel } from "../modules/subscription/types"
import {
  getInboxStoreId,
  getSubscriptionDBId,
  getSubscriptionStoreId,
} from "../modules/subscription/utils"
import { unreadActions, unreadSyncService } from "../modules/unread/store"
import { whoami } from "../modules/user/getters"
import { apiMorph } from "../morph/api"
import { entryReadOverlayKey } from "./overlay-keys"
import { setSyncEngineActive } from "./sync-status"
import { isNavigatorOnline, transactionQueue } from "./transaction-queue"
import type {
  CollectionActionData,
  InboxEntryActionData,
  ListActionData,
  SyncAction,
  TimelineNewEntriesActionData,
  TimelineReadActionData,
} from "./types"

/**
 * Incremental synchronization of user-owned models, modelled on Linear's sync engine.
 *
 * The client keeps `lastSyncId`, the highest change-log id it applied. A bootstrap takes
 * the current id from the server and then loads full snapshots; every later pull asks for
 * the actions recorded after the cursor and applies them to the stores. Pending local
 * transactions keep precedence through the transaction queue's overlays.
 */

const LAST_SYNC_ID_KEY = "lastSyncId"
const PULL_INTERVAL_MS = 60_000
/** The server hides actions younger than one second; wait a bit longer after an ack. */
const ACK_PULL_DELAY_MS = 1500
const MAX_PAGES_PER_PULL = 20

export type SyncPullReason = "launch" | "resume" | "interval" | "ack" | "manual"

type SubscriptionSyncPayload = Parameters<typeof apiMorph.toSubscription>[0][number]

interface PullSummary {
  refreshUnread: boolean
  invalidateViews: Set<FeedViewType>
  /** Structural changes (subscriptions added or removed) always refetch the affected lists. */
  forceInvalidate: boolean
}

const createPullSummary = (): PullSummary => ({
  refreshUnread: false,
  invalidateViews: new Set(),
  forceInvalidate: false,
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const addView = (summary: PullSummary, view: FeedViewType | undefined) => {
  if (typeof view !== "number") return
  summary.invalidateViews.add(view)
  summary.invalidateViews.add(FeedViewType.All)
}

class SyncEngine implements Resetable {
  private lastSyncId: number | null = null
  private loaded = false
  private unavailable = false
  private pulling: Promise<void> | null = null
  private pullTimer: ReturnType<typeof setTimeout> | null = null
  private intervalTimer: ReturnType<typeof setInterval> | null = null
  private listenersAttached = false
  private detachQueueListener: (() => void) | null = null

  getLastSyncId() {
    return this.lastSyncId
  }

  /** False once the server answered 404 for the sync endpoints; the app then keeps its full refetch behaviour. */
  isAvailable() {
    return !this.unavailable
  }

  /** Load the cursor, attach the triggers and run the first pull. Call once after hydration. */
  async start() {
    await this.loadCursor()
    this.attachListeners()
    this.schedulePull("launch")
  }

  private async loadCursor() {
    if (this.loaded) return
    try {
      const stored = await SyncMetaService.get(LAST_SYNC_ID_KEY)
      const parsed = stored === null ? Number.NaN : Number(stored)
      this.lastSyncId = Number.isFinite(parsed) ? parsed : null
      setSyncEngineActive(this.lastSyncId !== null)
    } catch (error) {
      console.error("[sync-engine] failed to load the sync cursor", error)
    }
    this.loaded = true
  }

  /** The network or the app came back: pull as soon as possible. */
  resume() {
    this.schedulePull("resume")
  }

  schedulePull(reason: SyncPullReason, delayMs = 0) {
    if (this.pullTimer) {
      clearTimeout(this.pullTimer)
    }
    this.pullTimer = setTimeout(() => {
      this.pullTimer = null
      void this.pull(reason)
    }, delayMs)
  }

  pull(reason: SyncPullReason = "manual"): Promise<void> {
    if (this.pulling) return this.pulling
    this.pulling = this.runPull(reason)
      .catch((error) => {
        console.error("[sync-engine] pull failed", error)
      })
      .finally(() => {
        this.pulling = null
      })
    return this.pulling
  }

  /** Take the server's current id, then load full snapshots. Later pulls are incremental. */
  async bootstrap() {
    let lastSyncId: number
    try {
      const response = await syncApi().state()
      lastSyncId = response.data.lastSyncId
    } catch (error) {
      if (this.markUnavailableIfMissing(error)) return
      throw error
    }

    await subscriptionSyncService.fetch()
    await unreadSyncService.resetFromRemote()
    await this.setLastSyncId(lastSyncId)
  }

  /** Forget the cursor. Used on logout; the next start bootstraps again. */
  async reset() {
    this.clearInSession()
    await SyncMetaService.delete(LAST_SYNC_ID_KEY).catch((error) => {
      console.error("[sync-engine] failed to clear the sync cursor", error)
    })
  }

  clearInSession() {
    if (this.pullTimer) {
      clearTimeout(this.pullTimer)
      this.pullTimer = null
    }
    this.lastSyncId = null
    this.loaded = false
    this.unavailable = false
    setSyncEngineActive(false)
  }

  private async runPull(reason: SyncPullReason) {
    if (this.unavailable || !whoami() || !isNavigatorOnline()) return
    await this.loadCursor()

    if (this.lastSyncId === null) {
      await this.bootstrap()
      return
    }

    const summary = createPullSummary()
    let cursor = this.lastSyncId

    for (let page = 0; page < MAX_PAGES_PER_PULL; page++) {
      let response: Awaited<ReturnType<ReturnType<typeof syncApi>["delta"]>>
      try {
        response = await syncApi().delta({ lastSyncId: cursor })
      } catch (error) {
        if (this.markUnavailableIfMissing(error)) return
        throw error
      }

      const { data } = response
      if (data.reset) {
        await this.bootstrap()
        return
      }

      if (data.actions.length > 0) {
        await this.applyActions(data.actions, summary)
      }

      if (data.lastSyncId > cursor) {
        cursor = data.lastSyncId
        await this.setLastSyncId(cursor)
      }

      if (!data.hasMore) break
    }

    await this.finishPull(summary, reason)
  }

  private async finishPull(summary: PullSummary, reason: SyncPullReason) {
    if (summary.refreshUnread) {
      await unreadSyncService.resetFromRemote().catch((error) => {
        console.error("[sync-engine] failed to refresh unread counts", error)
      })
    }

    const shouldInvalidate =
      summary.invalidateViews.size > 0 &&
      (summary.forceInvalidate || reason === "launch" || reason === "resume")
    if (shouldInvalidate) {
      invalidateEntriesQuery({ views: Array.from(summary.invalidateViews) })
    }
  }

  private async applyActions(actions: SyncAction[], summary: PullSummary) {
    for (const action of actions) {
      try {
        await this.applyAction(action, summary)
      } catch (error) {
        console.error(`[sync-engine] failed to apply ${action.model}/${action.action}`, error)
      }
    }
  }

  private async applyAction(action: SyncAction, summary: PullSummary) {
    switch (action.model) {
      case "subscription":
      case "list_subscription": {
        await this.applySubscriptionAction(action, summary)
        return
      }
      case "collection": {
        await this.applyCollectionAction(action)
        return
      }
      case "timeline": {
        await this.applyTimelineAction(action, summary)
        return
      }
      case "list": {
        await this.applyListAction(action, summary)
        return
      }
      case "inbox": {
        await this.applyInboxAction(action, summary)
        return
      }
      case "inbox_entry": {
        await this.applyInboxEntryAction(action, summary)
        return
      }
      default: {
        console.warn(`[sync-engine] ignoring unknown model ${action.model as string}`)
      }
    }
  }

  private async applySubscriptionAction(action: SyncAction, summary: PullSummary) {
    if (!action.modelId) return

    if (action.action === "I") {
      if (!isRecord(action.data) || !("feeds" in action.data || "lists" in action.data)) return
      const { subscriptions, collections } = apiMorph.toSubscription([
        action.data as unknown as SubscriptionSyncPayload,
      ])
      await feedActions.upsertMany(collections.feeds)
      await listActions.upsertMany(collections.lists)
      await subscriptionActions.upsertMany(subscriptions)
      for (const subscription of subscriptions) {
        addView(summary, subscription.view)
      }
      summary.refreshUnread = true
      summary.forceInvalidate = true
      return
    }

    const current = getSubscriptionById(action.modelId)
    if (!current) return

    if (action.action === "U") {
      if (!isRecord(action.data)) return
      const patch = action.data as Partial<SubscriptionModel>
      const previousView = current.view
      subscriptionActions.patchInSession(getSubscriptionStoreId(current), patch)
      const next = getSubscriptionById(action.modelId)
      if (next) {
        await SubscriptionService.patch({
          id: getSubscriptionDBId(next),
          ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)),
        })
        if (next.view !== previousView) {
          addView(summary, previousView)
          addView(summary, next.view)
          summary.forceInvalidate = true
        }
      }
      return
    }

    if (action.action === "D") {
      subscriptionActions.removeManyInSession([getSubscriptionStoreId(current)])
      await SubscriptionService.delete([getSubscriptionDBId(current)])
      if (current.feedId) {
        await unreadActions.updateById(current.feedId, 0)
      }
      addView(summary, current.view)
      summary.forceInvalidate = true
    }
  }

  private async applyCollectionAction(action: SyncAction) {
    if (!action.modelId) return

    if (action.action === "I") {
      if (!isRecord(action.data)) return
      const data = action.data as unknown as CollectionActionData
      await collectionActions.upsertMany([
        {
          entryId: data.entryId ?? action.modelId,
          feedId: data.feedId,
          view: data.view as FeedViewType,
          createdAt: data.createdAt,
        },
      ])
      return
    }

    if (action.action === "D") {
      await collectionActions.delete(action.modelId)
    }
  }

  private async applyTimelineAction(action: SyncAction, summary: PullSummary) {
    if (action.action === "U") {
      if (!isRecord(action.data) || !Array.isArray(action.data.entryIds)) return
      const data = action.data as unknown as TimelineReadActionData
      // A pending local transaction on the same entry wins over the remote change.
      const overlays = transactionQueue.getOverlays()
      const entryIds = data.entryIds.filter((entryId) => {
        const override = overlays.get(entryReadOverlayKey(entryId))
        return typeof override !== "boolean" || override === data.read
      })
      if (entryIds.length === 0) return

      entryActions.markEntryReadStatusInSession({ entryIds, read: data.read })
      await EntryService.patchMany({ entry: { read: data.read }, entryIds })
      summary.refreshUnread = true
      return
    }

    if (action.action === "N") {
      if (!isRecord(action.data)) return
      const data = action.data as unknown as TimelineNewEntriesActionData
      if (data.isInbox) {
        const inboxId = data.inboxId ?? action.modelId
        if (!inboxId) return
        setFeedUnreadDirty(inboxId)
        addView(summary, FeedViewType.Articles)
        summary.refreshUnread = true
        return
      }

      const feedId = data.feedId ?? action.modelId
      if (!feedId) return

      setFeedUnreadDirty(feedId)
      addView(summary, getSubscriptionById(feedId)?.view)
      for (const source of data.from ?? []) {
        if (source === "feed") continue
        addView(summary, getSubscriptionById(source)?.view)
      }
      summary.refreshUnread = true
    }
  }

  private async applyListAction(action: SyncAction, summary: PullSummary) {
    const listId = action.modelId
    if (!listId) return

    if (action.action === "U") {
      if (!isRecord(action.data)) return
      const current = getListById(listId)
      if (!current) return

      const patch = Object.fromEntries(
        Object.entries(action.data as ListActionData).filter(([, value]) => value !== undefined),
      ) as Partial<typeof current>
      await listActions.upsertMany([{ ...current, ...patch }])

      if ("feedIds" in patch) {
        // Membership changed: the list's timeline and unread counts are different now.
        addView(summary, current.view)
        summary.refreshUnread = true
        summary.forceInvalidate = true
      }
      return
    }

    if (action.action === "D") {
      const subscription = getSubscriptionById(listId)
      if (subscription?.listId) {
        subscriptionActions.removeManyInSession([getSubscriptionStoreId(subscription)])
        await SubscriptionService.delete([getSubscriptionDBId(subscription)])
        addView(summary, subscription.view)
        summary.forceInvalidate = true
      }
      listActions.removeInSession(listId)
      await ListService.deleteList(listId)
    }
  }

  private async applyInboxAction(action: SyncAction, summary: PullSummary) {
    const inboxId = action.modelId
    if (!inboxId) return

    if (action.action === "I") {
      if (!isRecord(action.data) || !("inboxes" in action.data)) return
      const { subscriptions, collections } = apiMorph.toSubscription([
        action.data as unknown as SubscriptionSyncPayload,
      ])
      await inboxActions.upsertMany(collections.inboxes)
      await subscriptionActions.upsertMany(subscriptions)
      return
    }

    if (action.action === "U") {
      if (!isRecord(action.data)) return
      const current = useInboxStore.getState().inboxes[inboxId]
      if (!current) return
      const title = typeof action.data.title === "string" ? action.data.title : null
      await inboxActions.upsertMany([{ id: current.id, secret: current.secret, title }])

      const subscription = getSubscriptionById(getInboxStoreId(inboxId))
      if (subscription) {
        subscriptionActions.patchInSession(getSubscriptionStoreId(subscription), { title })
        await SubscriptionService.patch({ id: getSubscriptionDBId(subscription), title })
      }
      return
    }

    if (action.action === "D") {
      const subscription = getSubscriptionById(getInboxStoreId(inboxId))
      if (subscription) {
        subscriptionActions.removeManyInSession([getSubscriptionStoreId(subscription)])
        await SubscriptionService.delete([getSubscriptionDBId(subscription)])
      }
      inboxActions.deleteById(inboxId)
      await InboxService.deleteById(inboxId)
      await unreadActions.updateById(inboxId, 0)
      addView(summary, FeedViewType.Articles)
      summary.forceInvalidate = true
    }
  }

  private async applyInboxEntryAction(action: SyncAction, summary: PullSummary) {
    if (action.action !== "D" || !action.modelId) return

    const data = isRecord(action.data) ? (action.data as InboxEntryActionData) : {}
    entryActions.deleteInboxEntryById(action.modelId)
    await EntryService.deleteMany([action.modelId])
    if (data.inboxId) {
      setFeedUnreadDirty(data.inboxId)
    }
    summary.refreshUnread = true
  }

  private async setLastSyncId(lastSyncId: number) {
    this.lastSyncId = lastSyncId
    setSyncEngineActive(true)
    // Everything up to this id is reflected in what the server returns from now on.
    transactionQueue.markSynced(lastSyncId)
    try {
      await SyncMetaService.set(LAST_SYNC_ID_KEY, String(lastSyncId))
    } catch (error) {
      console.error("[sync-engine] failed to persist the sync cursor", error)
    }
  }

  private markUnavailableIfMissing(error: unknown) {
    if (error instanceof FollowAPIError && error.status === 404) {
      this.unavailable = true
      setSyncEngineActive(false)
      console.info("[sync-engine] the server has no sync endpoints; keeping full refetch behaviour")
      return true
    }
    return false
  }

  private attachListeners() {
    if (this.listenersAttached) return
    this.listenersAttached = true

    this.detachQueueListener = transactionQueue.onAcknowledged(() => {
      this.schedulePull("ack", ACK_PULL_DELAY_MS)
    })

    this.intervalTimer = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return
      void this.pull("interval")
    }, PULL_INTERVAL_MS)

    if (typeof globalThis.addEventListener === "function") {
      globalThis.addEventListener("online", () => this.resume())
    }
    if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) this.resume()
      })
    }
  }
}

export const syncEngine = new SyncEngine()
