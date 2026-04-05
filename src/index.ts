#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { registerAuthTools } from './tools/auth.js'
import { registerMarketTools } from './tools/market.js'
import { registerPortfolioTools } from './tools/portfolio.js'
import { registerStrategyTools } from './tools/strategy.js'
import { registerBacktestTools } from './tools/backtest.js'
import { registerBotTools } from './tools/bot.js'
import { registerPrompts } from './prompts/index.js'

const server = new McpServer(
  {
    name: 'tradestaq',
    version: '0.1.0',
  },
  {
    capabilities: { logging: {} },
  },
)

// Register all tools and prompts
registerAuthTools(server)
registerMarketTools(server)
registerPortfolioTools(server)
registerStrategyTools(server)
registerBacktestTools(server)
registerBotTools(server)
registerPrompts(server)

// Connect via stdio
const transport = new StdioServerTransport()
await server.connect(transport)
