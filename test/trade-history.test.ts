import { describe, it, expect, vi, beforeEach } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerTradeTools } from '../src/tools/trades.js'
import { closedTrades } from '../src/closed-trades.js'

const { mockApi } = vi.hoisted(() => ({ mockApi: vi.fn() }))
vi.mock('../src/api.js', async (orig) => ({ ...(await orig<typeof import('../src/api.js')>()), api: mockApi }))

beforeEach(() => {
  vi.clearAllMocks()
})

function getToolHandler(name: string) {
  const server = new McpServer({ name: 'test-server', version: '0.0.1' }, { capabilities: { logging: {} } })
  const toolSpy = vi.spyOn(server, 'tool')
  registerTradeTools(server)
  const call = toolSpy.mock.calls.find((c) => c[0] === name)
  if (!call) throw new Error(`tool ${name} was not registered`)
  return call[call.length - 1] as (args: any) => Promise<any>
}
const textOf = (r: any) => r.content[0].text as string
const jsonOf = (r: any) => JSON.parse(textOf(r))

const BITGET = '69576196575b2082dd0c411b'
const BOT = '6ab7d1991a2d75b7f67570d7'

// The records GET /api/trades/history returned live for HYPE on Bitget (2026-11-12), trimmed
// to the fields that matter: each close is an exit record (flat) plus the entry lot it closed,
// both carrying the same pnl.
const HYPE_PAGE = [
  { _id: '6af17230842242d804a6d8ff', symbol: 'HYPE/USDT:USDT', side: 'buy', positionSide: 'flat', status: 'closed', entryPrice: 77.296, price: 73.4, exitPrice: 73.4, size: 0.32, pnl: 1.22260864, isPaper: false, exchange: BITGET, bot: BOT, closedAt: '2026-11-09T07:11:44.791Z', createdAt: '2026-11-08T05:51:31.209Z' },
  { _id: '6af00ddc1de86ff8651b40a1', symbol: 'HYPE/USDT:USDT', side: 'sell', positionSide: 'short', status: 'closed', entryPrice: 77.296, price: 77.296, exitPrice: 73.4, size: 0.32, pnl: 1.22260864, realizedPnl: 1.22260864, isPaper: false, exchange: BITGET, bot: BOT, closedAt: '2026-11-09T07:11:44.700Z', createdAt: '2026-11-08T05:51:24.728Z' },
  { _id: '6af00dda1de86ff8651b3ff6', symbol: 'HYPE/USDT:USDT', side: 'sell', positionSide: 'flat', status: 'closed', entryPrice: 81.401, price: 77.296, exitPrice: 77.296, size: 0.3, pnl: -1.25530455, isPaper: false, exchange: BITGET, bot: BOT, closedAt: '2026-11-08T05:51:22.426Z', createdAt: '2026-10-27T20:00:30.478Z' },
  { _id: '6ae102d8834085fb9c4107e6', symbol: 'HYPE/USDT:USDT', side: 'buy', positionSide: 'long', status: 'closed', entryPrice: 81.401, price: 81.401, exitPrice: 77.296, size: 0.3, pnl: -1.25530455, realizedPnl: -1.25530455, isPaper: false, exchange: BITGET, bot: BOT, closedAt: '2026-11-08T05:51:22.324Z', createdAt: '2026-10-27T20:00:24.155Z' },
]

describe('get_trade_history', () => {
  it('lists each close once (the exit record), not twice with the entry lot it closed -- regression: every HYPE trade on Bitget came back as a "buy" and a "sell" row with the same pnl', async () => {
    mockApi.mockResolvedValueOnce({ trades: HYPE_PAGE, pagination: { total: 163, page: 1, limit: 4, hasMore: true } })

    const body = jsonOf(await getToolHandler('get_trade_history')({ limit: 4, page: 1 }))

    expect(body.hasMore).toBe(true)
    expect(body.trades).toHaveLength(2)
    expect(body.trades.map((t: any) => t.pnl)).toEqual([1.22260864, -1.25530455])
  })

  it('gives each trade its direction (a buy exit closes a short, a sell exit closes a long), its open time from the lot, and its return on position size', async () => {
    mockApi.mockResolvedValueOnce({ trades: HYPE_PAGE, pagination: { hasMore: false } })

    const [shortTrade, longTrade] = jsonOf(await getToolHandler('get_trade_history')({ limit: 4, page: 1 })).trades

    expect(shortTrade).toMatchObject({
      id: '6af17230842242d804a6d8ff', direction: 'short', entryPrice: 77.296, exitPrice: 73.4, size: 0.32,
      exchangeId: BITGET, botId: BOT, isPaper: false,
      openedAt: '2026-11-08T05:51:24.728Z', closedAt: '2026-11-09T07:11:44.791Z', holdingMinutes: 1520,
    })
    expect(shortTrade.returnOnPositionPct).toBe(4.94) // 1.2226 / (77.296 x 0.32)
    expect(longTrade).toMatchObject({ direction: 'long', entryPrice: 81.401, exitPrice: 77.296, openedAt: '2026-10-27T20:00:24.155Z' })
    expect(longTrade.returnOnPositionPct).toBe(-5.14)
    expect(shortTrade).not.toHaveProperty('side')
    expect(shortTrade).not.toHaveProperty('pnlPercent')
  })

  it('sends an exchange account ID as exchangeId, the only exchange filter the route reads -- regression: it sent `exchange`, which the route ignored, so the filter never narrowed anything', async () => {
    mockApi.mockResolvedValueOnce({ trades: [], pagination: { hasMore: false } })
    await getToolHandler('get_trade_history')({ exchangeId: BITGET, limit: 50, page: 1 })
    expect(mockApi).toHaveBeenCalledWith(`/api/trades/history?exchangeId=${BITGET}&limit=50&page=1`)

    mockApi.mockResolvedValueOnce({ trades: [], pagination: { hasMore: false } })
    await getToolHandler('get_trade_history')({ exchange: BITGET, limit: 50, page: 1 })
    expect(mockApi).toHaveBeenLastCalledWith(`/api/trades/history?exchangeId=${BITGET}&limit=50&page=1`)
  })

  it('resolves a platform name to its one account through /api/exchanges', async () => {
    mockApi
      .mockResolvedValueOnce({ docs: [
        { id: BITGET, name: 'Bitget Elite Trader', platform: 'bitget' },
        { id: '69575c63575b2082dd0c40ea', name: 'Bybit Copy Trading', platform: 'bybit' },
      ] })
      .mockResolvedValueOnce({ trades: [], pagination: { hasMore: false } })

    await getToolHandler('get_trade_history')({ exchange: 'Bitget', symbol: 'HYPE', limit: 20, page: 1 })

    expect(mockApi).toHaveBeenNthCalledWith(1, '/api/exchanges')
    expect(mockApi).toHaveBeenNthCalledWith(2, `/api/trades/history?exchangeId=${BITGET}&symbol=HYPE&limit=20&page=1`)
  })

  it('refuses a name that matches more than one account instead of guessing, and one that matches none', async () => {
    const accounts = { docs: [{ id: 'a'.repeat(24), name: 'Bybit Main', platform: 'bybit' }, { id: 'b'.repeat(24), name: 'Bybit Paper', platform: 'bybit' }] }
    mockApi.mockResolvedValueOnce(accounts)
    const ambiguous = await getToolHandler('get_trade_history')({ exchange: 'bybit', limit: 50, page: 1 })
    expect(ambiguous.isError).toBe(true)
    expect(textOf(ambiguous)).toContain('EXCHANGE_AMBIGUOUS')
    expect(textOf(ambiguous)).toContain('a'.repeat(24))

    mockApi.mockResolvedValueOnce(accounts)
    const missing = await getToolHandler('get_trade_history')({ exchange: 'kraken', limit: 50, page: 1 })
    expect(textOf(missing)).toContain('EXCHANGE_NOT_FOUND')
    expect(mockApi).not.toHaveBeenCalledWith(expect.stringContaining('/api/trades/history'))
  })

  it('says to try the next page when a page held only entry lots, instead of "No closed trades found"', async () => {
    mockApi.mockResolvedValueOnce({ trades: [HYPE_PAGE[1]], pagination: { hasMore: true } })
    expect(textOf(await getToolHandler('get_trade_history')({ limit: 1, page: 3 }))).toBe('No closed trades on page 3, but more records exist: try page 4.')

    mockApi.mockResolvedValueOnce({ trades: [], pagination: { hasMore: false } })
    expect(textOf(await getToolHandler('get_trade_history')({ limit: 50, page: 1 }))).toBe('No closed trades found.')
  })
})

describe('closedTrades', () => {
  const exit = (o: Record<string, unknown> = {}) => ({ _id: 'x1', symbol: 'ADA/USDT', side: 'sell', positionSide: 'flat', status: 'closed', entryPrice: 0.5, exitPrice: 0.55, size: 100, pnl: 4.8, bot: 'b1', exchange: 'e1', closedAt: '2026-11-10T12:00:00.100Z', ...o })
  const lot = (o: Record<string, unknown> = {}) => ({ _id: 'l1', symbol: 'ADA/USDT', side: 'buy', positionSide: 'long', status: 'closed', size: 50, pnl: 2.4, bot: 'b1', exchange: 'e1', closedAt: '2026-11-10T12:00:00.000Z', createdAt: '2026-11-09T12:00:00.000Z', ...o })

  it('one close of several DCA lots is one trade, opened when its first lot opened', () => {
    const trades = closedTrades([exit(), lot({ _id: 'l2', createdAt: '2026-11-08T12:00:00.000Z' }), lot()])
    expect(trades).toHaveLength(1)
    expect(trades[0]).toMatchObject({ direction: 'long', pnl: 4.8, openedAt: '2026-11-08T12:00:00.000Z', holdingMinutes: 2880 })
  })

  it('reads a spot close the same way (a sell exit closes a buy)', () => {
    expect(closedTrades([exit(), lot({ positionSide: 'buy' })])[0].direction).toBe('long')
  })

  it('does not borrow an open time from another bot\'s or another coin\'s lot closed at the same moment', () => {
    const trades = closedTrades([exit(), lot({ bot: 'b2' }), lot({ symbol: 'SUI/USDT' })])
    expect(trades[0].openedAt).toBeUndefined()
    expect(trades[0].holdingMinutes).toBeUndefined()
  })

  it('leaves out canceled exits, and the return % when size is in contracts', () => {
    expect(closedTrades([exit({ status: 'canceled' })])).toEqual([])
    expect(closedTrades([exit({ contractSize: 10 })])[0].returnOnPositionPct).toBeUndefined()
    expect(closedTrades([exit({ contractSize: 1 })])[0].returnOnPositionPct).toBe(9.6)
  })

  it('lists a lot the reconcile closed with no exit record as its own trade, so its loss is not hidden -- seen live: ZEC longs on Bitget closed "exchange_already_flat" on 2026-10-15 with no exit records', () => {
    const zec = lot({ _id: 'z1', symbol: 'ZEC/USDT', entryPrice: 300, exitPrice: 280, size: 0.5, pnl: -10, closeReason: 'exchange_already_flat', closedAt: '2026-10-15T05:54:00.000Z', createdAt: '2026-10-14T20:00:00.000Z' })
    const trades = closedTrades([exit(), lot(), zec])
    expect(trades).toHaveLength(2)
    expect(trades[1]).toMatchObject({ id: 'z1', direction: 'long', entryPrice: 300, exitPrice: 280, pnl: -10, returnOnPositionPct: -6.67, closeReason: 'exchange_already_flat', noExitRecord: true, openedAt: '2026-10-14T20:00:00.000Z', holdingMinutes: 594 })
    expect(trades[0].noExitRecord).toBeUndefined()
  })

  it('does not list a reconcile-closed lot that has an exit record (no double count), nor an old unmatched lot whose exit was written without closedAt', () => {
    expect(closedTrades([exit(), lot({ closeReason: 'strategy_spin_sync' })])).toHaveLength(1)
    expect(closedTrades([lot({ closeReason: 'signal_direct', closedAt: '2026-02-10T00:00:00.000Z' })])).toEqual([])
  })

  it('keeps a record with no positionSide as a trade rather than hiding it (the schema requires the field; this is only a guard)', () => {
    const trades = closedTrades([{ _id: 'old', symbol: 'BTC/USDT', side: 'sell', status: 'closed', pnl: 1 }])
    expect(trades).toHaveLength(1)
    expect(trades[0].direction).toBeUndefined()
  })
})
