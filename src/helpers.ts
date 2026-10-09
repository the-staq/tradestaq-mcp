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

/**
 * The one error result shape every tool returns: `{ error: { code, message, retryable,
 * retryAfterMs?, ...fields } }`. `fields` must already be allowlisted by the caller.
 */
export function errorResult(
  code: string,
  message: string,
  { retryable = false, retryAfterMs, fields }: { retryable?: boolean; retryAfterMs?: number; fields?: Record<string, unknown> } = {},
) {
  const error: Record<string, unknown> = { code, message, retryable,
    ...(retryable ? { retryAfterMs: retryAfterMs ?? 5000 } : {}) }
  // Extra fields never replace the core ones.
  for (const [k, v] of Object.entries(fields ?? {})) {
    if (!(k in error) && v !== undefined) error[k] = v
  }
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify({ error }, null, 2) }],
  }
}

export function withErrorHandling<T extends (...args: any[]) => Promise<any>>(handler: T): T {
  return (async (...args: any[]) => {
    try {
      return await handler(...args)
    } catch (err) {
      if (err instanceof ApiError) {
        return errorResult(err.code, err.message, { retryable: err.retryable, retryAfterMs: err.retryAfterMs, fields: err.fields })
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
