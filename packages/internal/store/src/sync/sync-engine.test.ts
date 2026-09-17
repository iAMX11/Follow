import { FeedViewType } from "@follow/constants"
import { FollowAPIError } from "@follow-app/client-sdk"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { apiContext, syncApiContext } from "../context"
import { useCollectionStore } from "../modules/collection/store"
import { useEntryStore } from "../modules/entry/store"
import type { EntryModel } from "../modules/entry/types"
import { useInboxStore } from "../modules/inbox/store"
import { useListStore } from "../modules/list/store"
import { useSubscriptionStore } from "../modules/subscription/store"
import { useUnreadStore } from "../modules/unread/store"
import { useUserStore } from "../modules/user/store"
import type { FollowAPI } from "../types"
import { syncEngine } from "./sync-engine"
import { isSyncEngineActive } from "./sync-status"
import { transactionQueue } from "./transaction-queue"
import type { SyncAction, SyncAPI } from "./types"

const {
  syncMetaStore,
  syncMetaGetMock,
  syncMetaSetMock,
  entryPatchManyMock,
  subscriptionPatchMock,
  subscriptionDeleteMock,
  collectionUpsertManyMock,
  collectionDeleteManyMock,
  listDeleteMock,
  inboxDeleteByIdMock,
  entryDeleteManyMock,
  unreadUpsertManyMock,
  invalidateEntriesQueryMock,
  setFeedUnreadDirtyMock,
} = vi.hoisted(() => {
  const syncMetaStore = new Map<string, string>()
  return {
    syncMetaStore,
    syncMetaGetMock: vi.fn(async (key: string) => syncMetaStore.get(key) ?? null),
    syncMetaSetMock: vi.fn(async (key: string, value: string) => {
      syncMetaStore.set(key, value)
    }),
    entryPatchManyMock: vi.fn(async () => {}),
    subscriptionPatchMock: vi.fn(async () => {}),
    subscriptionDeleteMock: vi.fn(async () => {}),
    collectionUpsertManyMock: vi.fn(async () => {}),
    collectionDeleteManyMock: vi.fn(async () => {}),
    listDeleteMock: vi.fn(async () => {}),
    inboxDeleteByIdMock: vi.fn(async () => {}),
    entryDeleteManyMock: vi.fn(async () => {}),
    unreadUpsertManyMock: vi.fn(async () => {}),
    invalidateEntriesQueryMock: vi.fn(),
    setFeedUnreadDirtyMock: vi.fn(),
  }
})

vi.mock("@follow/database/services/sync-meta", () => ({
  SyncMetaService: {
    get: syncMetaGetMock,
    set: syncMetaSetMock,
    delete: vi.fn(async (key: string) => {
      syncMetaStore.delete(key)
    }),
    reset: vi.fn(async () => syncMetaStore.clear()),
  },
}))
vi.mock("@follow/database/services/sync-transaction", () => ({
  SyncTransactionService: {
    insert: vi.fn(async () => {}),
    deleteMany: vi.fn(async () => {}),
    getAll: vi.fn(async () => []),
    reset: vi.fn(async () => {}),
  },
}))
vi.mock("@follow/database/services/entry", () => ({
  EntryService: {
    patchMany: entryPatchManyMock,
    getEntryMany: vi.fn(async () => []),
    upsertMany: vi.fn(async () => {}),
    deleteMany: entryDeleteManyMock,
  },
}))
vi.mock("@follow/database/services/subscription", () => ({
  SubscriptionService: {
    getSubscriptionAll: vi.fn(async () => []),
    upsertMany: vi.fn(async () => {}),
    patch: subscriptionPatchMock,
    delete: subscriptionDeleteMock,
    reset: vi.fn(async () => {}),
  },
}))
vi.mock("@follow/database/services/feed", () => ({
  FEED_EXTRA_DATA_KEYS: [],
  FeedService: {
    upsertMany: vi.fn(async () => {}),
    reset: vi.fn(async () => {}),
  },
}))
vi.mock("@follow/database/services/list", () => ({
  ListService: {
    upsertMany: vi.fn(async () => {}),
    deleteList: listDeleteMock,
    reset: vi.fn(async () => {}),
  },
}))
vi.mock("@follow/database/services/inbox", () => ({
  InboxService: {
    upsertMany: vi.fn(async () => {}),
    deleteById: inboxDeleteByIdMock,
    reset: vi.fn(async () => {}),
  },
}))
vi.mock("@follow/database/services/collection", () => ({
  CollectionService: {
    upsertMany: collectionUpsertManyMock,
    deleteMany: collectionDeleteManyMock,
    reset: vi.fn(async () => {}),
  },
}))
vi.mock("@follow/database/services/unread", () => ({
  UnreadService: {
    upsertMany: unreadUpsertManyMock,
    reset: vi.fn(async () => {}),
  },
}))
vi.mock("../modules/entry/hooks", () => ({
  invalidateEntriesQuery: invalidateEntriesQueryMock,
}))
vi.mock("../modules/feed/hooks", () => ({
  setFeedUnreadDirty: setFeedUnreadDirtyMock,
  clearFeedUnreadDirty: vi.fn(),
  clearAllFeedUnreadDirty: vi.fn(),
}))

const createEntry = (id: string, feedId: string, read = false): EntryModel => ({
  id,
  guid: `${id}-guid`,
  insertedAt: new Date("2026-01-01T00:00:00.000Z"),
  publishedAt: new Date("2026-01-01T00:00:00.000Z"),
  feedId,
  read,
})

const createAction = (overrides: Partial<SyncAction> & Pick<SyncAction, "id">): SyncAction => ({
  model: "timeline",
  modelId: null,
  action: "U",
  data: null,
  createdAt: "2026-09-16T00:00:00.000Z",
  ...overrides,
})

const deltaResponse = (
  actions: SyncAction[],
  options: { hasMore?: boolean; reset?: boolean; lastSyncId?: number } = {},
) => ({
  code: 0 as const,
  data: {
    actions,
    lastSyncId: options.lastSyncId ?? actions.at(-1)?.id ?? 0,
    hasMore: options.hasMore ?? false,
    reset: options.reset ?? false,
  },
})

describe("syncEngine", () => {
  const stateMock = vi.fn()
  const deltaMock = vi.fn()
  const subscriptionsGetMock = vi.fn()
  const readsGetMock = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    syncMetaStore.clear()
    syncEngine.clearInSession()
    transactionQueue.clearInSession()

    useUserStore.setState((state) => ({ ...state, whoami: { id: "user-1" } as never }))
    useEntryStore.setState({
      data: {},
      entryIdByView: {
        [FeedViewType.All]: new Set(),
        [FeedViewType.Articles]: new Set(),
        [FeedViewType.Audios]: new Set(),
        [FeedViewType.Notifications]: new Set(),
        [FeedViewType.Pictures]: new Set(),
        [FeedViewType.SocialMedia]: new Set(),
        [FeedViewType.Videos]: new Set(),
      },
      entryIdByCategory: {},
      entryIdByFeed: {},
      entryIdByInbox: {},
      entryIdByList: {},
      entryIdSet: new Set(),
    })
    useSubscriptionStore.setState((state) => ({
      ...state,
      data: {},
      subscriptionIdSet: new Set(),
      feedIdByView: {
        [FeedViewType.All]: new Set(),
        [FeedViewType.Articles]: new Set(),
        [FeedViewType.Audios]: new Set(),
        [FeedViewType.Notifications]: new Set(),
        [FeedViewType.Pictures]: new Set(),
        [FeedViewType.SocialMedia]: new Set(),
        [FeedViewType.Videos]: new Set(),
      },
      listIdByView: {
        [FeedViewType.All]: new Set(),
        [FeedViewType.Articles]: new Set(),
        [FeedViewType.Audios]: new Set(),
        [FeedViewType.Notifications]: new Set(),
        [FeedViewType.Pictures]: new Set(),
        [FeedViewType.SocialMedia]: new Set(),
        [FeedViewType.Videos]: new Set(),
      },
      categories: {
        [FeedViewType.All]: new Set(),
        [FeedViewType.Articles]: new Set(),
        [FeedViewType.Audios]: new Set(),
        [FeedViewType.Notifications]: new Set(),
        [FeedViewType.Pictures]: new Set(),
        [FeedViewType.SocialMedia]: new Set(),
        [FeedViewType.Videos]: new Set(),
      },
    }))
    useCollectionStore.setState({ collections: {} })
    useListStore.setState({ lists: {}, listIds: [] })
    useInboxStore.setState({ inboxes: {} })
    useUnreadStore.setState({ data: {} })

    subscriptionsGetMock.mockResolvedValue({ data: [] })
    readsGetMock.mockResolvedValue({ data: {} })
    apiContext.provide({
      subscriptions: { get: subscriptionsGetMock },
      reads: { get: readsGetMock },
    } as unknown as FollowAPI)
    syncApiContext.provide({ state: stateMock, delta: deltaMock } as SyncAPI)
  })

  afterEach(() => {
    syncEngine.clearInSession()
    transactionQueue.clearInSession()
  })

  it("bootstraps on the first pull and stores the server's sync id", async () => {
    stateMock.mockResolvedValue({ code: 0, data: { lastSyncId: 42 } })

    await syncEngine.pull("launch")

    expect(stateMock).toHaveBeenCalledTimes(1)
    expect(subscriptionsGetMock).toHaveBeenCalledTimes(1)
    expect(readsGetMock).toHaveBeenCalledTimes(1)
    expect(deltaMock).not.toHaveBeenCalled()
    expect(syncEngine.getLastSyncId()).toBe(42)
    expect(syncMetaStore.get("lastSyncId")).toBe("42")
    expect(isSyncEngineActive()).toBe(true)
  })

  it("applies list membership changes and list deletion", async () => {
    syncMetaStore.set("lastSyncId", "40")
    const { subscriptionActions } = await import("../modules/subscription/store")
    const { listActions } = await import("../modules/list/store")
    listActions.upsertManyInSession([
      {
        id: "list-1",
        title: "Reading",
        userId: "owner-1",
        ownerUserId: "owner-1",
        description: null,
        image: null,
        view: FeedViewType.Articles,
        feedIds: ["feed-1"],
        fee: 0,
        subscriptionCount: null,
        purchaseAmount: null,
        type: "list",
      },
    ])
    subscriptionActions.upsertManyInSession([
      {
        feedId: null,
        listId: "list-1",
        inboxId: null,
        userId: "user-1",
        view: FeedViewType.Articles,
        isPrivate: false,
        hideFromTimeline: null,
        title: null,
        category: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        type: "list",
      },
    ])
    deltaMock.mockResolvedValueOnce(
      deltaResponse([
        createAction({
          id: 41,
          model: "list",
          modelId: "list-1",
          action: "U",
          data: { feedIds: ["feed-1", "feed-2"], title: "Reading list" },
        }),
      ]),
    )

    await syncEngine.pull("interval")

    expect(useListStore.getState().lists["list-1"]?.feedIds).toEqual(["feed-1", "feed-2"])
    expect(useListStore.getState().lists["list-1"]?.title).toBe("Reading list")
    expect(readsGetMock).toHaveBeenCalledTimes(1)
    expect(invalidateEntriesQueryMock).toHaveBeenCalledTimes(1)

    deltaMock.mockResolvedValueOnce(
      deltaResponse([createAction({ id: 42, model: "list", modelId: "list-1", action: "D" })]),
    )
    await syncEngine.pull("interval")

    expect(useListStore.getState().lists["list-1"]).toBeUndefined()
    expect(useSubscriptionStore.getState().data["list-1"]).toBeUndefined()
    expect(listDeleteMock).toHaveBeenCalledWith("list-1")
    expect(subscriptionDeleteMock).toHaveBeenCalledWith(["list/list-1"])
  })

  it("applies the inbox lifecycle, new inbox entries and inbox entry deletions", async () => {
    syncMetaStore.set("lastSyncId", "50")
    deltaMock.mockResolvedValueOnce(
      deltaResponse([
        createAction({
          id: 51,
          model: "inbox",
          modelId: "news",
          action: "I",
          data: {
            inboxes: { type: "inbox", id: "news", secret: "s3cret", title: "News" },
            feedId: "inbox-news",
            title: "News",
            userId: "user-1",
            inboxId: "news",
            view: 0,
            category: null,
            isPrivate: false,
            hideFromTimeline: null,
            createdAt: "",
          },
        }),
        createAction({
          id: 52,
          model: "inbox",
          modelId: "news",
          action: "U",
          data: { title: "Daily" },
        }),
        createAction({
          id: 53,
          model: "timeline",
          modelId: "news",
          action: "N",
          data: {
            inboxId: "news",
            isInbox: true,
            count: 1,
            entryIds: ["mail-1"],
            latestPublishedAt: "2026-09-17T00:00:00.000Z",
            from: [],
          },
        }),
      ]),
    )

    await syncEngine.pull("interval")

    expect(useInboxStore.getState().inboxes.news).toMatchObject({
      id: "news",
      title: "Daily",
      secret: "s3cret",
    })
    expect(useSubscriptionStore.getState().data["inbox/news"]).toMatchObject({
      inboxId: "news",
      type: "inbox",
      title: "Daily",
    })
    expect(setFeedUnreadDirtyMock).toHaveBeenCalledWith("news")
    expect(readsGetMock).toHaveBeenCalledTimes(1)

    useEntryStore.setState((state) => ({
      ...state,
      data: { "mail-1": { ...createEntry("mail-1", ""), feedId: null, inboxHandle: "news" } },
      entryIdSet: new Set(["mail-1"]),
      entryIdByInbox: { news: new Set(["mail-1"]) },
    }))
    deltaMock.mockResolvedValueOnce(
      deltaResponse([
        createAction({
          id: 54,
          model: "inbox_entry",
          modelId: "mail-1",
          action: "D",
          data: { inboxId: "news" },
        }),
        createAction({ id: 55, model: "inbox", modelId: "news", action: "D" }),
      ]),
    )
    await syncEngine.pull("interval")

    expect(useEntryStore.getState().data["mail-1"]).toBeUndefined()
    expect(entryDeleteManyMock).toHaveBeenCalledWith(["mail-1"])
    expect(useInboxStore.getState().inboxes.news).toBeUndefined()
    expect(useSubscriptionStore.getState().data["inbox/news"]).toBeUndefined()
    expect(inboxDeleteByIdMock).toHaveBeenCalledWith("news")
  })

  it("tells the transaction queue how far the change log was applied", async () => {
    syncMetaStore.set("lastSyncId", "60")
    const markSyncedSpy = vi.spyOn(transactionQueue, "markSynced")
    deltaMock.mockResolvedValueOnce(
      deltaResponse([
        createAction({ id: 61, model: "collection", modelId: "entry-9", action: "D" }),
      ]),
    )

    await syncEngine.pull("interval")

    expect(markSyncedSpy).toHaveBeenCalledWith(61)
    markSyncedSpy.mockRestore()
  })

  it("applies subscription updates and deletes from the delta", async () => {
    syncMetaStore.set("lastSyncId", "10")
    const { subscriptionActions } = await import("../modules/subscription/store")
    subscriptionActions.upsertManyInSession([
      {
        feedId: "feed-1",
        listId: null,
        inboxId: null,
        userId: "user-1",
        view: FeedViewType.Articles,
        isPrivate: false,
        hideFromTimeline: null,
        title: null,
        category: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        type: "feed",
      },
      {
        feedId: "feed-2",
        listId: null,
        inboxId: null,
        userId: "user-1",
        view: FeedViewType.Articles,
        isPrivate: false,
        hideFromTimeline: null,
        title: null,
        category: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        type: "feed",
      },
    ])
    deltaMock.mockResolvedValue(
      deltaResponse([
        createAction({
          id: 11,
          model: "subscription",
          modelId: "feed-1",
          action: "U",
          data: { view: FeedViewType.Videos, category: "Clips" },
        }),
        createAction({ id: 12, model: "subscription", modelId: "feed-2", action: "D" }),
      ]),
    )

    await syncEngine.pull("interval")

    expect(deltaMock).toHaveBeenCalledWith({ lastSyncId: 10 })
    const state = useSubscriptionStore.getState()
    expect(state.data["feed-1"]?.view).toBe(FeedViewType.Videos)
    expect(state.data["feed-1"]?.category).toBe("Clips")
    expect(state.feedIdByView[FeedViewType.Videos].has("feed-1")).toBe(true)
    expect(state.feedIdByView[FeedViewType.Articles].has("feed-1")).toBe(false)
    expect(state.data["feed-2"]).toBeUndefined()
    expect(subscriptionPatchMock).toHaveBeenCalledWith({
      id: "feed/feed-1",
      view: FeedViewType.Videos,
      category: "Clips",
    })
    expect(subscriptionDeleteMock).toHaveBeenCalledWith(["feed/feed-2"])
    expect(syncEngine.getLastSyncId()).toBe(12)
    expect(invalidateEntriesQueryMock).toHaveBeenCalledTimes(1)
  })

  it("applies collection and read-state changes while pending local marks win", async () => {
    syncMetaStore.set("lastSyncId", "20")
    useEntryStore.setState((state) => ({
      ...state,
      data: {
        entry1: createEntry("entry1", "feed-1"),
        entry2: createEntry("entry2", "feed-1"),
      },
      entryIdSet: new Set(["entry1", "entry2"]),
    }))
    const { unreadSyncService } = await import("../modules/unread/store")
    apiContext.provide({
      subscriptions: { get: subscriptionsGetMock },
      reads: { get: readsGetMock, markAsUnread: vi.fn(() => new Promise(() => {})) },
    } as unknown as FollowAPI)
    useEntryStore.setState((state) => ({
      ...state,
      data: { ...state.data, entry2: createEntry("entry2", "feed-1", true) },
    }))
    await unreadSyncService.markEntryAsUnread("entry2")

    deltaMock.mockResolvedValue(
      deltaResponse([
        createAction({
          id: 21,
          model: "collection",
          modelId: "entry1",
          action: "I",
          data: {
            entryId: "entry1",
            feedId: "feed-1",
            view: FeedViewType.Articles,
            createdAt: "2026-09-16T00:00:00.000Z",
          },
        }),
        createAction({
          id: 22,
          model: "timeline",
          action: "U",
          data: { entryIds: ["entry1", "entry2"], read: true, isInbox: false },
        }),
        createAction({ id: 23, model: "collection", modelId: "entry1", action: "D" }),
      ]),
    )

    await syncEngine.pull("interval")

    expect(useEntryStore.getState().data.entry1?.read).toBe(true)
    expect(useEntryStore.getState().data.entry2?.read).toBe(false)
    expect(entryPatchManyMock).toHaveBeenCalledWith({
      entry: { read: true },
      entryIds: ["entry1"],
    })
    expect(collectionUpsertManyMock).toHaveBeenCalledTimes(1)
    expect(collectionDeleteManyMock).toHaveBeenCalledWith(["entry1"])
    expect(useCollectionStore.getState().collections.entry1).toBeUndefined()
    expect(readsGetMock).toHaveBeenCalledTimes(1)
  })

  it("marks feeds dirty and refreshes unread counts on new entries, paging through the delta", async () => {
    syncMetaStore.set("lastSyncId", "30")
    deltaMock
      .mockResolvedValueOnce(
        deltaResponse(
          [
            createAction({
              id: 31,
              model: "timeline",
              modelId: "feed-1",
              action: "N",
              data: {
                feedId: "feed-1",
                count: 3,
                latestPublishedAt: "2026-09-16T00:00:00.000Z",
                from: ["feed"],
              },
            }),
          ],
          { hasMore: true },
        ),
      )
      .mockResolvedValueOnce(deltaResponse([], { lastSyncId: 31 }))

    await syncEngine.pull("interval")

    expect(deltaMock).toHaveBeenCalledTimes(2)
    expect(deltaMock).toHaveBeenLastCalledWith({ lastSyncId: 31 })
    expect(setFeedUnreadDirtyMock).toHaveBeenCalledWith("feed-1")
    expect(readsGetMock).toHaveBeenCalledTimes(1)
    expect(invalidateEntriesQueryMock).not.toHaveBeenCalled()
  })

  it("bootstraps again when the server asks for a reset", async () => {
    syncMetaStore.set("lastSyncId", "5")
    deltaMock.mockResolvedValue(deltaResponse([], { reset: true, lastSyncId: 5 }))
    stateMock.mockResolvedValue({ code: 0, data: { lastSyncId: 99 } })

    await syncEngine.pull("interval")

    expect(stateMock).toHaveBeenCalledTimes(1)
    expect(subscriptionsGetMock).toHaveBeenCalledTimes(1)
    expect(syncEngine.getLastSyncId()).toBe(99)
  })

  it("falls back to the full refetch behaviour when the server has no sync endpoints", async () => {
    stateMock.mockRejectedValue(new FollowAPIError("not found", 404))

    await syncEngine.pull("launch")
    await syncEngine.pull("interval")

    expect(stateMock).toHaveBeenCalledTimes(1)
    expect(syncEngine.isAvailable()).toBe(false)
    expect(isSyncEngineActive()).toBe(false)
    expect(subscriptionsGetMock).not.toHaveBeenCalled()
  })
})
