import { describe, expect, it, vi } from "vitest"

import { trackApiConnection } from "./api-connection"

type ResponseInterceptor = (ctx: { response: Response }) => Response
type ErrorInterceptor = (ctx: {
  response: Response | null
  options: { signal?: AbortSignal | null }
}) => void

const setup = () => {
  let onResponse!: ResponseInterceptor
  let onError!: ErrorInterceptor
  const handlers = { onUnreachable: vi.fn(), onRecovered: vi.fn() }

  trackApiConnection(
    {
      addResponseInterceptor: (interceptor) => {
        onResponse = interceptor
      },
      addErrorInterceptor: (interceptor) => {
        onError = interceptor
      },
    },
    handlers,
  )

  return {
    handlers,
    respond: (status = 200) => onResponse({ response: new Response(null, { status }) }),
    fail: (ctx: Partial<Parameters<ErrorInterceptor>[0]> = {}) =>
      onError({ response: null, options: {}, ...ctx }),
  }
}

describe("trackApiConnection", () => {
  it("notifies once for a burst of requests that get no response", () => {
    const { handlers, fail } = setup()

    fail()
    fail()
    fail()

    expect(handlers.onUnreachable).toHaveBeenCalledTimes(1)
    expect(handlers.onRecovered).not.toHaveBeenCalled()
  })

  it("treats a timeout as a connection failure", () => {
    const { handlers, fail } = setup()

    // The SDK aborts its own controller on timeout, the caller's signal stays untouched.
    fail({ options: { signal: new AbortController().signal } })

    expect(handlers.onUnreachable).toHaveBeenCalledTimes(1)
  })

  it("ignores requests cancelled by the caller", () => {
    const { handlers, fail } = setup()
    const controller = new AbortController()
    controller.abort()

    fail({ options: { signal: controller.signal } })

    expect(handlers.onUnreachable).not.toHaveBeenCalled()
  })

  it("ignores errors that carry a response", () => {
    const { handlers, fail } = setup()

    fail({ response: new Response(null, { status: 500 }) })

    expect(handlers.onUnreachable).not.toHaveBeenCalled()
  })

  it("recovers on any response and notifies again on the next outage", () => {
    const { handlers, fail, respond } = setup()

    respond()
    expect(handlers.onRecovered).not.toHaveBeenCalled()

    fail()
    respond(401)
    expect(handlers.onRecovered).toHaveBeenCalledTimes(1)

    fail()
    expect(handlers.onUnreachable).toHaveBeenCalledTimes(2)
  })

  it("passes the response through and keeps the SDK's default error handling", () => {
    const { fail, respond } = setup()
    const result = respond()

    expect(result).toBeInstanceOf(Response)
    expect(fail()).toBeUndefined()
  })
})
