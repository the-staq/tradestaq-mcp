import { z } from 'zod'
import http from 'node:http'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { loadConfig, saveConfig, clearToken, isAuthenticated } from '../config.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

export function registerAuthTools(server: McpServer) {

  server.tool(
    'login',
    'Log in to TradeStaq with email and password.',
    {
      email: z.string().describe('Your TradeStaq email address'),
      password: z.string().describe('Your TradeStaq password'),
    },
    async ({ email, password }) => {
      const config = loadConfig()
      try {
        const res = await fetch(`${config.baseUrl}/api/users/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        })
        const data = (await res.json()) as any
        if (!res.ok || !data.token) {
          const msg = data.errors?.[0]?.message || data.message || 'Login failed'
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
    'Log in to TradeStaq via browser. Opens a login page in your browser — you authenticate there and the token is saved automatically. No credentials enter the chat.',
    {},
    async (_args, extra) => {
      if (isAuthenticated()) {
        return { content: [{ type: 'text' as const, text: 'Already authenticated. Use logout to switch accounts.' }] }
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
            const tokenData = (await tokenRes.json()) as any

            const token = tokenData.access_token
            if (!tokenRes.ok || !token) {
              res.writeHead(400, { 'Content-Type': 'text/html' })
              res.end('<html><body><h2>Token exchange failed</h2><p>Please try again.</p></body></html>')
              srv.close()
              resolve({ isError: true, content: [{ type: 'text' as const, text: `Auth failed: ${tokenData.error || 'no token in response'}` }] })
              return
            }

            saveConfig({ ...config, token, tokenExpiresAt: Date.now() + (tokenData.expires_in || 604800) * 1000 })
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
          callbackUrl = `http://localhost:${port}/callback`

          try {
            // RFC 7591 Dynamic Client Registration. We register a new client each
            // run with our exact callback URL; redirect_uris must match exactly at
            // the authorize step, and our port is random each invocation. This
            // creates one OAuthClient document per auth attempt — a server-side
            // RFC 8252 loopback exception would let us cache a single client_id.
            const regRes = await fetch(`${config.baseUrl}/api/oauth/register`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                redirect_uris: [callbackUrl],
                client_name: 'TradeStaq MCP Client',
                grant_types: ['authorization_code'],
                response_types: ['code'],
                token_endpoint_auth_method: 'none',
                scope: 'mcp',
              }),
            })
            const regData = (await regRes.json()) as any
            if (!regRes.ok || !regData.client_id) {
              srv.close()
              resolve({ isError: true, content: [{ type: 'text' as const, text: `Auth failed: client registration rejected (${regData.error || regRes.status})` }] })
              return
            }
            clientId = regData.client_id

            // RFC 6749 §3.1 — redirect-based authorization entrypoint.
            const authorizeUrl = new URL(`${config.baseUrl}/api/oauth/authorize`)
            authorizeUrl.searchParams.set('response_type', 'code')
            authorizeUrl.searchParams.set('client_id', clientId!)
            authorizeUrl.searchParams.set('redirect_uri', callbackUrl)
            authorizeUrl.searchParams.set('scope', 'mcp')
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

  server.tool('check_auth', 'Check if you are authenticated with TradeStaq.', {}, async () => {
    if (isAuthenticated()) {
      const config = loadConfig()
      const expiresIn = config.tokenExpiresAt ? Math.round((config.tokenExpiresAt - Date.now()) / 3600000) : 'unknown'
      return { content: [{ type: 'text' as const, text: `Authenticated. Token expires in ~${expiresIn} hours.\nAPI: ${config.baseUrl}` }] }
    }
    return { content: [{ type: 'text' as const, text: 'Not authenticated. Use login (email/password) or authenticate (browser) to sign in.' }] }
  })

  server.tool('set_token', 'Manually set a JWT token. For advanced use only.', {
    token: z.string().describe('JWT token from TradeStaq'),
    baseUrl: z.string().optional().describe('API base URL (default: https://tradestaq.com)'),
  }, async ({ token, baseUrl }) => {
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

  server.tool('logout', 'Remove stored TradeStaq credentials.', {}, async () => {
    clearToken()
    return { content: [{ type: 'text' as const, text: 'Logged out. Use login to sign in again.' }] }
  })
}
