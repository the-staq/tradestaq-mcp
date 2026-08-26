import { api, ApiError } from './api.js'

export function jsonResult(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  }
}

/**
 * Best-effort strategy name lookup, owner-authoritative first with a
 * marketplace fallback (same pattern get_strategy uses in strategy.ts).
 * Never throws -- callers that just want a human-readable label for
 * something else (e.g. naming a backtest) shouldn't fail the whole
 * operation because a name lookup 403'd or 404'd. Falls back to the raw ID.
 */
export async function resolveStrategyName(id: string): Promise<string> {
  try {
    const raw = await api<any>(`/api/user-strategies/${id}`)
    const name = (raw.data || raw)?.name
    if (name) return name
  } catch (err) {
    if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
      try {
        const raw = await api<any>(`/api/tradedroid/strategies/${id}`)
        const name = (raw.doc || raw)?.name
        if (name) return name
      } catch {
        // Fall through to the ID below.
      }
    }
  }
  return id
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
