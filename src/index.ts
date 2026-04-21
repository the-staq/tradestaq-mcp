#!/usr/bin/env node

import fs from 'node:fs'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
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

function createServer(): McpServer {
  const server = new McpServer(
    { name: 'tradestaq', version },
    { capabilities: { logging: {} } },
  )

  registerAuthTools(server)
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
  // HTTP+SSE transport — multiple clients, stateful sessions
  const sessions = new Map<string, { server: McpServer; transport: StreamableHTTPServerTransport }>()

  const httpServer = http.createServer(async (req, res) => {
    // CORS headers for browser-based MCP clients
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id')
    res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    // Health check
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', version, sessions: sessions.size }))
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
          scopes_supported: ['mcp'],
          bearer_methods_supported: ['header'],
          resource_documentation: `${authServer}/docs/mcp/overview`,
        }),
      )
      return
    }

    // MCP endpoint
    if (req.url === '/mcp') {
      const sessionId = req.headers['mcp-session-id'] as string | undefined

      if (req.method === 'POST' && !sessionId) {
        // New session — create server + transport
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
        })
        const server = createServer()
        await server.connect(transport)

        transport.onclose = () => {
          const sid = transport.sessionId
          if (sid) sessions.delete(sid)
        }

        await transport.handleRequest(req, res)

        if (transport.sessionId) {
          sessions.set(transport.sessionId, { server, transport })
        }
        return
      }

      if (sessionId && sessions.has(sessionId)) {
        // Existing session
        const session = sessions.get(sessionId)!
        await session.transport.handleRequest(req, res)
        return
      }

      // Unknown session or missing session ID on non-init request
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Invalid or missing session' }))
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
  const server = createServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
