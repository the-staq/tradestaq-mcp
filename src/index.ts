#!/usr/bin/env node

import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
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

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const version = fs.readFileSync(path.join(__dirname, '..', 'VERSION'), 'utf-8').trim()

const server = new McpServer(
  {
    name: 'tradestaq',
    version,
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
registerTradeTools(server)
registerCopyTradingTools(server)
registerAdvisorTools(server)
registerPrompts(server)

// Connect via stdio
const transport = new StdioServerTransport()
await server.connect(transport)
