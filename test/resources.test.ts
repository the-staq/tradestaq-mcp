import { describe, it, expect, vi, beforeEach } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

// The resources kept their own field mappings after the tools were fixed, so they read
// fields the API never sends: the portfolio came back as change24h + exchanges only (no
// total balance, positions or active bots), and every bot without strategy, exchange,
// paper/live or PnL. They now share the tools' functions; these pin the real API shapes
// and that each resource returns what its tool returns.

const { mockApi } = vi.hoisted(() => ({ mockApi: vi.fn() }))
vi.mock('../src/api.js', () => ({ api: mockApi, hasUsableToken: async () => true }))

import { registerResources } from '../src/resources/index.js'
import { registerPortfolioTools } from '../src/tools/portfolio.js'
import { registerBotTools } from '../src/tools/bot.js'
import { registerStrategyTools } from '../src/tools/strategy.js'

// Real response shapes (mfanya-client /api/v1/portfolio, /api/v1/positions, /api/bots,
// /api/tradedroid/strategies).
const PORTFOLIO = { total: 1234.5, change24h: 1.2, exchanges: [{ name: 'Kucoin Paper', platform: 'kucoin', balance: 1000 }], topAssets: [], connected: 1 }
const POSITIONS = { positions: [{ symbol: 'BTC/USDT', side: 'long', size: 0.5, entryPrice: 60000, markPrice: 61000, pnl: 500, percentage: 1.6, exchange: 'Kucoin Paper', exchangeId: 'ex-1', leverage: 1 }] }
const BOTS = {
  docs: [
    { id: 'b1', name: 'Trade Wind · BTC · 4h', status: 'active', symbol: 'BTC/USDT', strategyDetails: { name: 'Trade Wind' }, exchanges: [{ name: 'kucoin', accountLabel: 'Kucoin Paper', isPaper: true }], stats: { totalPnl: -187.36 } },
    { id: 'b2', name: 'StormRider · ADA · 4h', status: 'paused', symbol: 'ADA/USDT:USDT', strategy: { name: 'StormRider' }, exchanges: [{ name: 'bybit', isPaper: false }], stats: { totalPnl: 3.26 } },
  ],
}
const STRATEGIES = { docs: [{ id: 's1', name: 'StormRider', description: 'Trend following', market: 'futures', timeframe: '4h', price: 0, rating: 4.6, activeBots: 12 }] }

function route(overrides: Record<string, unknown> = {}) {
  mockApi.mockImplementation(async (path: string) => {
    const key = path.split('?')[0]
    if (key in overrides) {
      const v = overrides[key]
      if (v instanceof Error) throw v
      return v
    }
    return ({ '/api/v1/portfolio': PORTFOLIO, '/api/v1/positions': POSITIONS, '/api/bots': BOTS, '/api/tradedroid/strategies': STRATEGIES } as Record<string, unknown>)[key]
  })
}

function server() {
  return new McpServer({ name: 't', version: '0' }, { capabilities: { resources: {} } })
}
async function readResource(name: string) {
  const s = server()
  const spy = vi.spyOn(s, 'resource')
  registerResources(s)
  const call = spy.mock.calls.find((c) => c[0] === name)!
  const res = await (call[call.length - 1] as any)(new URL(`tradestaq://${name}`))
  return JSON.parse(res.contents[0].text)
}
async function callTool(register: (s: McpServer) => void, name: string, args: unknown = {}) {
  const s = server()
  const spy = vi.spyOn(s, 'tool')
  register(s)
  const call = spy.mock.calls.find((c) => c[0] === name)!
  const res = await (call[call.length - 1] as any)(args)
  return JSON.parse(res.content[0].text)
}

beforeEach(() => {
  vi.clearAllMocks()
  route()
})

describe('tradestaq://portfolio', () => {
  it('has the total balance, active bots and open positions', async () => {
    const p = await readResource('portfolio')
    expect(p).toMatchObject({ totalBalance: 1234.5, change24h: 1.2, activeBots: 1 })
    expect(p.exchanges).toEqual([{ name: 'Kucoin Paper', platform: 'kucoin', balance: 1000 }])
    expect(p.positions).toEqual([{ symbol: 'BTC/USDT', side: 'long', size: 0.5, entryPrice: 60000, currentPrice: 61000, pnl: 500, pnlPercent: 1.6, exchange: 'Kucoin Paper', exchangeId: 'ex-1', leverage: 1 }])
  })

  it('is get_portfolio plus get_positions, field for field', async () => {
    const p = await readResource('portfolio')
    const { positions, ...summary } = p
    expect(summary).toEqual(await callTool(registerPortfolioTools, 'get_portfolio'))
    expect(positions).toEqual(await callTool(registerPortfolioTools, 'get_positions'))
  })

  it('a failed positions read keeps the summary and says so', async () => {
    route({ '/api/v1/positions': new Error('positions timed out') })
    const p = await readResource('portfolio')
    expect(p).toMatchObject({ totalBalance: 1234.5, activeBots: 1, positions: [], positionsError: 'positions timed out' })
  })
})

describe('tradestaq://bots', () => {
  it('has strategy, exchange, paper/live and PnL for every bot', async () => {
    expect(await readResource('bots')).toEqual([
      { id: 'b1', name: 'Trade Wind · BTC · 4h', status: 'active', strategy: 'Trade Wind', symbol: 'BTC/USDT', exchange: 'Kucoin Paper', isPaper: true, pnl: -187.36 },
      { id: 'b2', name: 'StormRider · ADA · 4h', status: 'paused', strategy: 'StormRider', symbol: 'ADA/USDT:USDT', exchange: 'bybit', isPaper: false, pnl: 3.26 },
    ])
  })

  it('is list_bots, field for field', async () => {
    expect(await readResource('bots')).toEqual(await callTool(registerBotTools, 'list_bots'))
  })
})

describe('tradestaq://strategies', () => {
  it('reads the marketplace catalog and is list_strategies, field for field', async () => {
    const r = await readResource('strategies')
    expect(mockApi.mock.calls.at(-1)![0]).toMatch(/^\/api\/tradedroid\/strategies\?.*marketplace=true/)
    expect(r).toEqual([{ id: 's1', name: 'StormRider', description: 'Trend following', market: 'futures', timeframe: '4h', price: 0, rating: 4.6 }])
    expect(r).toEqual(await callTool(registerStrategyTools, 'list_strategies', { owned: false, limit: 50 }))
  })
})
