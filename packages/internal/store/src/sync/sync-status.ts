/**
 * Whether the incremental sync engine is driving user-owned models. Kept in its own module,
 * without imports, so hooks can read it without pulling in the engine and its stores.
 *
 * While it is active the delta feed keeps subscriptions, unread counts and read state fresh,
 * so the legacy "refetch when things look wrong" heuristics stand down. They stay in place
 * as the fallback for servers that do not expose the sync endpoints yet.
 */
let active = false

export const isSyncEngineActive = () => active

export const setSyncEngineActive = (next: boolean) => {
  active = next
}
