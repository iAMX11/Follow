import type { SyncAPI, SyncDeltaResponse, SyncStateResponse } from "@follow/store/sync/types"
import { userActions } from "@follow/store/user/store"
import { createMobileAPIHeaders } from "@follow/utils/headers"
import { FollowClient } from "@follow-app/client-sdk"
import { fetch } from "expo/fetch"
import { nativeApplicationVersion } from "expo-application"
import { Platform } from "react-native"
import DeviceInfo from "react-native-device-info"

import { getAuthStateRevision, getCookie, getLastAuthStateChangeAt } from "./auth"
import { getClientId, getSessionId } from "./client-session"
import { getUserAgent } from "./native/user-agent"
import { destination } from "./navigation/biz/Destination"
import { proxyEnv } from "./proxy-env"

export const followClient = new FollowClient({
  credentials: "omit",
  timeout: 60_000,
  baseURL: proxyEnv.API_URL,
  fetch: async (input, options = {}) => fetch(input.toString(), options as any) as any,
})

export const followApi = followClient.api

/**
 * `/sync` endpoints, requested directly until the client SDK ships its `sync` module.
 */
export const syncApi: SyncAPI = {
  state: () => followClient.request<SyncStateResponse>("/sync/state", { method: "GET" }),
  delta: (query) =>
    followClient.request<SyncDeltaResponse>("/sync/delta", {
      method: "GET",
      query: {
        lastSyncId: query.lastSyncId,
        ...(query.limit ? { limit: query.limit } : {}),
      },
    }),
}
followClient.addRequestInterceptor(async (ctx) => {
  const { url } = ctx

  try {
    const urlObj = new URL(url)
    urlObj.searchParams.set("t", Date.now().toString())
    ctx.url = urlObj.toString()
  } catch {
    /* empty */
  }

  return ctx
})
followClient.addRequestInterceptor(async (ctx) => {
  const { options } = ctx
  ;(options as typeof options & { __followAuthRevision?: number }).__followAuthRevision =
    getAuthStateRevision()

  const header = options.headers || {}
  header["X-Client-Id"] = getClientId()
  header["X-Session-Id"] = getSessionId()
  header["User-Agent"] = await getUserAgent()
  header["cookie"] = getCookie()

  const apiHeader = createMobileAPIHeaders({
    version: nativeApplicationVersion || "",
    rnPlatform: {
      OS: Platform.OS,
      isPad: Platform.OS === "ios" && Platform.isPad,
    },
    installerPackageName: await DeviceInfo.getInstallerPackageName(),
  })

  options.headers = {
    ...header,
    ...apiHeader,
  }
  return ctx
})

const getRequestCookie = (headers: HeadersInit | undefined) => {
  if (!headers) {
    return
  }

  if (headers instanceof Headers) {
    return headers.get("cookie") ?? undefined
  }

  if (Array.isArray(headers)) {
    return headers.find(([key]) => key.toLowerCase() === "cookie")?.[1]
  }

  return Object.entries(headers).find(([key]) => key.toLowerCase() === "cookie")?.[1]
}

const getRequestAuthRevision = (options: Record<string, unknown>) => {
  const revision = options.__followAuthRevision
  return typeof revision === "number" ? revision : undefined
}

followClient.addResponseInterceptor(async (ctx) => {
  const { options, response } = ctx
  if (response.status === 401) {
    const currentCookie = getCookie()
    const requestCookie = getRequestCookie(options.headers)
    const requestAuthRevision = getRequestAuthRevision(options as Record<string, unknown>)
    const currentAuthRevision = getAuthStateRevision()

    if (typeof requestAuthRevision === "number" && requestAuthRevision < currentAuthRevision) {
      return ctx.response
    }

    if (currentCookie && requestCookie !== currentCookie) {
      return ctx.response
    }

    if (currentCookie) {
      return ctx.response
    }

    if (Date.now() - getLastAuthStateChangeAt() < 10_000) {
      return ctx.response
    }

    userActions.removeCurrentUser()
    destination.Login()
  } else if (response.status >= 400) {
    // try {
    //   const isJSON = response.headers.get("content-type")?.includes("application/json")
    //   const json = isJSON ? await response.json() : null
    //   if (isJSON && json?.code?.toString().startsWith("11")) {
    //   }
    // } catch (error) {
    //   console.error(`Request failed with status ${response.status}`, error)
    // }
  }

  return ctx.response
})
