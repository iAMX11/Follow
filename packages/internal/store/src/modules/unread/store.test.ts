import { FeedViewType } from "@follow/constants"
import { FollowAPIError } from "@follow-app/client-sdk"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { apiContext } from "../../context"
import { transactionQueue } from "../../sync/transaction-queue"
import type { FollowAPI } from "../../types"
import { entryActions, useEntryStore } from "../entry/store"
import type { EntryModel } from "../entry/types"
import { unreadSyncService, useUnreadStore } from "./store"

const { entryPatchManyMock, unreadUpsertManyMock } = vi.hoisted(() => ({
  entryPatchManyMock: vi.fn(),
  unreadUpsertManyMock: vi.fn(),
}))

vi.mock("@follow/database/services/entry", () => ({
  EntryService: {
    patchMany: entryPatchManyMock,
  },
}))

vi.mock("@follow/database/services/unread", () => ({
  UnreadService: {
    getUnreadAll: vi.fn(),
    reset: vi.fn(),
    upsertMany: unreadUpsertManyMock,
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

const flushQueue = async () => {
  await vi.advanceTimersByTimeAsync(100)
  await transactionQueue.whenIdle()
}

const createEntry = (
  id: string,
  feedId: string,
  read = false,
  publishedAt = new Date("2026-01-01T00:00:00.000Z"),
): EntryModel => ({
  id,
  guid: `${id}-guid`,
  insertedAt: new Date("2026-01-01T00:00:00.000Z"),
  publishedAt,
  feedId,
  read,
})

describe("unreadSyncService", () => {
  const markAsReadMock = vi.fn()
  const markAllAsReadMock = vi.fn()
  const markAsUnreadMock = vi.fn()
  const getUnreadMock = vi.fn()

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    transactionQueue.clearInSession()

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
    useUnreadStore.setState({ data: {} })
    apiContext.provide({
      reads: {
        markAllAsRead: markAllAsReadMock,
        markAsRead: markAsReadMock,
        markAsUnread: markAsUnreadMock,
        get: getUnreadMock,
      },
    } as unknown as FollowAPI)
  })

  afterEach(() => {
    transactionQueue.clearInSession()
    vi.useRealTimers()
  })

  it("marks multiple feed entries as read with one request and one local patch", async () => {
    const entries = {
      entry1: createEntry("entry1", "feed1"),
      entry2: createEntry("entry2", "feed1"),
    }
    useEntryStore.setState((state) => ({
      ...state,
      data: entries,
      entryIdSet: new Set(Object.keys(entries)),
    }))
    useUnreadStore.setState({ data: { feed1: 2 } })
    markAsReadMock.mockResolvedValue({ data: null })

    await unreadSyncService.markEntriesAsRead(["entry1", "entry2"])
    expect(useEntryStore.getState().data.entry1?.read).toBe(true)
    expect(useUnreadStore.getState().data.feed1).toBe(0)
    expect(markAsReadMock).not.toHaveBeenCalled()

    await flushQueue()

    expect(markAsReadMock).toHaveBeenCalledTimes(1)
    expect(markAsReadMock).toHaveBeenCalledWith({
      entryIds: ["entry1", "entry2"],
      isInbox: false,
    })
    expect(entryPatchManyMock).toHaveBeenCalledTimes(1)
    expect(entryPatchManyMock).toHaveBeenCalledWith({
      entry: { read: true },
      entryIds: ["entry1", "entry2"],
    })
    expect(useEntryStore.getState().data.entry1?.read).toBe(true)
    expect(useEntryStore.getState().data.entry2?.read).toBe(true)
    expect(useUnreadStore.getState().data.feed1).toBe(0)
  })

  it("optimistically decrements unread count for time-limited batch reads", async () => {
    const entries = {
      entry1: createEntry("entry1", "feed1", false, new Date("2026-01-01T00:05:00.000Z")),
      entry2: createEntry("entry2", "feed1", false, new Date("2026-01-01T00:03:00.000Z")),
      entry3: createEntry("entry3", "feed1", false, new Date("2026-01-01T00:01:00.000Z")),
    }
    useEntryStore.setState((state) => ({
      ...state,
      data: entries,
      entryIdSet: new Set(Object.keys(entries)),
    }))
    useUnreadStore.setState({ data: { feed1: 3 } })

    let resolveMarkAllAsRead!: (value: { data: { read: Record<string, number> } }) => void
    markAllAsReadMock.mockReturnValue(
      new Promise((resolve) => {
        resolveMarkAllAsRead = resolve
      }),
    )

    await unreadSyncService.markBatchAsRead({
      view: FeedViewType.Articles,
      filter: {
        feedIdList: ["feed1"],
      },
      time: {
        startTime: new Date("2026-01-01T00:02:00.000Z").getTime(),
        endTime: new Date("2026-01-01T00:06:00.000Z").getTime(),
      },
      excludePrivate: false,
    })

    expect(useEntryStore.getState().data.entry1?.read).toBe(true)
    expect(useEntryStore.getState().data.entry2?.read).toBe(true)
    expect(useEntryStore.getState().data.entry3?.read).toBe(false)
    expect(useUnreadStore.getState().data.feed1).toBe(1)

    await vi.advanceTimersByTimeAsync(100)
    expect(markAllAsReadMock).toHaveBeenCalledTimes(1)
    resolveMarkAllAsRead({ data: { read: { feed1: 2 } } })
    await transactionQueue.whenIdle()

    expect(useUnreadStore.getState().data.feed1).toBe(1)
    expect(entryPatchManyMock).toHaveBeenCalledWith({
      feedIds: ["feed1"],
      entry: { read: true },
      time: {
        startTime: new Date("2026-01-01T00:02:00.000Z").getTime(),
        endTime: new Date("2026-01-01T00:06:00.000Z").getTime(),
      },
    })
  })

  it("queues rapid read marks into one batched request", async () => {
    const entries = {
      entry1: createEntry("entry1", "feed1"),
      entry2: createEntry("entry2", "feed1"),
    }
    useEntryStore.setState((state) => ({
      ...state,
      data: entries,
      entryIdSet: new Set(Object.keys(entries)),
    }))
    useUnreadStore.setState({ data: { feed1: 2 } })
    markAsReadMock.mockResolvedValue({ data: null })

    await unreadSyncService.queueEntriesAsRead(["entry1"])
    await unreadSyncService.queueEntriesAsRead(["entry2"])

    expect(markAsReadMock).not.toHaveBeenCalled()

    await flushQueue()

    expect(markAsReadMock).toHaveBeenCalledTimes(1)
    expect(markAsReadMock).toHaveBeenCalledWith({
      entryIds: ["entry1", "entry2"],
      isInbox: false,
    })
  })

  it("keeps optimistic read marks and retries when the network is down", async () => {
    const entries = {
      entry1: createEntry("entry1", "feed1"),
    }
    useEntryStore.setState((state) => ({
      ...state,
      data: entries,
      entryIdSet: new Set(Object.keys(entries)),
    }))
    useUnreadStore.setState({ data: { feed1: 1 } })
    markAsReadMock
      .mockRejectedValueOnce(new TypeError("Network request failed"))
      .mockResolvedValue({ data: null })

    await unreadSyncService.markEntriesAsRead(["entry1"])
    await vi.advanceTimersByTimeAsync(100)
    await vi.advanceTimersByTimeAsync(0)

    expect(markAsReadMock).toHaveBeenCalledTimes(1)
    expect(useEntryStore.getState().data.entry1?.read).toBe(true)
    expect(useUnreadStore.getState().data.feed1).toBe(0)
    expect(entryPatchManyMock).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1000)
    await transactionQueue.whenIdle()

    expect(markAsReadMock).toHaveBeenCalledTimes(2)
    expect(entryPatchManyMock).toHaveBeenCalledTimes(1)
  })

  it("rolls back read marks the server rejects", async () => {
    const entries = {
      entry1: createEntry("entry1", "feed1"),
    }
    useEntryStore.setState((state) => ({
      ...state,
      data: entries,
      entryIdSet: new Set(Object.keys(entries)),
    }))
    useUnreadStore.setState({ data: { feed1: 1 } })
    markAsReadMock.mockRejectedValue(new FollowAPIError("forbidden", 403))

    await unreadSyncService.markEntriesAsRead(["entry1"])
    expect(useEntryStore.getState().data.entry1?.read).toBe(true)
    expect(useUnreadStore.getState().data.feed1).toBe(0)

    await flushQueue()

    expect(useEntryStore.getState().data.entry1?.read).toBe(false)
    expect(useUnreadStore.getState().data.feed1).toBe(1)
    expect(entryPatchManyMock).not.toHaveBeenCalled()
  })

  it("rebases pending read marks on top of unread counts fetched from the server", async () => {
    const entries = {
      entry1: createEntry("entry1", "feed1"),
      entry2: createEntry("entry2", "feed2"),
    }
    useEntryStore.setState((state) => ({
      ...state,
      data: entries,
      entryIdSet: new Set(Object.keys(entries)),
    }))
    useUnreadStore.setState({ data: { feed1: 3, feed2: 1 } })
    markAsReadMock.mockReturnValue(new Promise(() => {}))
    getUnreadMock.mockResolvedValue({ data: { feed1: 3, feed2: 1, feed3: 4 } })

    await unreadSyncService.markEntriesAsRead(["entry1"])
    expect(useUnreadStore.getState().data.feed1).toBe(2)

    await unreadSyncService.resetFromRemote()

    expect(useUnreadStore.getState().data).toEqual({ feed1: 2, feed2: 1, feed3: 4 })
    expect(unreadUpsertManyMock).toHaveBeenLastCalledWith(
      [
        { id: "feed1", count: 3 },
        { id: "feed2", count: 1 },
        { id: "feed3", count: 4 },
      ],
      { reset: true },
    )
  })

  it("keeps entries locally read when a stale entry fetch returns during the request", async () => {
    const entries = {
      entry1: createEntry("entry1", "feed1"),
    }
    useEntryStore.setState((state) => ({
      ...state,
      data: entries,
      entryIdSet: new Set(Object.keys(entries)),
    }))
    useUnreadStore.setState({ data: { feed1: 1 } })

    let resolveMarkAsRead!: () => void
    markAsReadMock.mockReturnValue(
      new Promise((resolve) => {
        resolveMarkAsRead = () => resolve({ data: null })
      }),
    )

    await unreadSyncService.markEntriesAsRead(["entry1"])
    await vi.advanceTimersByTimeAsync(100)
    expect(markAsReadMock).toHaveBeenCalledTimes(1)

    expect(useEntryStore.getState().data.entry1?.read).toBe(true)
    entryActions.upsertManyInSession([createEntry("entry1", "feed1")])
    expect(useEntryStore.getState().data.entry1?.read).toBe(true)

    resolveMarkAsRead()
    await transactionQueue.whenIdle()

    expect(useEntryStore.getState().data.entry1?.read).toBe(true)
  })

  it("keeps entries locally read when a stale entry fetch returns after the request", async () => {
    const entries = {
      entry1: createEntry("entry1", "feed1"),
    }
    useEntryStore.setState((state) => ({
      ...state,
      data: entries,
      entryIdSet: new Set(Object.keys(entries)),
    }))
    useUnreadStore.setState({ data: { feed1: 1 } })
    markAsReadMock.mockResolvedValue({ data: null })

    await unreadSyncService.markEntriesAsRead(["entry1"])
    await flushQueue()
    expect(useEntryStore.getState().data.entry1?.read).toBe(true)

    entryActions.upsertManyInSession([createEntry("entry1", "feed1")])

    expect(useEntryStore.getState().data.entry1?.read).toBe(true)
  })

  it("allows remote unread after the acknowledgement grace window expires", async () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"))

    const entries = {
      entry1: createEntry("entry1", "feed1"),
    }
    useEntryStore.setState((state) => ({
      ...state,
      data: entries,
      entryIdSet: new Set(Object.keys(entries)),
    }))
    useUnreadStore.setState({ data: { feed1: 1 } })
    markAsReadMock.mockResolvedValue({ data: null })

    await unreadSyncService.markEntriesAsRead(["entry1"])
    await flushQueue()
    expect(useEntryStore.getState().data.entry1?.read).toBe(true)

    vi.advanceTimersByTime(31_000)
    entryActions.upsertManyInSession([createEntry("entry1", "feed1")])

    expect(useEntryStore.getState().data.entry1?.read).toBe(false)
  })

  it("stops protecting a read mark once the sync engine passed its sync id", async () => {
    const entries = {
      entry1: createEntry("entry1", "feed1"),
    }
    useEntryStore.setState((state) => ({
      ...state,
      data: entries,
      entryIdSet: new Set(Object.keys(entries)),
    }))
    useUnreadStore.setState({ data: { feed1: 1 } })
    markAsReadMock.mockResolvedValue({ code: 0, lastSyncId: 12 })

    await unreadSyncService.markEntriesAsRead(["entry1"])
    await flushQueue()

    entryActions.upsertManyInSession([createEntry("entry1", "feed1")])
    expect(useEntryStore.getState().data.entry1?.read).toBe(true)

    transactionQueue.markSynced(12)
    entryActions.upsertManyInSession([createEntry("entry1", "feed1")])
    expect(useEntryStore.getState().data.entry1?.read).toBe(false)
  })

  it("keeps a pending unread mark when a stale fetch says the entry is read", async () => {
    const entries = {
      entry1: createEntry("entry1", "feed1", true),
    }
    useEntryStore.setState((state) => ({
      ...state,
      data: entries,
      entryIdSet: new Set(Object.keys(entries)),
    }))
    useUnreadStore.setState({ data: { feed1: 0 } })
    markAsUnreadMock.mockReturnValue(new Promise(() => {}))

    await unreadSyncService.markEntryAsUnread("entry1")
    expect(useEntryStore.getState().data.entry1?.read).toBe(false)
    expect(useUnreadStore.getState().data.feed1).toBe(1)

    entryActions.upsertManyInSession([createEntry("entry1", "feed1", true)])
    expect(useEntryStore.getState().data.entry1?.read).toBe(false)
  })
})
