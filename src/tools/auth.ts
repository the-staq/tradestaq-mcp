import { z } from 'zod'
import http from 'node:http'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { loadConfig, saveConfig, clearToken, isAuthenticated } from '../config.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

export function registerAuthTools(server: McpServer) {

  server.tool('authenticate', 'Log in to TradeStaq via browser. Opens a secure browser window. Credentials never enter the chat.', {}, async () => {
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
        if (url.pathname !== '/callback') { res.writeHead(404); res.end(); return }

        const code = url.searchParams.get('code')
        const returnedState = url.searchParams.get('state')

        if (returnedState !== state || !code) {
          res.writeHead(400); res.end('Auth failed'); srv.close()
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
            res.writeHead(400); res.end('Token exchange failed'); srv.close()
            resolve({ isError: true, content: [{ type: 'text' as const, text: `Auth failed: ${tokenData.error || 'token exchange error'}` }] })
            return
          }

          saveConfig({ ...config, token: tokenData.token, tokenExpiresAt: Date.now() + tokenData.expires_in * 1000 })
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end('<html><body><h1>Authenticated!</h1><p>You can close this window.</p></body></html>')
          srv.close()
          resolve({ content: [{ type: 'text' as const, text: 'Successfully authenticated with TradeStaq.' }] })
        } catch (err) {
          res.writeHead(500); res.end('Error'); srv.close()
          resolve({ isError: true, content: [{ type: 'text' as const, text: `Auth error: ${(err as Error).message}` }] })
        }
      })

      srv.listen(0, '127.0.0.1', () => {
        const port = (srv.address() as { port: number }).port
        const callbackUrl = `http://localhost:${port}/callback`
        const authorizeUrl = `${config.baseUrl}/api/oauth/mcp/authorize?callback_url=${encodeURIComponent(callbackUrl)}&code_challenge=${codeChallenge}&state=${state}`

        fetch(authorizeUrl).then(r => r.json() as Promise<any>).then(data => {
          if (data.error) { srv.close(); resolve({ isError: true, content: [{ type: 'text' as const, text: `Auth failed: ${data.error}` }] }); return }

          let parsedUrl: URL
          try { parsedUrl = new URL(data.loginUrl) } catch {
            srv.close()
            resolve({ isError: true, content: [{ type: 'text' as const, text: 'Auth failed: server returned an invalid login URL.' }] })
            return
          }
          if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
            srv.close()
            resolve({ isError: true, content: [{ type: 'text' as const, text: 'Auth failed: server returned a non-HTTP login URL.' }] })
            return
          }

          const openCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
          execFile(openCmd, [parsedUrl.href])
          // Do NOT resolve here — wait for the OAuth callback or timeout
        }).catch(err => {
          srv.close()
          resolve({ isError: true, content: [{ type: 'text' as const, text: `Failed to start auth: ${(err as Error).message}` }] })
        })

        setTimeout(() => { srv.close(); resolve({ isError: true, content: [{ type: 'text' as const, text: 'Auth timed out after 5 minutes.' }] }) }, 300_000)
      })
    })
  })

  server.tool('check_auth', 'Check if you are authenticated with TradeStaq.', {}, async () => {
    if (isAuthenticated()) {
      const config = loadConfig()
      const expiresIn = config.tokenExpiresAt ? Math.round((config.tokenExpiresAt - Date.now()) / 3600000) : 'unknown'
      return { content: [{ type: 'text' as const, text: `Authenticated. Token expires in ~${expiresIn} hours.\nAPI: ${config.baseUrl}` }] }
    }
    return { content: [{ type: 'text' as const, text: 'Not authenticated. Run authenticate (browser) or set_token (manual) to log in.' }] }
  })

  server.tool('set_token', 'Manually set a JWT token for authentication. Use this when the browser OAuth flow is not available (e.g. in CLI or agent contexts). Get a token from your TradeStaq dashboard settings.', {
    token: z.string().describe('JWT token from TradeStaq'),
    baseUrl: z.string().optional().describe('API base URL (default: https://tradestaq.com)'),
  }, async ({ token, baseUrl }) => {
    const config = loadConfig()
    saveConfig({
      ...config,
      token,
      tokenExpiresAt: Date.now() + 7 * 24 * 3600 * 1000, // assume 7 day TTL
      ...(baseUrl ? { baseUrl } : {}),
    })
    return { content: [{ type: 'text' as const, text: 'Token saved. You can now use all TradeStaq tools.' }] }
  })

  server.tool('logout', 'Remove stored TradeStaq credentials.', {}, async () => {
    clearToken()
    return { content: [{ type: 'text' as const, text: 'Logged out. Run authenticate to log in again.' }] }
  })
}
