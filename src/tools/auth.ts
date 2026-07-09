import { z } from 'zod'
import http from 'node:http'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { loadConfig, saveConfig, clearToken, isAuthenticated } from '../config.js'
import { api, ApiError } from '../api.js'
import { getRequestStore } from '../request-context.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

interface CheckAuthResponse {
  id: string
  name: string
  email: string
  telegramLinked: boolean
  tier: {
    name: string | null
    slug: string | null
    capabilities?: Record<string, boolean | undefined>
  } | null
  strategyLabBalanceUsd?: number
  token?: {
    clientId: string
    clientName: string
    scope: string
    expiresAt: string
  }
}

/**
 * Read a fetch Response body defensively. OAuth endpoints can sit behind a
 * CDN/proxy (Cloudflare here) that returns an empty or non-JSON body on a 5xx,
 * gateway timeout, or 204. A bare `res.json()` on an empty body throws the
 * opaque "Unexpected end of JSON input"; this surfaces the HTTP status and a
 * body snippet instead so the failure is diagnosable.
 */
async function readOAuthJson(res: Response): Promise<{ data: any; parseOk: boolean; raw: string }> {
  const raw = await res.text().catch(() => '')
  if (!raw) return { data: {}, parseOk: false, raw: '' }
  try {
    return { data: JSON.parse(raw), parseOk: true, raw }
  } catch {
    return { data: {}, parseOk: false, raw }
  }
}

export function registerAuthTools(server: McpServer, transport: 'http' | 'stdio' = 'stdio') {

  // Config-mutating / browser-launching auth tools only make sense on a local
  // (stdio) install, where the server runs on the user's machine and owns one
  // machine-wide credential. On a hosted server they would mutate process-shared
  // state or open a browser server-side, so they refuse with guidance toward
  // connector-level bearer auth.
  const hostedGuard = () => ({
    isError: true as const,
    content: [{
      type: 'text' as const,
      text: `Not available on a hosted TradeStaq MCP server (--http): this tool manages a local, machine-wide credential (or opens a browser) and only applies to local stdio installs. On a hosted server, authenticate at the connector level — your client obtains a bearer token via the OAuth flow advertised at /.well-known/oauth-protected-resource and sends it with each request.`,
    }],
  })

  server.tool(
    'login',
    'Log in to TradeStaq with email and password and store the returned access token locally. Simple credential login for automation and headless use; for interactive users prefer authenticate (browser OAuth, where credentials never enter the chat). Credentials are sent directly to the TradeStaq API over HTTPS and are not persisted — only the returned token is saved.',
    {
      email: z.string().describe('The user\'s TradeStaq account email address.'),
      password: z.string().describe('The user\'s TradeStaq password. Sent to the API over HTTPS; never stored.'),
    },
    { title: 'Log In', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async ({ email, password }) => {
      if (transport === 'http') return hostedGuard()
      const config = loadConfig()
      try {
        const res = await fetch(`${config.baseUrl}/api/users/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        })
        const { data, parseOk, raw } = await readOAuthJson(res)
        if (!res.ok || !data.token) {
          const msg = parseOk
            ? (data.errors?.[0]?.message || data.message || 'Login failed')
            : (raw ? `HTTP ${res.status} (non-JSON response)` : `HTTP ${res.status} with an empty response body`)
          return { isError: true, content: [{ type: 'text' as const, text: `Login failed: ${msg}` }] }
        }
        saveConfig({ ...config, token: data.token, tokenExpiresAt: Date.now() + 7 * 24 * 3600 * 1000 })
        const userName = data.user?.name || data.user?.email || email
        return { content: [{ type: 'text' as const, text: `Logged in as ${userName}. You can now use all TradeStaq tools.` }] }
      } catch (err) {
        return { isError: true, content: [{ type: 'text' as const, text: `Login failed: ${(err as Error).message}` }] }
      }
    },
  )

  server.tool(
    'authenticate',
    'Log in to TradeStaq via browser. Opens a login page in your browser — you authenticate there and the token is saved automatically. No credentials enter the chat.\n\nScope controls what the agent can do: "mcp:read" (view-only research agents), "mcp:paper" (paper-trade bots, safe default — cannot touch live money), "mcp:live" (full access including live-money deploys, live exchange connections, and wallet charges). Scopes are hierarchical: live implies paper implies read. When in doubt, pick paper first — the server returns 403 insufficient_scope if the agent tries a live action, and the user can always re-authorize with a broader scope.',
    {
      scope: z
        .string()
        .regex(/^mcp(:[a-z-]+)?(\s+mcp(:[a-z-]+)?)*$/, 'Scope must be space-separated mcp:* tokens')
        .default('mcp:paper')
        .describe('OAuth scope to request. Known values today: "mcp:read" (view-only research agents), "mcp:paper" (paper-trade bots, safe default — cannot touch live money), "mcp:live" (full access including live-money deploys, live exchange connections, and wallet charges). The server may add newer scopes; this parameter is intentionally a string so forward-compat works without an npm bump.'),
    },
    async ({ scope }, extra) => {
      // Hosted (HTTP) transport: the loopback callback server and `open`
      // browser launch below would run on the SERVER, not the user's machine,
      // so this tool can never complete a browser login remotely. Remote
      // clients authenticate at the connector level via the OAuth metadata this
      // server advertises at /.well-known/oauth-protected-resource. Fail fast
      // with guidance instead of spinning up an unreachable loopback listener.
      if (transport === 'http') {
        return {
          isError: true,
          content: [{
            type: 'text' as const,
            text: `This is a hosted TradeStaq MCP server, so the browser-OAuth "authenticate" tool does not apply — its loopback + browser step runs on the server, not your machine. Authenticate at the connector level instead: your MCP client discovers the OAuth flow from this server's /.well-known/oauth-protected-resource and attaches a bearer token automatically (authorize the TradeStaq connector in your client's settings). The "authenticate" tool only works for local (stdio) installs. If your client cannot perform connector OAuth, use "login" with email and password as a fallback.`,
          }],
        }
      }

      if (isAuthenticated()) {
        // isError:true so MCP agents treat this as a branch that needs
        // follow-up rather than a success. Otherwise an LLM trying to
        // upgrade scope sees "Already authenticated" as completion and
        // retries the scope-gated tool, which 403s again, and it loops.
        return {
          isError: true,
          content: [{
            type: 'text' as const,
            text: `Already authenticated. To request scope "${scope}", the existing token must be cleared first — run \`logout\`, then call \`authenticate\` again with scope: "${scope}". Doing this implicitly would change the scope of access the user previously consented to.`,
          }],
        }
      }

      const config = loadConfig()
      const codeVerifier = crypto.randomBytes(32).toString('base64url')
      const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url')
      const state = crypto.randomBytes(16).toString('hex')

      return new Promise((resolve) => {
        const srv = http.createServer(async (req, res) => {
          const url = new URL(req.url!, `http://localhost`)

          // Serve a simple "waiting" page at root
          if (url.pathname === '/') {
            res.writeHead(200, { 'Content-Type': 'text/html' })
            res.end('<html><body><h2>Waiting for TradeStaq authentication...</h2><p>Complete login in the other tab, then this page will update.</p></body></html>')
            return
          }

          if (url.pathname !== '/callback') { res.writeHead(404); res.end(); return }

          const code = url.searchParams.get('code')
          const returnedState = url.searchParams.get('state')
          const oauthError = url.searchParams.get('error')

          if (oauthError) {
            res.writeHead(400, { 'Content-Type': 'text/html' })
            res.end(`<html><body><h2>Authentication denied</h2><p>${oauthError}</p></body></html>`)
            srv.close()
            resolve({ isError: true, content: [{ type: 'text' as const, text: `Auth denied: ${oauthError}` }] })
            return
          }

          if (returnedState !== state || !code) {
            res.writeHead(400, { 'Content-Type': 'text/html' })
            res.end('<html><body><h2>Authentication failed</h2><p>Invalid callback. Please try again.</p></body></html>')
            srv.close()
            resolve({ isError: true, content: [{ type: 'text' as const, text: 'Authentication failed: invalid callback.' }] })
            return
          }

          try {
            // RFC 6749 §3.2 — token endpoint accepts application/x-www-form-urlencoded.
            const body = new URLSearchParams({
              grant_type: 'authorization_code',
              code,
              redirect_uri: callbackUrl,
              client_id: clientId!,
              code_verifier: codeVerifier,
            })
            const tokenRes = await fetch(`${config.baseUrl}/api/oauth/token`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: body.toString(),
            })
            const { data: tokenData, parseOk: tokParseOk, raw: tokRaw } = await readOAuthJson(tokenRes)

            const token = tokenData.access_token
            if (!tokenRes.ok || !token) {
              res.writeHead(400, { 'Content-Type': 'text/html' })
              res.end('<html><body><h2>Token exchange failed</h2><p>Please try again.</p></body></html>')
              srv.close()
              const detail = tokParseOk
                ? (tokenData.error_description || tokenData.error || 'no token in response')
                : (tokRaw
                    ? `token endpoint returned HTTP ${tokenRes.status} with a non-JSON body`
                    : `token endpoint returned HTTP ${tokenRes.status} with an empty body`)
              resolve({ isError: true, content: [{ type: 'text' as const, text: `Auth failed: ${detail}` }] })
              return
            }

            // Persist fresh (loadConfig) so the client_id/refresh-capable flag
            // just saved during registration isn't clobbered. Store the refresh
            // token for silent renewal; access tokens are short-lived now.
            saveConfig({
              ...loadConfig(),
              token,
              tokenExpiresAt: Date.now() + (tokenData.expires_in || 3600) * 1000,
              refreshToken: tokenData.refresh_token || undefined,
              refreshExpiresAt: tokenData.refresh_token ? Date.now() + 30 * 24 * 3600 * 1000 : undefined,
            })
            res.writeHead(200, { 'Content-Type': 'text/html' })
            res.end('<html><body><h2>Authenticated!</h2><p>You can close this window and return to your AI assistant.</p></body></html>')
            srv.close()
            resolve({ content: [{ type: 'text' as const, text: 'Successfully authenticated with TradeStaq via browser.' }] })
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'text/html' })
            res.end('<html><body><h2>Error</h2><p>Something went wrong. Please try again.</p></body></html>')
            srv.close()
            resolve({ isError: true, content: [{ type: 'text' as const, text: `Auth error: ${(err as Error).message}` }] })
          }
        })

        // Shared across callback handler via closure (assigned in listen callback below).
        let clientId: string | null = null
        let callbackUrl = ''

        srv.listen(0, '127.0.0.1', async () => {
          const port = (srv.address() as { port: number }).port
          // Actual callback URL with port — this is what the browser redirects to.
          callbackUrl = `http://127.0.0.1:${port}/callback`

          try {
            // Register a port-less loopback redirect_uri ONCE and cache the
            // client_id in mcp-config.json. Subsequent auths reuse the same
            // client_id. The server matches our actual port-specific callback
            // at the authorize step via the RFC 8252 §7.3 loopback exception.
            const registeredRedirect = 'http://127.0.0.1/callback'
            // Reuse a cached client_id only if it was registered WITH the
            // refresh_token grant; clients from older versions can't issue
            // refresh tokens, so re-register instead of reusing them.
            const cachedClientId =
              config.oauthClientIdForBaseUrl === config.baseUrl && config.oauthClientRefreshCapable
                ? config.oauthClientId
                : undefined

            if (cachedClientId) {
              clientId = cachedClientId
            } else {
              const regRes = await fetch(`${config.baseUrl}/api/oauth/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  redirect_uris: [registeredRedirect],
                  client_name: 'TradeStaq MCP Client',
                  grant_types: ['authorization_code', 'refresh_token'],
                  response_types: ['code'],
                  token_endpoint_auth_method: 'none',
                  scope,
                }),
              })
              const { data: regData, parseOk: regParseOk, raw: regRaw } = await readOAuthJson(regRes)
              if (!regRes.ok || !regData.client_id) {
                const detail = regParseOk
                  ? (regData.error_description || regData.error || `HTTP ${regRes.status}`)
                  : (regRaw
                      ? `HTTP ${regRes.status} with a non-JSON response body`
                      : `HTTP ${regRes.status} with an empty response body`)
                srv.close()
                resolve({ isError: true, content: [{ type: 'text' as const, text: `Auth failed: OAuth client registration at ${config.baseUrl}/api/oauth/register was rejected (${detail}).` }] })
                return
              }
              clientId = regData.client_id
              // Cache for subsequent auths against the same baseUrl.
              saveConfig({
                ...config,
                oauthClientId: regData.client_id,
                oauthClientIdForBaseUrl: config.baseUrl,
                oauthClientRefreshCapable: true,
              })
            }

            // RFC 6749 §3.1 — redirect-based authorization entrypoint.
            const authorizeUrl = new URL(`${config.baseUrl}/api/oauth/authorize`)
            authorizeUrl.searchParams.set('response_type', 'code')
            authorizeUrl.searchParams.set('client_id', clientId!)
            authorizeUrl.searchParams.set('redirect_uri', callbackUrl)
            authorizeUrl.searchParams.set('scope', scope)
            authorizeUrl.searchParams.set('state', state)
            authorizeUrl.searchParams.set('code_challenge', codeChallenge)
            authorizeUrl.searchParams.set('code_challenge_method', 'S256')

            // Try to open browser (best effort).
            const openCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
            execFile(openCmd, [authorizeUrl.href], () => {
              // Ignore errors — the URL is also returned in the notification below.
            })

            extra.sendNotification({
              method: 'notifications/message' as any,
              params: { level: 'info', data: `Open this URL to authenticate: ${authorizeUrl.href}` },
            }).catch(() => {})

            // NOTE: Do NOT resolve here — wait for the OAuth callback or timeout.
          } catch (err) {
            srv.close()
            resolve({ isError: true, content: [{ type: 'text' as const, text: `Failed to start auth: ${(err as Error).message}` }] })
          }

          // Timeout after 5 minutes.
          setTimeout(() => {
            srv.close()
            resolve({ isError: true, content: [{ type: 'text' as const, text: 'Auth timed out after 5 minutes. Please try again.' }] })
          }, 300_000)
        })
      })
    },
  )

  server.tool(
    'check_auth',
    'Preflight check before invoking other tools. Returns the authenticated user, OAuth scope on the current token (mcp:read / mcp:paper / mcp:live), tier capabilities (allowLiveTrading, allowAIBuilder, allowNewsTrading, allowMcpServer), Strategy Lab wallet balance (for cost-charging tools like generate_strategy), and the OAuth client name/expiry. Agents should call this at the start of a workflow to pick the narrowest scope needed and to surface cost/balance to the user before committing to a charge. Response is cached server-side for 30s per token.',
    {},
    async () => {
      const store = getRequestStore()
      const authed = store ? !!store.token : isAuthenticated()
      if (!authed) {
        return { content: [{ type: 'text' as const, text: store
          ? 'Not authenticated. This hosted TradeStaq MCP server expects a bearer token from your client connector — authorize the TradeStaq connector (OAuth) so it attaches one per request.'
          : 'Not authenticated. Use `authenticate` (browser OAuth, recommended — lets you pick a scope) or `login` (email/password) to sign in.' }] }
      }
      try {
        const data = await api<CheckAuthResponse>('/api/v1/user/me')
        const lines: string[] = []
        lines.push(`Authenticated as ${data.name || data.email} (${data.email}).`)

        if (data.token) {
          const expiresAt = new Date(data.token.expiresAt)
          const hoursLeft = Math.round((expiresAt.getTime() - Date.now()) / 3600000)
          lines.push('')
          lines.push(`OAuth client: ${data.token.clientName}`)
          lines.push(`Scope: ${data.token.scope}`)
          lines.push(`Expires: ${expiresAt.toISOString()} (~${hoursLeft}h)`)
          const scopes = data.token.scope.split(/\s+/).filter(Boolean)
          const hasLive = scopes.includes('mcp:live') || scopes.includes('mcp')
          const hasPaper = hasLive || scopes.includes('mcp:paper')
          lines.push(`Can trade live money: ${hasLive ? 'YES' : 'no (paper/read only)'}`)
          lines.push(`Can create paper exchanges + deploy paper bots: ${hasPaper ? 'YES' : 'no (read only)'}`)
        } else {
          lines.push('Auth method: session cookie (dashboard). Full account access; no OAuth scope restrictions.')
        }

        if (data.tier) {
          lines.push('')
          lines.push(`Subscription tier: ${data.tier.name || data.tier.slug || 'unknown'}`)
          if (data.tier.capabilities) {
            const caps = data.tier.capabilities
            const capLines = [
              `  Live trading: ${caps.allowLiveTrading ? 'yes' : 'no'}`,
              `  AI Strategy Builder: ${caps.allowAIBuilder ? 'yes' : 'no'}`,
              `  News-based trading: ${caps.allowNewsTrading ? 'yes' : 'no'}`,
              `  MCP server access: ${caps.allowMcpServer !== false ? 'yes' : 'no'}`,
            ]
            lines.push(...capLines)
          }
        }

        if (typeof data.strategyLabBalanceUsd === 'number') {
          lines.push('')
          lines.push(`Strategy Lab wallet balance: $${data.strategyLabBalanceUsd.toFixed(2)} USD`)
          lines.push('(generate_strategy charges $0.50/experiment; call with acknowledgeCost: true after confirming spend with the user.)')
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] }
      } catch (err) {
        // 401/403 mean the server actively rejected the token. Do NOT say
        // "Authenticated" — the local token check says yes but the server
        // disagrees, and the server is authoritative. Clear the stale token
        // so subsequent tool calls don't keep hitting the same wall.
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          if (!store) clearToken()  // never mutate the shared file token in hosted mode
          return {
            isError: true,
            content: [{
              type: 'text' as const,
              text: `Not authenticated. The server rejected the stored token (HTTP ${err.status}${err.code === 'INSUFFICIENT_SCOPE' ? ', insufficient_scope' : ''}). Run \`authenticate\` to sign in again.`,
            }],
          }
        }
        // Transient/pre-0.3.13.0 server: endpoint missing (404), network
        // error, 5xx, or timeout. Fall back to the local token expiry check
        // as the best we can do.
        const config = loadConfig()
        const hoursLeft = config.tokenExpiresAt ? Math.round((config.tokenExpiresAt - Date.now()) / 3600000) : 'unknown'
        const reason = err instanceof ApiError ? `${err.code}: ${err.message}` : (err as Error).message
        return {
          content: [{
            type: 'text' as const,
            text: `Authenticated (local token check only — extended preflight unavailable: ${reason}). Token expires in ~${hoursLeft}h. API: ${config.baseUrl}`,
          }],
        }
      }
    },
  )

  server.tool('set_token', 'Manually store a TradeStaq JWT access token instead of logging in through the browser. Advanced / automation use only — most users should call authenticate (browser OAuth) or login (email + password) instead. The token is saved locally to ~/.tradestaq/mcp-config.json with an assumed 7-day expiry. Use this when you already hold a valid token, e.g. in CI or a headless environment.', {
    token: z.string().describe('A valid TradeStaq JWT access token.'),
    baseUrl: z.string().optional().describe('Optional API base URL override for self-hosted or staging servers. Defaults to the production TradeStaq API.'),
  }, { title: 'Set Token', readOnlyHint: false, destructiveHint: false, idempotentHint: true }, async ({ token, baseUrl }) => {
    if (transport === 'http') return hostedGuard()
    const config = loadConfig()
    saveConfig({
      ...config,
      token,
      tokenExpiresAt: Date.now() + 7 * 24 * 3600 * 1000,
      ...(baseUrl ? { baseUrl } : {}),
    })
    return { content: [{ type: 'text' as const, text: 'Token saved. You can now use all TradeStaq tools.' }] }
  })

  server.tool(
    'connect_exchange',
    'Connect a new exchange account via browser. Opens a page where you securely enter your exchange API keys. Keys never enter the chat.',
    {},
    async () => {
      if (transport === 'http') return hostedGuard()
      const config = loadConfig()
      const url = `${config.baseUrl}/dashboard/exchanges/new`

      try {
        const openCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
        execFile(openCmd, [url], () => {
          // Ignore errors — the URL is also returned in the response
        })
      } catch {
        // Best effort — URL is in the response text
      }

      return {
        content: [{
          type: 'text' as const,
          text: `Opening TradeStaq exchange setup page in your browser.\n\nURL: ${url}\n\nAdd your exchange API key and secret there. Once connected, use list_exchanges to see your accounts.`,
        }],
      }
    },
  )

  server.tool('logout', 'Remove the stored TradeStaq credentials from local config (~/.tradestaq/mcp-config.json), signing the user out. Also clears the cached OAuth client so the next authenticate registers cleanly — call this before re-authenticating with a different scope.', {}, { title: 'Log Out', readOnlyHint: false, destructiveHint: false, idempotentHint: true }, async () => {
    if (transport === 'http') return hostedGuard()
    clearToken()
    return { content: [{ type: 'text' as const, text: 'Logged out. Use login to sign in again.' }] }
  })
}
