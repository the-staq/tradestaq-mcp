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
