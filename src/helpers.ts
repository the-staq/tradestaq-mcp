import { ApiError } from './api.js'

export function jsonResult(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  }
}

export function withErrorHandling<T extends (...args: any[]) => Promise<any>>(handler: T): T {
  return (async (...args: any[]) => {
    try {
      return await handler(...args)
    } catch (err) {
      if (err instanceof ApiError) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: { code: err.code, message: err.message, retryable: err.retryable,
              ...(err.retryable ? { retryAfterMs: err.retryAfterMs ?? 5000 } : {}) }
          }, null, 2) }],
        }
      }
      // Non-ApiError (unexpected internal fault). Cap the raw message so a
      // large/exotic error string can't flood the agent's context.
      const rawMessage = (err as Error)?.message ?? 'Unknown error'
      const message = rawMessage.length > 300 ? `${rawMessage.slice(0, 300)}…` : rawMessage
      return {
        isError: true,
        content: [{ type: 'text' as const, text: JSON.stringify({
          error: { code: 'INTERNAL_ERROR', message, retryable: false }
        }) }],
      }
    }
  }) as T
}
