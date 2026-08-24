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
