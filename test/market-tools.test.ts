import { describe, it, expect, vi, beforeEach } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerMarketTools } from '../src/tools/market.js'

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
  registerMarketTools(server)
  const call = toolSpy.mock.calls.find((c) => c[0] === name)
  if (!call) throw new Error(`tool ${name} was not registered`)
  return call[call.length - 1] as (args: any) => Promise<any>
}

async function textOf(result: any) {
  return result.content[0].text
}

describe('search_markets', () => {
  it('finds a match from the real { symbols: string[] } shape returned by GET /api/exchanges/:id/markets', async () => {
    // This is the actual production response shape (src/app/api/exchanges/[id]/markets/route.ts,
    // list mode) — plain unified-symbol strings, not { markets: [...] } objects.
    // The tool previously read `data.markets`, which is always undefined against
    // this shape, so every search silently returned nothing regardless of query
    // or exchange.
    mockApi.mockResolvedValue({ symbols: ['BTC/USDT', 'ETH/USDT', 'HYPE/USDC:USDC'], timeframes: ['1h'] })

    const handler = getToolHandler('search_markets')
    const result = await handler({ query: 'HYPE', exchange: 'ex1' })

    const parsed = JSON.parse(await textOf(result))
    expect(parsed).toEqual([{ symbol: 'HYPE/USDC:USDC', base: 'HYPE', quote: 'USDC', type: 'swap' }])
  })

  it('classifies a plain BASE/QUOTE symbol (no settle suffix) as spot', async () => {
    mockApi.mockResolvedValue({ symbols: ['BTC/USDT'], timeframes: [] })

    const handler = getToolHandler('search_markets')
    const result = await handler({ query: 'BTC', exchange: 'ex1' })

    const parsed = JSON.parse(await textOf(result))
    expect(parsed).toEqual([{ symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', type: 'spot' }])
  })

  it('is case-insensitive and caps results at 20', async () => {
    mockApi.mockResolvedValue({ symbols: Array.from({ length: 30 }, (_, i) => `COIN${i}/USDT`) })

    const handler = getToolHandler('search_markets')
    const result = await handler({ query: 'coin', exchange: 'ex1' })

    const parsed = JSON.parse(await textOf(result))
    expect(parsed).toHaveLength(20)
  })

  it('reports no matches instead of throwing when nothing matches', async () => {
    mockApi.mockResolvedValue({ symbols: ['BTC/USDT'] })

    const handler = getToolHandler('search_markets')
    const result = await handler({ query: 'ZZZ', exchange: 'ex1' })

    expect(await textOf(result)).toBe('No markets found matching "ZZZ".')
  })
})

describe('create_paper_exchange', () => {
  it('generates the required exchangeSlug field -- the Exchanges collection rejects creation without one', async () => {
    // exchangeSlug is `required: true` on the collection (src/collections/Exchanges.ts)
    // and is only ever generated client-side by the web wizard, never by the
    // server. Every create_paper_exchange call failed with "The following
    // field is invalid: Exchange Identifier (Slug)" until this was added.
    mockApi.mockResolvedValue({ doc: { id: 'ex-new-1', name: 'bybit', exchangeType: 'futures', accountLabel: 'Bybit Paper' } })

    const handler = getToolHandler('create_paper_exchange')
    await handler({ platform: 'bybit', exchangeType: 'futures', initialBalanceUsdt: 10000 })

    const [, options] = mockApi.mock.calls[0]
    expect(options.body.exchangeSlug).toMatch(/^bybit-paper-[a-f0-9]{6}$/)
  })

  it('generates a distinct slug per call so two paper accounts on the same platform never collide', async () => {
    mockApi.mockResolvedValue({ doc: { id: 'ex-1' } })
    const handler = getToolHandler('create_paper_exchange')

    await handler({ platform: 'binance', exchangeType: 'spot', initialBalanceUsdt: 10000 })
    await handler({ platform: 'binance', exchangeType: 'spot', initialBalanceUsdt: 10000 })

    const slug1 = mockApi.mock.calls[0][1].body.exchangeSlug
    const slug2 = mockApi.mock.calls[1][1].body.exchangeSlug
    expect(slug1).not.toBe(slug2)
  })
})

describe('get_price', () => {
  const PRICE_RESPONSE = { symbol: 'BTC/USDT', price: 100, change24h: 1.5, volume24h: 1000 }

  async function priceUrl(args: { symbol: string, exchange?: string }) {
    mockApi.mockResolvedValue(PRICE_RESPONSE)
    await getToolHandler('get_price')(args)
    expect(mockApi).toHaveBeenCalledTimes(1)
    return new URL(mockApi.mock.calls[0][0] as string, 'http://x')
  }

  it('sends an account ID from list_exchanges as exchangeId (the route resolves accounts only through it)', async () => {
    const url = await priceUrl({ symbol: 'BTC/USDT', exchange: '6512ab34cd56ef7890abcdef' })

    expect(url.pathname).toBe('/api/trading/price')
    expect(url.searchParams.get('exchangeId')).toBe('6512ab34cd56ef7890abcdef')
    expect(url.searchParams.has('exchange')).toBe(false)
  })

  it('treats an upper-case ObjectId as an account ID too', async () => {
    const url = await priceUrl({ symbol: 'BTC/USDT', exchange: '6512AB34CD56EF7890ABCDEF' })

    expect(url.searchParams.get('exchangeId')).toBe('6512AB34CD56EF7890ABCDEF')
    expect(url.searchParams.has('exchange')).toBe(false)
  })

  it('sends a platform name as a lowercased exchange slug', async () => {
    const url = await priceUrl({ symbol: 'BTC/USDT', exchange: 'Bybit' })

    expect(url.searchParams.get('exchange')).toBe('bybit')
    expect(url.searchParams.has('exchangeId')).toBe(false)
  })

  it('does not mistake a non-ObjectId string (wrong length or non-hex) for an account ID', async () => {
    const short = await priceUrl({ symbol: 'BTC/USDT', exchange: 'abcdef1234' })
    expect(short.searchParams.get('exchange')).toBe('abcdef1234')
    expect(short.searchParams.has('exchangeId')).toBe(false)

    vi.clearAllMocks()
    const nonHex = await priceUrl({ symbol: 'BTC/USDT', exchange: 'kucoinfutures-zzzzzzzzzz' })
    expect(nonHex.searchParams.get('exchange')).toBe('kucoinfutures-zzzzzzzzzz')
    expect(nonHex.searchParams.has('exchangeId')).toBe(false)
  })

  it('sends neither param when no exchange is given, leaving the default to the route', async () => {
    const url = await priceUrl({ symbol: 'BTC/USDT' })

    expect(url.searchParams.get('symbol')).toBe('BTC/USDT')
    expect(url.searchParams.has('exchange')).toBe(false)
    expect(url.searchParams.has('exchangeId')).toBe(false)
  })

  it('returns symbol, price, change24h and volume24h', async () => {
    mockApi.mockResolvedValue({ ...PRICE_RESPONSE, extra: 'dropped' })

    const result = await getToolHandler('get_price')({ symbol: 'BTC/USDT', exchange: 'binance' })

    expect(JSON.parse(await textOf(result))).toEqual(PRICE_RESPONSE)
  })
})

describe('get_candles', () => {
  // Production response shape of GET /api/charts/candles (src/app/api/charts/candles/route.ts).
  const CANDLES_RESPONSE = {
    success: true,
    data: {
      symbol: 'BTC/USDT', timeframe: '1h',
      candles: [
        { timestamp: 1000, time: 1, open: 10, high: 12, low: 9, close: 11, volume: 5 },
        { timestamp: 2000, time: 2, open: 11, high: 15, low: 8, close: 14, volume: 7 },
      ],
      usingFallback: false,
    },
  }

  it('sends exchangeId (the route ignores `exchange`) and parses the { success, data: { candles } } shape', async () => {
    mockApi.mockResolvedValue(CANDLES_RESPONSE)

    const result = await getToolHandler('get_candles')({ symbol: 'BTC/USDT', timeframe: '1h', limit: 2, exchange: 'ex-1' })

    expect(mockApi).toHaveBeenCalledTimes(1)
    const url = mockApi.mock.calls[0][0] as string
    expect(url).toContain('exchangeId=ex-1')
    expect(url).not.toMatch(/[?&]exchange=/)
    const parsed = JSON.parse(await textOf(result))
    expect(parsed).toEqual({
      symbol: 'BTC/USDT', timeframe: '1h', exchangeId: 'ex-1', count: 2,
      latest: { timestamp: 2000, open: 11, high: 15, low: 8, close: 14, volume: 7 },
      range: { high: 15, low: 8 },
    })
  })

  it('uses the first active exchange from /api/exchanges when none is given', async () => {
    mockApi
      .mockResolvedValueOnce({ docs: [{ id: 'ex-off', status: 'inactive' }, { id: 'ex-on', status: 'active' }] })
      .mockResolvedValueOnce(CANDLES_RESPONSE)

    await getToolHandler('get_candles')({ symbol: 'BTC/USDT', timeframe: '1h', limit: 2 })

    expect(mockApi.mock.calls[0][0]).toBe('/api/exchanges')
    expect(mockApi.mock.calls[1][0]).toContain('exchangeId=ex-on')
  })

  it('falls back to binance only when the user has no active exchange', async () => {
    mockApi
      .mockResolvedValueOnce({ docs: [] })
      .mockResolvedValueOnce(CANDLES_RESPONSE)

    await getToolHandler('get_candles')({ symbol: 'BTC/USDT', timeframe: '1h', limit: 2 })

    expect(mockApi.mock.calls[1][0]).toContain('exchangeId=binance')
  })

  it('surfaces usingFallback / fallbackExchange when the server used the public feed', async () => {
    mockApi.mockResolvedValue({ success: true, data: { ...CANDLES_RESPONSE.data, usingFallback: true, fallbackExchange: 'Binance (public)' } })

    const result = await getToolHandler('get_candles')({ symbol: 'BTC/USDT', timeframe: '1h', limit: 2, exchange: 'ex-1' })

    const parsed = JSON.parse(await textOf(result))
    expect(parsed.usingFallback).toBe(true)
    expect(parsed.fallbackExchange).toBe('Binance (public)')
  })

  it('falls back to binance when /api/exchanges fails, and still returns candles', async () => {
    mockApi
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(CANDLES_RESPONSE)

    const result = await getToolHandler('get_candles')({ symbol: 'BTC/USDT', timeframe: '1h', limit: 2 })

    expect(mockApi.mock.calls[1][0]).toContain('exchangeId=binance')
    expect(JSON.parse(await textOf(result)).count).toBe(2)
  })

  it('caps fallbackExchange and ignores a non-boolean usingFallback', async () => {
    mockApi.mockResolvedValueOnce({ success: true, data: { ...CANDLES_RESPONSE.data, usingFallback: true, fallbackExchange: 'B'.repeat(500) } })
    const capped = JSON.parse(await textOf(await getToolHandler('get_candles')({ symbol: 'BTC/USDT', timeframe: '1h', limit: 2, exchange: 'ex-1' })))
    expect(capped.fallbackExchange).toHaveLength(40)

    mockApi.mockResolvedValueOnce({ success: true, data: { ...CANDLES_RESPONSE.data, usingFallback: 'yes' } })
    const ignored = JSON.parse(await textOf(await getToolHandler('get_candles')({ symbol: 'BTC/USDT', timeframe: '1h', limit: 2, exchange: 'ex-1' })))
    expect(ignored).not.toHaveProperty('usingFallback')
  })

  it('returns count 0 and a null range for an empty window', async () => {
    mockApi.mockResolvedValue({ success: true, data: { candles: [] } })

    const result = await getToolHandler('get_candles')({ symbol: 'BTC/USDT', timeframe: '1h', limit: 2, exchange: 'ex-1' })

    const parsed = JSON.parse(await textOf(result))
    expect(parsed.count).toBe(0)
    expect(parsed.range).toBeNull()
  })
})
