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
              ...(err.retryable ? { retryAfterMs: 5000 } : {}) }
          }, null, 2) }],
        }
      }
      return {
        isError: true,
        content: [{ type: 'text' as const, text: JSON.stringify({
          error: { code: 'INTERNAL_ERROR', message: (err as Error).message, retryable: false }
        }) }],
      }
    }
  }) as T
}
