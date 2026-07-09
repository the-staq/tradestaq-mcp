import { loadConfig, saveConfig } from './config.js'
import { requestContext } from './request-context.js'

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retryable: boolean = false,
    public retryAfterMs?: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

const MAX_RETRIES = 2

// Backoff between retries. Skipped under Vitest so the test suite stays fast
// while production still waits out rate limits / transient 5xx.
function sleep(ms: number): Promise<void> {
  if (ms <= 0 || process.env.VITEST) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Exchange the stored refresh token for a fresh access+refresh pair (OAuth 2.1
// rotation, RFC 9700). stdio-only — hosted sessions never touch the shared file
// token. Returns true when the config was updated with a new access token.
async function oauthRefresh(): Promise<boolean> {
  const config = loadConfig()
  if (!config.refreshToken || !config.oauthClientId) return false
  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: config.refreshToken,
      client_id: config.oauthClientId,
    })
    const res = await fetch(`${config.baseUrl}/api/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
    if (!res.ok) {
      // invalid_grant → the refresh token is expired, revoked, or reuse-detected.
      // Clear stored tokens so the next call cleanly prompts re-authentication
      // instead of retrying a dead token forever.
      if (res.status === 400 || res.status === 401) {
        const c = loadConfig()
        saveConfig({ ...c, token: undefined, tokenExpiresAt: undefined, refreshToken: undefined, refreshExpiresAt: undefined })
      }
      return false
    }
    const data = (await res.json().catch(() => ({}))) as any
    if (!data.access_token) return false
    const c = loadConfig()
    saveConfig({
      ...c,
      token: data.access_token,
      tokenExpiresAt: Date.now() + (data.expires_in || 3600) * 1000,
      // Rotation: store the NEW refresh token; fall back to the old one only if
      // the server didn't rotate (shouldn't happen, but don't lose the session).
      refreshToken: data.refresh_token || c.refreshToken,
      refreshExpiresAt: Date.now() + 30 * 24 * 3600 * 1000,
    })
    return true
  } catch {
    return false
  }
}

async function refreshTokenIfNeeded(): Promise<void> {
  // Hosted (per-request bearer) sessions never refresh or write the shared file
  // token — that bearer is owned by the client connector's OAuth flow, and
  // writing it to the shared config would leak it across sessions.
  if (requestContext.getStore()) return
  const config = loadConfig()
  if (!config.token) return

  // OAuth path: rotate via the refresh token when the (short-lived, ~60min)
  // access token is within 5 minutes of expiry or already expired.
  if (config.refreshToken) {
    const skew = 5 * 60 * 1000
    if (config.tokenExpiresAt && config.tokenExpiresAt - Date.now() > skew) return
    await oauthRefresh()
    return
  }

  // Legacy path: Payload session tokens (email/password login), no OAuth refresh
  // token. Refresh via Payload's endpoint when expiring within 1 hour.
  if (!config.tokenExpiresAt) return
  const oneHour = 60 * 60 * 1000
  if (config.tokenExpiresAt - Date.now() > oneHour) return

  try {
    const res = await fetch(`${config.baseUrl}/api/users/refresh-token`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.token}`,
        'Content-Type': 'application/json',
      },
    })

    if (res.ok) {
      const data = (await res.json()) as any
      const newToken = data.refreshedToken || data.token || data.access_token
      if (newToken) {
        saveConfig({
          ...config,
          token: newToken,
          tokenExpiresAt: Date.now() + 7 * 24 * 3600 * 1000,
        })
      }
    }
    // If refresh fails, continue with existing token — it might still work
  } catch {
    // Silently continue — token refresh is best-effort
  }
}

// Parse a Retry-After header (integer seconds form) into milliseconds, capped.
// Guarded so test mocks without a real Headers object don't blow up.
function parseRetryAfter(res: Response): number | undefined {
  const headers = res.headers
  if (!headers || typeof headers.get !== 'function') return undefined
  const raw = headers.get('retry-after')
  if (!raw) return undefined
  const secs = Number(raw)
  return Number.isFinite(secs) && secs >= 0 ? Math.min(secs * 1000, 30_000) : undefined
}

export async function api<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown; timeout?: number } = {},
): Promise<T> {
  const store = requestContext.getStore()
  // Stdio mode: proactively rotate BEFORE reading the token, so an expired
  // access token is refreshed rather than sent stale. No-op when a per-request
  // store is present (hosted connectors own their own refresh).
  if (!store) await refreshTokenIfNeeded()

  const config = loadConfig()
  // Hosted mode (store present): use THIS request's bearer only — never fall
  // back to the shared file token, or one session would borrow another's auth.
  // Stdio mode (no store): the file token, exactly as before.
  let token = store ? store.token : config.token
  if (!token) {
    throw new ApiError(401, 'AUTH_EXPIRED', store
      ? 'Not authenticated. This hosted TradeStaq MCP server expects a bearer token from your client connector — authorize the TradeStaq connector (OAuth) so it attaches one per request.'
      : 'Not authenticated. Run the authenticate tool first.')
  }

  const url = `${config.baseUrl}${path}`
  let lastErr: ApiError | undefined
  let recovered401 = false

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0 && lastErr) {
      // Honor server Retry-After when present, else exponential backoff (1s, 2s) capped at 8s.
      const backoff = lastErr.retryAfterMs ?? Math.min(1000 * 2 ** (attempt - 1), 8000)
      await sleep(backoff)
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeout ?? 30_000)

    try {
      const res = await fetch(url, {
        method: options.method ?? 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-MCP-Source': 'tradestaq-mcp',
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      })

      // Parse the body defensively. A proxy or gateway can return HTML/text
      // (e.g. a 502 page) where we expect JSON; never let a parse failure
      // bubble up mislabeled as a NETWORK_ERROR.
      let data: any = {}
      let parseOk = true
      try {
        data = await res.json()
      } catch {
        parseOk = false
      }

      if (!res.ok) {
        const retryable = res.status === 429 || res.status >= 500
        const retryAfterMs = retryable ? parseRetryAfter(res) : undefined

        // OAuth insufficient_scope (RFC 6749 §5.2). The server-provided
        // `scope` and `error_description` fields end up in LLM context
        // verbatim, so treat them as untrusted: (1) only accept known scope
        // tokens, (2) drop `error_description` entirely to avoid
        // prompt-injection into the agent. Guidance to the agent is
        // phrased as user-surface advice, not as imperative tool calls.
        if (res.status === 403 && parseOk && data?.error === 'insufficient_scope') {
          const KNOWN = new Set(['mcp:read', 'mcp:paper', 'mcp:live', 'mcp'])
          const rawScope = typeof data?.scope === 'string' ? data.scope.split(/\s+/).filter(Boolean) : []
          const safeScope = rawScope.find((s: string) => KNOWN.has(s)) || 'a broader scope'
          throw new ApiError(
            403,
            'INSUFFICIENT_SCOPE',
            `This action requires ${safeScope === 'a broader scope' ? safeScope : `the '${safeScope}' OAuth scope`}. The current token does not grant it. Surface this to the user — do not re-authenticate without explicit user approval, since broader scopes expand what automated tools can do on their account.`,
            false,
          )
        }

        const code = parseOk ? (data?.error?.code ?? `HTTP_${res.status}`) : `HTTP_${res.status}`
        const message = parseOk
          ? (data?.error?.message ?? data?.error ?? data?.message ?? `API returned ${res.status}`)
          : `API returned ${res.status} with a non-JSON response`
        throw new ApiError(res.status, code, message, retryable, retryAfterMs)
      }

      // 2xx with an unparseable body: treat empty/no-content as an empty
      // object (common for write endpoints); the caller reads fields defensively.
      return (parseOk ? data : {}) as T
    } catch (err) {
      const apiErr =
        err instanceof ApiError
          ? err
          : (err as Error).name === 'AbortError'
            ? new ApiError(408, 'TIMEOUT', 'Request timed out', true)
            : new ApiError(0, 'NETWORK_ERROR', `Failed to reach TradeStaq API: ${(err as Error).message}`, true)

      // stdio: a 401 despite the proactive refresh (token revoked, clock skew,
      // or an expiry we missed) — try ONE rotation, then retry with the new
      // token. Bounded by recovered401 so a persistently-rejected token can't loop.
      if (apiErr.status === 401 && !store && !recovered401 && loadConfig().refreshToken) {
        recovered401 = true
        if (await oauthRefresh()) {
          const rotated = loadConfig().token
          if (rotated) {
            token = rotated
            continue
          }
        }
      }

      // Retry transient failures (429 / 5xx / timeout / network) with backoff.
      if (apiErr.retryable && attempt < MAX_RETRIES) {
        lastErr = apiErr
        continue
      }
      throw apiErr
    } finally {
      clearTimeout(timer)
    }
  }

  // Retries exhausted.
  throw lastErr ?? new ApiError(0, 'NETWORK_ERROR', 'Request failed after retries', true)
}
