import { describe, it, expect, vi, beforeEach } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerBotTools } from '../src/tools/bot.js'

const { mockApi } = vi.hoisted(() => ({ mockApi: vi.fn() }))
vi.mock('../src/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api.js')>('../src/api.js')
  return { ...actual, api: mockApi }
})

beforeEach(() => {
  vi.clearAllMocks()
})

function getToolHandler(name: string) {
  const server = new McpServer(
    { name: 'test-server', version: '0.0.1' },
    { capabilities: { logging: {} } },
  )
  const toolSpy = vi.spyOn(server, 'tool')
  registerBotTools(server)
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

const PAPER_EXCHANGE = { id: 'ex-paper-1', name: 'Bybit Futures Paper', isPaper: true }
const LIVE_EXCHANGE = { id: 'ex-live-1', name: 'Hyperliquid Main Account', isPaper: false }

describe('list_bots', () => {
  it('reads the real GET /api/bots shape: { docs: [...] } with strategyDetails/exchanges, not strategyName/exchangeName/paperTrading', async () => {
    mockApi.mockResolvedValue({
      docs: [{
        id: 'bot-1', name: 'GridRunner BTC', status: 'active', symbol: 'BTC/USDC:USDC',
        strategyDetails: { name: 'GridRunner' },
        exchanges: [{ id: 'ex-1', name: 'dydx', accountLabel: 'Olumide-dydxMain', isPaper: false }],
        stats: { totalPnl: 12.5 },
      }],
    })

    const handler = getToolHandler('list_bots')
    const result = await handler({})

    expect(await jsonOf(result)).toEqual([{
      id: 'bot-1', name: 'GridRunner BTC', status: 'active',
      strategy: 'GridRunner', symbol: 'BTC/USDC:USDC',
      exchange: 'Olumide-dydxMain', isPaper: false, pnl: 12.5,
    }])
  })

  it('reports no bots instead of crashing on an empty list', async () => {
    mockApi.mockResolvedValue({ docs: [] })
    const handler = getToolHandler('list_bots')
    const result = await handler({})
    expect(await textOf(result)).toBe('No trading bots. Use deploy_bot to create one.')
  })
})

describe('get_bot_status', () => {
  it('unwraps the real GET /api/bots/:id { doc: {...} } envelope and reads positionSizing, not flat leverage/stopLoss fields', async () => {
    mockApi.mockResolvedValue({
      doc: {
        id: 'bot-1', name: 'GridRunner BTC', status: 'active', symbol: 'BTC/USDC:USDC', createdAt: '2026-01-01',
        strategy: { name: 'GridRunner' },
        exchanges: [{ id: 'ex-1', accountLabel: 'Olumide-dydxMain', isPaper: false }],
        stats: { totalPnl: 12.5, totalTrades: 10, winningTrades: 7 },
        positionSizing: { leverage: 3, stopLoss: 5, takeProfit: 10 },
        thirtyDayReturn: 4.2,
        openPosition: { symbol: 'BTC/USDC:USDC', side: 'long' },
      },
    })

    const handler = getToolHandler('get_bot_status')
    const result = await handler({ id: 'bot-1' })

    expect(await jsonOf(result)).toEqual({
      id: 'bot-1', name: 'GridRunner BTC', status: 'active',
      strategy: 'GridRunner', symbol: 'BTC/USDC:USDC', exchange: 'Olumide-dydxMain', isPaper: false,
      createdAt: '2026-01-01',
      performance: { pnl: 12.5, winRate: 70, totalTrades: 10, thirtyDayReturn: 4.2 },
      config: { leverage: 3, stopLoss: 5, takeProfit: 10 },
      openPosition: { symbol: 'BTC/USDC:USDC', side: 'long' },
    })
  })
})

describe('deploy_bot', () => {
  it('refuses live:false against a live exchange instead of silently deploying to real money', async () => {
    mockApi.mockResolvedValue({ docs: [LIVE_EXCHANGE] }) // GET /api/exchanges lookup

    const handler = getToolHandler('deploy_bot')
    const result = await handler({ strategyId: 's1', exchangeId: 'ex-live-1', symbol: 'BTC/USDT', live: false, positionSizePercent: 10, leverage: 1 })

    expect(result.isError).toBe(true)
    const body = JSON.parse(result.content[0].text)
    expect(body.error.code).toBe('PAPER_LIVE_MISMATCH')
    expect(body.error.message).toContain('LIVE')
    // Must never have reached POST /api/bots.
    expect(mockApi).toHaveBeenCalledTimes(1)
  })

  it('refuses live:true against a paper exchange', async () => {
    mockApi.mockResolvedValue({ docs: [PAPER_EXCHANGE] })

    const handler = getToolHandler('deploy_bot')
    const result = await handler({ strategyId: 's1', exchangeId: 'ex-paper-1', symbol: 'BTC/USDT', live: true, positionSizePercent: 10, leverage: 1 })

    expect(result.isError).toBe(true)
    const body = JSON.parse(result.content[0].text)
    expect(body.error.code).toBe('PAPER_LIVE_MISMATCH')
    expect(body.error.message).toContain('PAPER')
  })

  it('errors clearly when the exchange id does not resolve, instead of deploying blind', async () => {
    mockApi.mockResolvedValue({ docs: [PAPER_EXCHANGE] })
    const handler = getToolHandler('deploy_bot')
    const result = await handler({ strategyId: 's1', exchangeId: 'does-not-exist', symbol: 'BTC/USDT', live: false, positionSizePercent: 10, leverage: 1 })
    expect(result.isError).toBe(true)
    const body = JSON.parse(result.content[0].text)
    expect(body.error.code).toBe('EXCHANGE_NOT_FOUND')
  })

  it('sends the real POST /api/bots body shape: triggerType, strategy, exchange as array, nested positionSizing', async () => {
    mockApi
      .mockResolvedValueOnce({ docs: [PAPER_EXCHANGE] }) // GET /api/exchanges
      .mockResolvedValueOnce({ doc: { id: 'new-bot-1' } }) // POST /api/bots

    const handler = getToolHandler('deploy_bot')
    const result = await handler({
      strategyId: 'strat-1', exchangeId: 'ex-paper-1', symbol: 'BTC/USDC:USDC', market: 'futures',
      name: 'GridRunner BTC', live: false, positionSizePercent: 15, leverage: 2, stopLoss: 5, takeProfit: 10,
    })

    expect(mockApi).toHaveBeenNthCalledWith(2, '/api/bots', {
      method: 'POST',
      body: {
        triggerType: 'strategy',
        strategy: 'strat-1',
        exchange: ['ex-paper-1'],
        symbol: 'BTC/USDC:USDC',
        name: 'GridRunner BTC',
        market: 'futures',
        positionSizing: { type: 'percentage', value: 15, leverage: 2, stopLoss: 5, takeProfit: 10 },
      },
    })
    expect(await textOf(result)).toContain('PAPER (simulated) mode on Bybit Futures Paper')
    expect(await textOf(result)).toContain('ID: new-bot-1')
  })
})

describe('update_bot', () => {
  it('merges the requested change on top of the bot\'s CURRENT positionSizing instead of overwriting it', async () => {
    // PATCH /api/bots/:id treats positionSizing as a whole group -- a naive
    // { positionSizing: { leverage: 10 } } would silently drop value/stopLoss/
    // takeProfit that were already set.
    mockApi
      .mockResolvedValueOnce({ doc: { id: 'bot-1', positionSizing: { type: 'percentage', value: 10, leverage: 1, stopLoss: 5 } } })
      .mockResolvedValueOnce({ doc: { id: 'bot-1' } })

    const handler = getToolHandler('update_bot')
    await handler({ id: 'bot-1', leverage: 10 })

    expect(mockApi).toHaveBeenNthCalledWith(2, '/api/bots/bot-1', {
      method: 'PATCH',
      body: { positionSizing: { type: 'percentage', value: 10, leverage: 10, stopLoss: 5 } },
    })
  })

  it('falls back to sane defaults when the bot has no positionSizing yet', async () => {
    mockApi
      .mockResolvedValueOnce({ doc: { id: 'bot-1' } })
      .mockResolvedValueOnce({ doc: { id: 'bot-1' } })

    const handler = getToolHandler('update_bot')
    await handler({ id: 'bot-1', positionSizePercent: 20 })

    expect(mockApi).toHaveBeenNthCalledWith(2, '/api/bots/bot-1', {
      method: 'PATCH',
      body: { positionSizing: { type: 'percentage', value: 20, leverage: 1 } },
    })
  })
})

describe('start_bot / stop_bot', () => {
  it('start_bot PATCHes status:active', async () => {
    mockApi.mockResolvedValue({})
    const handler = getToolHandler('start_bot')
    const result = await handler({ id: 'bot-1' })
    expect(mockApi).toHaveBeenCalledWith('/api/bots/bot-1/status', { method: 'PATCH', body: { status: 'active' } })
    expect(await textOf(result)).toBe('Bot bot-1 activated.')
  })

  it('stop_bot uses PATCH, not PUT -- the route only exports PATCH and a PUT would 404/405', async () => {
    mockApi.mockResolvedValue({})
    const handler = getToolHandler('stop_bot')
    await handler({ id: 'bot-1' })
    expect(mockApi).toHaveBeenCalledWith('/api/bots/bot-1/status', { method: 'PATCH', body: { status: 'stopped' } })
  })
})

describe('export_bot_trades', () => {
  it('scopes trades to this bot only, since /api/trades/history has no botId filter server-side', async () => {
    mockApi
      .mockResolvedValueOnce({ doc: { id: 'bot-1', name: 'GridRunner BTC', exchanges: [{ id: 'ex-1', isPaper: true }], stats: {} } })
      .mockResolvedValueOnce({
        trades: [
          { bot: 'bot-1', symbol: 'BTC/USDT', side: 'long', pnl: 5 },
          { bot: 'some-other-bot', symbol: 'BTC/USDT', side: 'long', pnl: 999 },
        ],
      })

    const handler = getToolHandler('export_bot_trades')
    const result = await handler({ id: 'bot-1', format: 'summary' })

    const body = await jsonOf(result)
    expect(body.tradeCount).toBe(1)
    expect(body.trades).toHaveLength(1)
    expect(body.trades[0].pnl).toBe(5)
  })
})

describe('close_position', () => {
  it('resolves a percentage into the real absolute size from get_positions, matching by exchangeId not exchange name', async () => {
    mockApi
      .mockResolvedValueOnce({
        positions: [
          { exchangeId: 'ex-1', exchange: 'binance', symbol: 'BTC/USDT', side: 'long', size: 0.4 },
        ],
      })
      .mockResolvedValueOnce({ pnl: 12.3 })

    const handler = getToolHandler('close_position')
    await handler({ exchangeId: 'ex-1', symbol: 'BTC/USDT', side: 'long', percentage: 50 })

    expect(mockApi).toHaveBeenNthCalledWith(2, '/api/positions/close', {
      method: 'POST',
      body: { exchangeId: 'ex-1', symbol: 'BTC/USDT', side: 'long', size: 0.2 },
    })
  })

  it('errors clearly instead of closing the wrong thing when no matching position is open', async () => {
    mockApi.mockResolvedValueOnce({ positions: [] })
    const handler = getToolHandler('close_position')
    const result = await handler({ exchangeId: 'ex-1', symbol: 'BTC/USDT', side: 'long', percentage: 100 })
    expect(result.isError).toBe(true)
    const body = JSON.parse(result.content[0].text)
    expect(body.error.code).toBe('POSITION_NOT_FOUND')
  })
})
