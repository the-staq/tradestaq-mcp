import { describe, it, expect, vi, beforeEach } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerShareTools } from '../src/tools/share.js'

const { mockApi } = vi.hoisted(() => ({ mockApi: vi.fn() }))
vi.mock('../src/api.js', async (orig) => ({ ...(await orig<typeof import('../src/api.js')>()), api: mockApi }))

beforeEach(() => {
  vi.clearAllMocks()
})

function handler(name: string) {
  const server = new McpServer({ name: 'test-server', version: '0.0.1' }, { capabilities: { logging: {} } })
  const spy = vi.spyOn(server, 'tool')
  registerShareTools(server)
  const call = spy.mock.calls.find((c) => c[0] === name)
  if (!call) throw new Error(`tool ${name} was not registered`)
  return call[call.length - 1] as (args: any) => Promise<any>
}
const textOf = (r: any) => r.content[0].text as string
const jsonOf = (r: any) => JSON.parse(textOf(r))

const BOT = 'c'.repeat(24)
const URL_1 = `https://www.tradestaq.com/chart/${'f'.repeat(64)}`

describe('list_bot_share_links', () => {
  it('lists the active links with what each shows, when it expires and whether it already has', async () => {
    mockApi.mockResolvedValueOnce({ shares: [
      { id: 's1', token: 'f'.repeat(64), url: URL_1, expiresAt: null, accessCount: 12, createdAt: '2026-11-12T10:00:00.000Z',
        permissions: { showPositions: true, showTrades: true, showPnL: true, showBalance: false } },
      { id: 's2', url: 'https://www.tradestaq.com/chart/old', expiresAt: '2026-01-01T00:00:00.000Z', accessCount: 0,
        permissions: { showPositions: true, showTrades: false, showPnL: false, showBalance: false } },
    ] })

    const links = jsonOf(await handler('list_bot_share_links')({ botId: BOT }))

    expect(mockApi).toHaveBeenCalledWith(`/api/bots/${BOT}/share`)
    expect(links[0]).toEqual({ id: 's1', url: URL_1, expiresAt: 'never', expired: false, shows: { positions: true, trades: true, pnl: true, balance: false }, views: 12, createdAt: '2026-11-12T10:00:00.000Z' })
    expect(links[1]).toMatchObject({ id: 's2', expired: true })
    expect(links[0]).not.toHaveProperty('token')
  })

  it('says how to make one when the bot has none', async () => {
    mockApi.mockResolvedValueOnce({ shares: [] })
    expect(textOf(await handler('list_bot_share_links')({ botId: BOT }))).toContain('create_bot_share_link')
  })
})

describe('create_bot_share_link', () => {
  it('posts the expiry and the four switches once (no resend that could leave a second public link)', async () => {
    mockApi.mockResolvedValueOnce({ success: true, share: { id: 's9', url: URL_1, expiresAt: undefined, createdAt: '2026-11-12T10:00:00.000Z',
      permissions: { showPositions: true, showTrades: true, showPnL: true, showBalance: false } } })

    const link = jsonOf(await handler('create_bot_share_link')({ botId: BOT, expiresIn: 'never', showPositions: true, showTrades: true, showPnL: true, showBalance: false }))

    expect(mockApi).toHaveBeenCalledWith(`/api/bots/${BOT}/share`, {
      method: 'POST', retry: false,
      body: { expiresIn: 'never', permissions: { showPositions: true, showTrades: true, showPnL: true, showBalance: false } },
    })
    expect(link).toMatchObject({ id: 's9', url: URL_1, expiresAt: 'never', expired: false, shows: { pnl: true, balance: false } })
  })

  it('passes the server\'s scope refusal through (a live bot needs mcp:live)', async () => {
    const { ApiError } = await import('../src/api.js')
    mockApi.mockRejectedValueOnce(new ApiError(403, 'insufficient_scope', 'Insufficient OAuth scope. This endpoint requires "mcp:live".', false))
    const res = await handler('create_bot_share_link')({ botId: BOT, expiresIn: '7d', showPositions: true, showTrades: true, showPnL: false, showBalance: false })
    expect(res.isError).toBe(true)
    expect(textOf(res)).toContain('mcp:live')
  })
})

describe('revoke_bot_share_link', () => {
  it('deletes by bot and link id', async () => {
    mockApi.mockResolvedValueOnce({ success: true })
    const res = await handler('revoke_bot_share_link')({ botId: BOT, shareId: 's1' })
    expect(mockApi).toHaveBeenCalledWith(`/api/bots/${BOT}/share?shareId=s1`, { method: 'DELETE' })
    expect(textOf(res)).toContain('revoked')
  })
})

describe('tool shapes', () => {
  it('marks list read-only, create non-idempotent and revoke destructive', () => {
    const server = new McpServer({ name: 't', version: '0' }, { capabilities: {} })
    const spy = vi.spyOn(server, 'tool')
    registerShareTools(server)
    const annotations = Object.fromEntries(spy.mock.calls.map((c) => [c[0], c[3]]))
    expect(annotations.list_bot_share_links).toMatchObject({ readOnlyHint: true })
    expect(annotations.create_bot_share_link).toMatchObject({ readOnlyHint: false, idempotentHint: false })
    expect(annotations.revoke_bot_share_link).toMatchObject({ destructiveHint: true })
  })
})
