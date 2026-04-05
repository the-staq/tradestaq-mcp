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

          if (returnedState !== state || !code) {
            res.writeHead(400, { 'Content-Type': 'text/html' })
            res.end('<html><body><h2>Authentication failed</h2><p>Invalid callback. Please try again.</p></body></html>')
            srv.close()
            resolve({ isError: true, content: [{ type: 'text' as const, text: 'Authentication failed: invalid callback.' }] })
            return
          }

          try {
            const tokenRes = await fetch(`${config.baseUrl}/api/oauth/mcp/token`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ code, code_verifier: codeVerifier }),
            })
            const tokenData = (await tokenRes.json()) as any

            if (!tokenRes.ok) {
              res.writeHead(400, { 'Content-Type': 'text/html' })
              res.end('<html><body><h2>Token exchange failed</h2><p>Please try again.</p></body></html>')
              srv.close()
              resolve({ isError: true, content: [{ type: 'text' as const, text: `Auth failed: ${tokenData.error || 'token exchange error'}` }] })
              return
            }

            saveConfig({ ...config, token: tokenData.token, tokenExpiresAt: Date.now() + tokenData.expires_in * 1000 })
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

        srv.listen(0, '127.0.0.1', () => {
          const port = (srv.address() as { port: number }).port
          const callbackUrl = `http://localhost:${port}/callback`
          const authorizeUrl = `${config.baseUrl}/api/oauth/mcp/authorize?callback_url=${encodeURIComponent(callbackUrl)}&code_challenge=${codeChallenge}&state=${state}`

          fetch(authorizeUrl).then(r => r.json() as Promise<any>).then(data => {
            if (data.error) {
              srv.close()
              resolve({ isError: true, content: [{ type: 'text' as const, text: `Auth failed: ${data.error}` }] })
              return
            }

            const loginUrl = data.loginUrl
            if (!loginUrl) {
              srv.close()
              resolve({ isError: true, content: [{ type: 'text' as const, text: 'Auth failed: no login URL returned from server.' }] })
              return
            }

            // Validate URL
            let parsedUrl: URL
            try { parsedUrl = new URL(loginUrl) } catch {
              srv.close()
              resolve({ isError: true, content: [{ type: 'text' as const, text: 'Auth failed: server returned an invalid login URL.' }] })
              return
            }
            if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
              srv.close()
              resolve({ isError: true, content: [{ type: 'text' as const, text: 'Auth failed: server returned a non-HTTP login URL.' }] })
              return
            }

            // Try to open browser (best effort)
            const openCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
            execFile(openCmd, [parsedUrl.href], () => {
              // Ignore errors — the URL is also returned in the response
            })

            // Send logging notification so the MCP client can show the URL
            extra.sendNotification({
              method: 'notifications/message' as any,
              params: { level: 'info', data: `Open this URL to authenticate: ${parsedUrl.href}` },
            }).catch(() => {})

            // NOTE: Do NOT resolve here — wait for the OAuth callback or timeout.
            // The tool stays "running" until the user completes login in the browser.
          }).catch(err => {
            srv.close()
            resolve({ isError: true, content: [{ type: 'text' as const, text: `Failed to start auth: ${(err as Error).message}` }] })
          })

          // Timeout after 5 minutes
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

  server.tool('logout', 'Remove stored TradeStaq credentials.', {}, async () => {
    clearToken()
    return { content: [{ type: 'text' as const, text: 'Logged out. Use login to sign in again.' }] }
  })
}
