import { describe, it, expect, vi, beforeEach } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerAuthTools } from '../src/tools/auth.js'
import { registerMarketTools } from '../src/tools/market.js'
import { registerPortfolioTools } from '../src/tools/portfolio.js'
import { registerStrategyTools } from '../src/tools/strategy.js'
import { registerBacktestTools } from '../src/tools/backtest.js'
import { registerBotTools } from '../src/tools/bot.js'
import { registerTradeTools } from '../src/tools/trades.js'
import { registerCopyTradingTools } from '../src/tools/copy-trading.js'
import { registerAdvisorTools } from '../src/tools/advisor.js'

beforeEach(() => {
  vi.clearAllMocks()
})

function createServer() {
  return new McpServer(
    { name: 'test-server', version: '0.0.1' },
    { capabilities: { logging: {} } },
  )
}

describe('tool registration', () => {
  it('registerAuthTools registers without error', () => {
    const server = createServer()
    expect(() => registerAuthTools(server)).not.toThrow()
  })

  it('registerMarketTools registers without error', () => {
    const server = createServer()
    expect(() => registerMarketTools(server)).not.toThrow()
  })

  it('registerPortfolioTools registers without error', () => {
    const server = createServer()
    expect(() => registerPortfolioTools(server)).not.toThrow()
  })

  it('registerStrategyTools registers without error', () => {
    const server = createServer()
    expect(() => registerStrategyTools(server)).not.toThrow()
  })

  it('registerBacktestTools registers without error', () => {
    const server = createServer()
    expect(() => registerBacktestTools(server)).not.toThrow()
  })

  it('registerBotTools registers without error', () => {
    const server = createServer()
    expect(() => registerBotTools(server)).not.toThrow()
  })

  it('registerTradeTools registers without error', () => {
    const server = createServer()
    expect(() => registerTradeTools(server)).not.toThrow()
  })

  it('registerCopyTradingTools registers without error', () => {
    const server = createServer()
    expect(() => registerCopyTradingTools(server)).not.toThrow()
  })

  it('registerAdvisorTools registers without error', () => {
    const server = createServer()
    expect(() => registerAdvisorTools(server)).not.toThrow()
  })
})
