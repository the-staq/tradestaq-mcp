#!/usr/bin/env node

import fs from 'node:fs'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { requestContext } from './request-context.js'
import { registerAuthTools } from './tools/auth.js'
import { registerMarketTools } from './tools/market.js'
import { registerPortfolioTools } from './tools/portfolio.js'
import { registerStrategyTools } from './tools/strategy.js'
import { registerBacktestTools } from './tools/backtest.js'
import { registerBotTools } from './tools/bot.js'
import { registerTradeTools } from './tools/trades.js'
import { registerCopyTradingTools } from './tools/copy-trading.js'
import { registerAdvisorTools } from './tools/advisor.js'
import { registerPrompts } from './prompts/index.js'
import { registerResources } from './resources/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const version = fs.readFileSync(path.join(__dirname, '..', 'VERSION'), 'utf-8').trim()

const mode = process.argv.includes('--http') ? 'http' : 'stdio'
const port = parseInt(process.env.MCP_PORT || '3100', 10)

function createServer(transport: 'http' | 'stdio'): McpServer {
  const server = new McpServer(
    { name: 'tradestaq', version },
    { capabilities: { logging: {} } },
  )

  registerAuthTools(server, transport)
  registerMarketTools(server)
  registerPortfolioTools(server)
  registerStrategyTools(server)
  registerBacktestTools(server)
  registerBotTools(server)
  registerTradeTools(server)
  registerCopyTradingTools(server)
  registerAdvisorTools(server)
  registerPrompts(server)
  registerResources(server)

  return server
}

if (mode === 'http') {
  // Streamable HTTP transport, STATELESS: a fresh server+transport per request,
  // so a restart or deploy never drops live sessions (there are none to drop).

  const httpServer = http.createServer(async (req, res) => {
    // CORS headers for browser-based MCP clients
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id, Authorization')
    res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id, WWW-Authenticate')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    // Health check
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', version, transport: 'stateless' }))
      return
    }

    // OAuth 2.0 Protected Resource Metadata (RFC 9728).
    // Spec-correct location — served from the resource's own origin, with
    // `resource` matching the scanned origin + path. Points MCP clients at
    // the authorization server on the TradeStaq web app so they can discover
    // /authorize and /token via RFC 8414 /.well-known/oauth-authorization-server.
    if (req.url === '/.well-known/oauth-protected-resource') {
      const mcpUrl = process.env.MCP_PUBLIC_URL || 'https://mcp.tradestaq.com/mcp'
      const authServer = process.env.TRADESTAQ_BASE_URL || 'https://www.tradestaq.com'
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=300, s-maxage=3600',
      })
      res.end(
        JSON.stringify({
          resource: mcpUrl,
          authorization_servers: [authServer],
          scopes_supported: ['mcp:read', 'mcp:paper', 'mcp:live'],
          bearer_methods_supported: ['header'],
          resource_documentation: `${authServer}/docs/mcp/overview`,
        }),
      )
      return
    }

    // MCP endpoint — stateless: no session map, so restarts/deploys can't drop
    // live sessions. Each POST spins up a throwaway server+transport.
    if (req.url === '/mcp') {
      // Per-request bearer for hosted auth. Tools/api() read THIS request's
      // token via requestContext and never the shared file token.
      const _authz = req.headers['authorization']
      const bearer =
        typeof _authz === 'string' && _authz.toLowerCase().startsWith('bearer ')
          ? _authz.slice(7).trim()
          : undefined

      // No bearer → challenge (RFC 9728 §5.1). An unauthenticated connection now
      // reports as NOT connected in MCP clients (surfacing a Connect button)
      // instead of the old phantom "Connected" state, and points the client at
      // the protected-resource metadata so it can discover the OAuth flow.
      if (!bearer) {
        const mcpUrl = process.env.MCP_PUBLIC_URL || 'https://mcp.tradestaq.com/mcp'
        let metaUrl = 'https://mcp.tradestaq.com/.well-known/oauth-protected-resource'
        try {
          metaUrl = new URL('/.well-known/oauth-protected-resource', mcpUrl).href
        } catch {
          // keep the default
        }
        res.writeHead(401, {
          'Content-Type': 'application/json',
          'WWW-Authenticate': `Bearer resource_metadata="${metaUrl}"`,
        })
        res.end(
          JSON.stringify({
            error: 'unauthorized',
            error_description:
              'Authenticate the TradeStaq connector via OAuth; discover the flow at the linked protected-resource metadata.',
          }),
        )
        return
      }

      if (req.method !== 'POST') {
        // Stateless mode has no long-lived stream/session to GET or DELETE.
        res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST' })
        res.end(
          JSON.stringify({ error: 'method_not_allowed', error_description: 'Stateless MCP server — use POST.' }),
        )
        return
      }

      // Fresh, throwaway server+transport per request (stateless mode:
      // sessionIdGenerator undefined). Torn down when the response closes.
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      const server = createServer('http')
      res.on('close', () => {
        transport.close()
        server.close()
      })
      await server.connect(transport)
      await requestContext.run({ token: bearer }, () => transport.handleRequest(req, res))
      return
    }

    res.writeHead(404)
    res.end('Not found')
  })

  httpServer.listen(port, '0.0.0.0', () => {
    console.log(`TradeStaq MCP server v${version} (HTTP+SSE) listening on port ${port}`)
    console.log(`Endpoint: http://localhost:${port}/mcp`)
    console.log(`Health: http://localhost:${port}/health`)
  })
} else {
  // stdio transport — local process (Claude Desktop, Cursor, Claude Code)
  const server = createServer('stdio')
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
