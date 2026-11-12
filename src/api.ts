import { loadConfig, reloadConfig, saveConfig, isAuthenticated, withConfigLock, type McpConfig } from './config.js'
import { requestContext } from './request-context.js'

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retryable: boolean = false,
    public retryAfterMs?: number,
    // The parsed JSON error body, for callers that read structured fields (e.g. the
    // Strategy Lab quote_changed envelope). Never dumped into the generic error text.
    public details?: Record<string, unknown>,
    // Extra structured fields to show the agent next to code/message (withErrorHandling
    // adds them to the error object). Callers put only allowlisted, shape-checked values
    // here; never a raw server body.
    public fields?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

const MAX_RETRIES = 2

const SAFE_ERROR_CODE = /^[a-z0-9_]{1,64}$/i

/** A server-provided error code safe to put in front of the agent: a short identifier, nothing else. */
export function isSafeErrorCode(code: unknown): code is string {
  return typeof code === 'string' && SAFE_ERROR_CODE.test(code)
}

// Backoff between retries. Skipped under Vitest so the test suite stays fast
// while production still waits out rate limits / transient 5xx.
function sleep(ms: number): Promise<void> {
  if (ms <= 0 || process.env.VITEST) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Rotate the (short-lived, ~60 min) OAuth access token this long before it expires.
const REFRESH_SKEW_MS = 5 * 60 * 1000
// The refresh request runs while holding the cross-process config lock, so it must end
// well before the lock counts as stale (30s, config.ts).
const REFRESH_TIMEOUT_MS = 15_000

/**
 * An access token that can be sent as it is: present, not the one the server just refused,
 * and not within REFRESH_SKEW_MS of its expiry.
 */
function hasFreshAccessToken(config: McpConfig, refusedToken?: string): boolean {
  if (!config.token || config.token === refusedToken) return false
  return !config.tokenExpiresAt || config.tokenExpiresAt - Date.now() > REFRESH_SKEW_MS
}

// Exchange the stored refresh token for a fresh access+refresh pair (OAuth 2.1
// rotation, RFC 9700). stdio-only — hosted sessions never touch the shared file
// token. Returns true when the config now holds a usable access token: a new one,
// or one another process put there first.
//
// Refresh tokens are single-use: the server treats one presented twice as theft and
// revokes the whole token family, signing out every copy of this server. Two guards:
//
// - Within a process, concurrent callers (the client runs tool calls in parallel, e.g.
//   check_auth beside list_bots) share one refresh (single-flight).
// - Across processes sharing ~/.tradestaq/mcp-config.json (an interactive session plus
//   headless `claude -p` runs), the refresh runs under a lockfile, and re-reads the file
//   inside it: if another process already rotated the pair, this one uses that pair and
//   sends nothing, instead of the used refresh token it still holds in memory.
//
// `refusedToken`: the access token the server just answered 401 for. It does not count as
// usable even while its expiry is still ahead.
let refreshInFlight: Promise<boolean> | null = null
function oauthRefresh(refusedToken?: string): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = oauthRefreshLocked(refusedToken).finally(() => {
      refreshInFlight = null
    })
  }
  return refreshInFlight
}

async function oauthRefreshLocked(refusedToken?: string): Promise<boolean> {
  try {
    return await withConfigLock(() => oauthRefreshOnce(refusedToken))
  } catch {
    // No lock in time (another process is stuck mid-refresh) or the lockfile can't be
    // created. Never refresh without it: the other process may be sending this same refresh
    // token. Use whatever the file holds now; the next call tries again.
    return hasFreshAccessToken(reloadConfig(), refusedToken)
  }
}

// Runs holding the config lock.
async function oauthRefreshOnce(refusedToken?: string): Promise<boolean> {
  // The file, not this process's cached copy, is the truth here: another process may have
  // rotated the pair since this one cached it (our refresh token is then already used).
  const config = reloadConfig()
  if (hasFreshAccessToken(config, refusedToken)) return true
  if (!config.refreshToken || !config.oauthClientId) return false
  const sentRefreshToken = config.refreshToken
  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: sentRefreshToken,
      client_id: config.oauthClientId,
    })
    const res = await fetch(`${config.baseUrl}/api/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    })
    if (!res.ok) {
      // invalid_grant → the refresh token is expired, revoked, or reuse-detected.
      // Clear stored tokens so the next call cleanly prompts re-authentication
      // instead of retrying a dead token forever.
      // Only while the stored refresh token is still the one refused: if the file changed
      // meanwhile (a sign-in, or a copy of this server without the lock), those tokens stand.
      if (res.status === 400 || res.status === 401) {
        const c = reloadConfig()
        if (c.refreshToken === sentRefreshToken) {
          saveConfig({ ...c, token: undefined, tokenExpiresAt: undefined, refreshToken: undefined, refreshExpiresAt: undefined })
          return false
        }
        return hasFreshAccessToken(c, refusedToken)
      }
      return false
    }
    const data = (await res.json().catch(() => ({}))) as any
    if (!data.access_token) return false
    // Re-read so fields written meanwhile (e.g. a cached OAuth client) are kept.
    const c = reloadConfig()
    saveConfig({
      ...c,
      token: data.access_token,
      tokenExpiresAt: Date.now() + (data.expires_in || 3600) * 1000,
      // Rotation: store the NEW refresh token; fall back to the one sent only if
      // the server didn't rotate (shouldn't happen, but don't lose the session).
      refreshToken: data.refresh_token || sentRefreshToken,
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
  let config = loadConfig()
  // A missing or expiring token in this process's cached copy: look at the file first.
  // Another process sharing it may have signed in or rotated the tokens since. This is
  // also what api() reads before it throws AUTH_EXPIRED for a missing token.
  if (!hasFreshAccessToken(config)) config = reloadConfig()
  if (!config.token) return

  // OAuth path: rotate via the refresh token when the (short-lived, ~60min)
  // access token is within 5 minutes of expiry or already expired.
  if (config.refreshToken) {
    if (hasFreshAccessToken(config)) return
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

/**
 * Whether a call can be made right now, judged the way api() makes one. Hosted: this
 * request carries a bearer (the shared file token is never consulted). Stdio: the stored
 * token after the same proactive refresh api() does first, so an access token that expired
 * overnight while its refresh token is still good is rotated here, instead of reading as
 * "not authenticated" while every other tool goes on working.
 */
export async function hasUsableToken(): Promise<boolean> {
  const store = requestContext.getStore()
  if (store) return !!store.token
  await refreshTokenIfNeeded()
  return isAuthenticated()
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

export interface ApiOptions {
  method?: string
  body?: unknown
  /** Abort after this many ms (default 30s). */
  timeout?: number
  /**
   * false: send the request exactly ONCE. No retry on a timeout, 429, 5xx or network error,
   * and every error it throws has retryable: false, so the agent is never told to retry
   * either. For non-idempotent writes (closing a position, creating a bot), where a resend
   * after a timeout or a gateway 5xx can repeat an action the server already carried out.
   * The one 401 -> token refresh -> resend still happens: a 401 means the server did nothing.
   */
  retry?: boolean
  /** Extra request headers. They never replace Authorization, Content-Type or X-MCP-Source. */
  headers?: Record<string, string>
}

// Headers api() always sets itself; a caller's `headers` cannot replace them.
const FIXED_HEADERS = new Set(['authorization', 'content-type', 'x-mcp-source'])

function extraHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (!FIXED_HEADERS.has(name.toLowerCase())) out[name] = value
  }
  return out
}

export async function api<T = unknown>(
  path: string,
  options: ApiOptions = {},
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
  // retry: false → one send. Its errors are never retryable (below), so the loop only goes
  // round again for the 401 refresh resend.
  const retry = options.retry !== false
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
          ...extraHeaders(options.headers),
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
        const retryable = retry && (res.status === 429 || res.status >= 500)
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

        // The machine-readable code: `error.code` (nested envelope) or a top-level `code`
        // (e.g. the Strategy Lab basket 400s). It reaches the agent's context, so only a
        // short identifier is accepted; anything else falls back to HTTP_<status>.
        const code = (parseOk ? [data?.error?.code, data?.code].find(isSafeErrorCode) : undefined) ?? `HTTP_${res.status}`
        const message = parseOk
          ? (data?.error?.message ?? data?.error ?? data?.message ?? `API returned ${res.status}`)
          : `API returned ${res.status} with a non-JSON response`
        const details = parseOk && data && typeof data === 'object' && !Array.isArray(data)
          ? (data as Record<string, unknown>)
          : undefined
        throw new ApiError(res.status, code, message, retryable, retryAfterMs, details)
      }

      // 2xx with an unparseable body: treat empty/no-content as an empty
      // object (common for write endpoints); the caller reads fields defensively.
      return (parseOk ? data : {}) as T
    } catch (err) {
      const apiErr =
        err instanceof ApiError
          ? err
          : (err as Error).name === 'AbortError'
            ? new ApiError(408, 'TIMEOUT', 'Request timed out', retry)
            : new ApiError(0, 'NETWORK_ERROR', `Failed to reach TradeStaq API: ${(err as Error).message}`, retry)

      // stdio: a 401 despite the proactive refresh (token revoked, clock skew,
      // or an expiry we missed). Another process sharing the config file may
      // already have rotated the pair: then the file holds a newer access token,
      // used as it is. Otherwise try ONE rotation (under the lock, which re-reads
      // the file again), then retry with the new token. Bounded by recovered401
      // so a persistently-rejected token can't loop.
      if (apiErr.status === 401 && !store && !recovered401) {
        recovered401 = true
        const onDisk = reloadConfig()
        if (hasFreshAccessToken(onDisk, token)) {
          token = onDisk.token!
          continue
        }
        if (onDisk.refreshToken && (await oauthRefresh(token))) {
          const rotated = loadConfig().token
          if (rotated && rotated !== token) {
            token = rotated
            continue
          }
        }
      }

      // Retry transient failures (429 / 5xx / timeout / network) with backoff.
      if (retry && apiErr.retryable && attempt < MAX_RETRIES) {
        lastErr = apiErr
        continue
      }
      throw apiErr
    } finally {
      clearTimeout(timer)
    }
  }

  // Retries exhausted.
  throw lastErr ?? new ApiError(0, 'NETWORK_ERROR', 'Request failed after retries', retry)
}
