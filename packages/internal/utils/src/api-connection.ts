interface ErrorContext {
  response: Response | null
  options: { signal?: AbortSignal | null }
}

interface ApiConnectionClient {
  addResponseInterceptor: (interceptor: (ctx: { response: Response }) => Response) => unknown
  addErrorInterceptor: (interceptor: (ctx: ErrorContext) => void) => unknown
}

interface ApiConnectionHandlers {
  onUnreachable: () => void
  onRecovered?: () => void
}

/**
 * A request that fails without any response never reached the server: DNS failure, refused or
 * reset connection, offline device, or a timeout. Requests cancelled by the caller don't count.
 */
const isConnectionFailure = ({ response, options }: ErrorContext) =>
  !response && !options.signal?.aborted

/**
 * Notifies once when the API stops being reachable, and once when it responds again, so that
 * a burst of failing requests produces a single prompt.
 */
export const trackApiConnection = (
  client: ApiConnectionClient,
  handlers: ApiConnectionHandlers,
) => {
  let unreachable = false

  client.addResponseInterceptor(({ response }) => {
    if (unreachable) {
      unreachable = false
      handlers.onRecovered?.()
    }
    return response
  })

  client.addErrorInterceptor((ctx) => {
    if (!unreachable && isConnectionFailure(ctx)) {
      unreachable = true
      handlers.onUnreachable()
    }
    // Returning nothing keeps the SDK's default error handling.
  })
}
