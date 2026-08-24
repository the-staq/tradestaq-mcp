import { describe, it, expect, vi, beforeEach } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerStrategyTools } from '../src/tools/strategy.js'
import { ApiError } from '../src/api.js'

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

describe('get_strategy', () => {
  it('reads the owner-authoritative endpoint first, including code and resolved parameterGroups', async () => {
    mockApi.mockResolvedValue({
      data: {
        id: 's1', name: 'My Strategy', market: 'spot', category: 'custom', status: 'draft',
        code: 'td.strategy.enterLong()',
        dcaConfig: { enabled: false },
        primaryTimeframe: '1h',
        parameterGroups: [{ groupName: 'Entry', parameters: [{ name: 'rsiPeriod', label: 'RSI Period', inputType: 'number', defaultValue: 14 }] }],
      },
    })

    const handler = getToolHandler('get_strategy')
    const result = await handler({ id: 's1' })

    expect(mockApi).toHaveBeenCalledWith('/api/user-strategies/s1')
    const body = await jsonOf(result)
    expect(body.code).toBe('td.strategy.enterLong()')
    expect(body.timeframe).toBe('1h')
    expect(body.parameterGroups).toEqual([
      { group: 'Entry', parameters: [expect.objectContaining({ name: 'rsiPeriod', type: 'number', default: 14 })] },
    ])
  })

  it('falls back to the marketplace endpoint on a 403 (not the owner), and code comes back omitted', async () => {
    mockApi
      .mockRejectedValueOnce(new ApiError(403, 'HTTP_403', 'Forbidden', false))
      .mockResolvedValueOnce({
        doc: {
          id: 'm1', name: 'GhostRider', market: 'both', dcaConfig: { enabled: true },
          // Marketplace route strips code entirely for a non-author (route.ts: code: undefined).
          latestVersion: { semanticVersion: '1.2.0', requiredIndicators: ['rsi'], parameterGroups: [] },
        },
      })

    const handler = getToolHandler('get_strategy')
    const result = await handler({ id: 'm1' })

    expect(mockApi).toHaveBeenNthCalledWith(1, '/api/user-strategies/m1')
    expect(mockApi).toHaveBeenNthCalledWith(2, '/api/tradedroid/strategies/m1')
    const body = await jsonOf(result)
    expect(body.code).toBeUndefined()
    expect(body.version).toBe('1.2.0')
  })

  it('falls back on a 404 the same way as a 403', async () => {
    mockApi
      .mockRejectedValueOnce(new ApiError(404, 'HTTP_404', 'Not Found', false))
      .mockResolvedValueOnce({ doc: { id: 'm1', name: 'GhostRider' } })

    const handler = getToolHandler('get_strategy')
    await handler({ id: 'm1' })

    expect(mockApi).toHaveBeenCalledTimes(2)
  })

  it('does not fall back on an unrelated error (e.g. 500) -- propagates it instead', async () => {
    mockApi.mockRejectedValueOnce(new ApiError(500, 'HTTP_500', 'Internal error', true))

    const handler = getToolHandler('get_strategy')
    const result = await handler({ id: 's1' })

    expect(mockApi).toHaveBeenCalledTimes(1)
    expect(result.isError).toBe(true)
  })
})

describe('update_strategy', () => {
  it('PATCHes only the fields provided, and reads the real { data: ... } response shape', async () => {
    mockApi.mockResolvedValue({ data: { id: 's1', name: 'New Name', status: 'draft', latestVersion: 'v2', stableVersion: 'v1' } })

    const handler = getToolHandler('update_strategy')
    const result = await handler({ id: 's1', name: 'New Name' })

    expect(mockApi).toHaveBeenCalledWith('/api/user-strategies/s1', { method: 'PATCH', body: { name: 'New Name' } })
    expect(await jsonOf(result)).toEqual({
      id: 's1', name: 'New Name', status: 'draft', latestVersion: 'v2', stableVersion: 'v1',
      message: 'Strategy updated.',
    })
  })

  it('sends code changes and notes they land on a draft, not the live version', async () => {
    mockApi.mockResolvedValue({ data: { id: 's1', name: 'My Strategy', status: 'live', latestVersion: 'v3', stableVersion: 'v1' } })

    const handler = getToolHandler('update_strategy')
    const result = await handler({ id: 's1', code: 'td.strategy.enterLong()' })

    expect(mockApi).toHaveBeenCalledWith('/api/user-strategies/s1', { method: 'PATCH', body: { code: 'td.strategy.enterLong()' } })
    const body = await jsonOf(result)
    expect(body.message).toContain('draft version');
  })

  it('forwards a status transition request', async () => {
    mockApi.mockResolvedValue({ data: { id: 's1', status: 'testing' } })

    const handler = getToolHandler('update_strategy')
    await handler({ id: 's1', status: 'testing' })

    expect(mockApi).toHaveBeenCalledWith('/api/user-strategies/s1', { method: 'PATCH', body: { status: 'testing' } })
  })

  it('surfaces an invalid status transition as a real ApiError instead of a generic failure', async () => {
    mockApi.mockRejectedValue(new ApiError(400, 'HTTP_400', "Cannot change status from 'draft' to 'listed'", false))

    const handler = getToolHandler('update_strategy')
    const result = await handler({ id: 's1', status: 'listed' })

    expect(result.isError).toBe(true)
    const body = JSON.parse(result.content[0].text)
    expect(body.error.message).toContain("Cannot change status from 'draft' to 'listed'")
  })
})
