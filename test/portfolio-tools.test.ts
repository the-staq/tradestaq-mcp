import { describe, it, expect, vi, beforeEach } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerPortfolioTools } from '../src/tools/portfolio.js'

const { mockApi } = vi.hoisted(() => ({ mockApi: vi.fn() }))
vi.mock('../src/api.js', () => ({ api: mockApi }))

beforeEach(() => {
  vi.clearAllMocks()
})

function getToolHandler(name: string) {
  const server = new McpServer(
    { name: 'test-server', version: '0.0.1' },
    { capabilities: { logging: {} } },
  )
  const toolSpy = vi.spyOn(server, 'tool')
  registerPortfolioTools(server)
  const call = toolSpy.mock.calls.find((c) => c[0] === name)
  if (!call) throw new Error(`tool ${name} was not registered`)
  return call[call.length - 1] as (args: any) => Promise<any>
}

async function textOf(result: any) {
  return result.content[0].text
}

async function jsonOf(result: any) {
  return JSON.parse(result.content[0].text)
}

describe('get_positions', () => {
  it('reads GET /api/v1/positions, not /api/v1/portfolio (which never returns a positions array)', async () => {
    mockApi.mockResolvedValue({
      positions: [{
        symbol: 'BTC/USDT', side: 'long', size: 0.5, entryPrice: 60000, markPrice: 61000,
        pnl: 500, percentage: 1.6, exchange: 'binance', exchangeId: 'ex-1', leverage: 3,
      }],
      count: 1,
      failedExchanges: [],
    })

    const handler = getToolHandler('get_positions')
    const result = await handler({})

    expect(mockApi).toHaveBeenCalledWith('/api/v1/positions')
    expect(await jsonOf(result)).toEqual([{
      symbol: 'BTC/USDT', side: 'long', size: 0.5,
      entryPrice: 60000, currentPrice: 61000,
      pnl: 500, pnlPercent: 1.6, exchange: 'binance', exchangeId: 'ex-1', leverage: 3,
    }])
  })

  it('reports no positions instead of crashing on an empty list', async () => {
    mockApi.mockResolvedValue({ positions: [], count: 0, failedExchanges: [] })
    const handler = getToolHandler('get_positions')
    const result = await handler({})
    expect(await textOf(result)).toBe('No open positions.')
  })

  it('filters by exchange name client-side since the backend has no such query param', async () => {
    mockApi.mockResolvedValue({
      positions: [
        { symbol: 'BTC/USDT', side: 'long', size: 1, exchange: 'binance', exchangeId: 'ex-1' },
        { symbol: 'ETH/USDT', side: 'long', size: 1, exchange: 'kucoin', exchangeId: 'ex-2' },
      ],
    })
    const handler = getToolHandler('get_positions')
    const result = await handler({ exchange: 'kucoin' })
    const body = await jsonOf(result)
    expect(body).toHaveLength(1)
    expect(body[0].exchange).toBe('kucoin')
  })
})

describe('get_portfolio', () => {
  it('reads the real /api/v1/portfolio shape (total, not totalBalance) and counts active bots from a separate call', async () => {
    mockApi
      .mockResolvedValueOnce({
        total: 10500.25, change24h: 2.1,
        exchanges: [{ name: 'binance', platform: 'binance', balance: 5000 }],
        topAssets: [], connected: true,
      })
      .mockResolvedValueOnce({
        docs: [
          { id: 'b1', status: 'active' },
          { id: 'b2', status: 'stopped' },
          { id: 'b3', status: 'active' },
        ],
      })

    const handler = getToolHandler('get_portfolio')
    const result = await handler({})

    expect(await jsonOf(result)).toEqual({
      totalBalance: 10500.25,
      change24h: 2.1,
      exchanges: [{ name: 'binance', platform: 'binance', balance: 5000 }],
      activeBots: 2,
    })
  })

  it('still reports balance if the bots call fails', async () => {
    mockApi
      .mockResolvedValueOnce({ total: 100, change24h: 0, exchanges: [] })
      .mockRejectedValueOnce(new Error('boom'))

    const handler = getToolHandler('get_portfolio')
    const result = await handler({})
    const body = await jsonOf(result)
    expect(body.totalBalance).toBe(100)
    expect(body.activeBots).toBe(0)
  })
})
