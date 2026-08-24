import { describe, it, expect, vi, beforeEach } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerStrategyTools } from '../src/tools/strategy.js'

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
  registerStrategyTools(server)
  const call = toolSpy.mock.calls.find((c) => c[0] === name)
  if (!call) throw new Error(`tool ${name} was not registered`)
  return call[call.length - 1] as (args: any) => Promise<any>
}

async function jsonOf(result: any) {
  return JSON.parse(result.content[0].text)
}

describe('list_strategies', () => {
  it('owned:true reads GET /api/user-strategies\' real { data: [...] } shape', async () => {
    // The route (src/app/api/user-strategies/route.ts) returns
    // `NextResponse.json({ data: formattedStrategies })`. The tool previously
    // read `data.strategies || data.docs`, neither of which exists on this
    // shape, so owned:true always returned an empty list regardless of how
    // many strategies the user actually owned.
    mockApi.mockResolvedValue({ data: [{ id: 's1', name: 'My Strategy', market: 'spot', status: 'live' }] })

    const handler = getToolHandler('list_strategies')
    const result = await handler({ owned: true, limit: 50 })

    expect(await jsonOf(result)).toEqual([
      expect.objectContaining({ id: 's1', name: 'My Strategy', status: 'live' }),
    ])
  })

  it('owned:false reads the marketplace endpoint\'s real { docs: [...] } shape', async () => {
    mockApi.mockResolvedValue({ docs: [{ id: 'm1', name: 'GhostRider', market: 'both' }] })

    const handler = getToolHandler('list_strategies')
    const result = await handler({ owned: false, limit: 50 })

    expect(await jsonOf(result)).toEqual([expect.objectContaining({ id: 'm1', name: 'GhostRider' })])
  })

  it('forwards market/category/search/sort/limit to the marketplace endpoint with marketplace=true', async () => {
    mockApi.mockResolvedValue({ docs: [] })
    const handler = getToolHandler('list_strategies')
    await handler({ owned: false, market: 'futures', category: 'official', search: 'grid', sort: 'rating', pricing: 'free', limit: 10 })

    const url = mockApi.mock.calls[0][0] as string
    expect(url).toMatch(/^\/api\/tradedroid\/strategies\?/)
    const params = new URLSearchParams(url.split('?')[1])
    expect(params.get('marketplace')).toBe('true')
    expect(params.get('market')).toBe('futures')
    expect(params.get('category')).toBe('official')
    expect(params.get('search')).toBe('grid')
    expect(params.get('sort')).toBe('rating')
    expect(params.get('pricing')).toBe('free')
    expect(params.get('limit')).toBe('10')
  })

  it('forwards status to /api/user-strategies for owned:true, and never sends pricing/marketplace there', async () => {
    mockApi.mockResolvedValue({ data: [] })
    const handler = getToolHandler('list_strategies')
    await handler({ owned: true, status: 'live,listed', sort: 'newest', limit: 25 })

    const url = mockApi.mock.calls[0][0] as string
    expect(url).toMatch(/^\/api\/user-strategies\?/)
    const params = new URLSearchParams(url.split('?')[1])
    expect(params.get('status')).toBe('live,listed')
    expect(params.get('sort')).toBe('newest')
    expect(params.has('marketplace')).toBe(false)
    expect(params.has('pricing')).toBe(false)
  })
})
