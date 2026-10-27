import { describe, it, expect, vi, beforeEach } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

// check_auth, authenticate and the resources decided "authenticated?" from the stored
// access token's expiry alone, while api() refreshes it first. After an idle night the
// one-hour token had expired: check_auth answered "Not authenticated" (and authenticate
// started a fresh browser flow) although the refresh token was good and every other tool
// worked. Hosted, the resources read the file token, so they never saw the request's bearer.

// Stateful config mock: saveConfig updates what loadConfig returns, and isAuthenticated
// mirrors the real one (token present and not past tokenExpiresAt).
const { state, mockFetch } = vi.hoisted(() => ({ state: { current: {} as any }, mockFetch: vi.fn() }))
vi.mock('../src/config.js', () => ({
  loadConfig: () => state.current,
  saveConfig: (c: any) => {
    state.current = c
  },
  clearToken: () => {
    state.current = { ...state.current, token: undefined, tokenExpiresAt: undefined }
  },
  isAuthenticated: () => {
    const c = state.current
    if (!c.token || typeof c.token !== 'string' || c.token.length < 10) return false
    if (c.tokenExpiresAt && Date.now() > c.tokenExpiresAt) return false
    return true
  },
}))
vi.stubGlobal('fetch', mockFetch)

import { hasUsableToken } from '../src/api.js'
import { requestContext } from '../src/request-context.js'
import { registerAuthTools } from '../src/tools/auth.js'
import { registerResources } from '../src/resources/index.js'

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) })
const refreshed = () => json({ access_token: 'fresh-access-token', refresh_token: 'tsr_rotated', expires_in: 3600 })
const me = () => json({ name: 'Owner', email: 'owner@example.com', token: { clientName: 'Test', scope: 'mcp:read', expiresAt: new Date(Date.now() + 3600e3).toISOString() } })

beforeEach(() => {
  vi.clearAllMocks()
  // An idle night: the access token expired hours ago, the 30-day refresh token is good.
  state.current = {
    baseUrl: 'https://www.tradestaq.com',
    token: 'expired-access-token',
    tokenExpiresAt: Date.now() - 8 * 3600e3,
    refreshToken: 'tsr_valid',
    refreshExpiresAt: Date.now() + 29 * 24 * 3600e3,
    oauthClientId: 'tsc_client',
  }
})

function handlerOf(register: (s: McpServer) => void, method: 'tool' | 'resource', name: string) {
  const server = new McpServer({ name: 't', version: '0' }, { capabilities: {} })
  const spy = vi.spyOn(server, method as any)
  register(server)
  const call = spy.mock.calls.find((c) => c[0] === name)
  if (!call) throw new Error(`${method} ${name} was not registered`)
  return call[call.length - 1] as (...args: any[]) => Promise<any>
}

describe('hasUsableToken', () => {
  it('stdio: rotates an expired access token with the refresh token, then answers true', async () => {
    mockFetch.mockResolvedValueOnce(refreshed())
    expect(await hasUsableToken()).toBe(true)
    expect(mockFetch.mock.calls[0][0]).toBe('https://www.tradestaq.com/api/oauth/token')
    expect(state.current.token).toBe('fresh-access-token')
  })

  it('stdio: false when the refresh token is refused (the session really ended)', async () => {
    mockFetch.mockResolvedValueOnce(json({ error: 'invalid_grant' }, 400))
    expect(await hasUsableToken()).toBe(false)
  })

  it('concurrent callers share one refresh (a second would reuse the token and revoke the family)', async () => {
    let release!: () => void
    mockFetch.mockImplementationOnce(() => new Promise((r) => { release = () => r(refreshed()) }))
    const both = Promise.all([hasUsableToken(), hasUsableToken()])
    await new Promise((r) => setTimeout(r, 0))
    release()
    expect(await both).toEqual([true, true])
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(state.current.refreshToken).toBe('tsr_rotated')
  })

  it('a refused refresh does not clear tokens that were rotated meanwhile', async () => {
    mockFetch.mockImplementationOnce(async () => {
      // Another process sharing the config rotated it while this refresh was in flight.
      state.current = { ...state.current, token: 'other-process-token', tokenExpiresAt: Date.now() + 3600e3, refreshToken: 'tsr_other' }
      return json({ error: 'invalid_grant' }, 400)
    })
    expect(await hasUsableToken()).toBe(true)
    expect(state.current).toMatchObject({ token: 'other-process-token', refreshToken: 'tsr_other' })
  })

  it('hosted: a request without a bearer is not authenticated by a valid file token', async () => {
    state.current = { baseUrl: 'https://www.tradestaq.com', token: 'valid-file-token-xyz', tokenExpiresAt: Date.now() + 3600e3 }
    expect(await requestContext.run({ token: undefined as any }, () => hasUsableToken())).toBe(false)
  })

  it('hosted: the request bearer decides; the file token is never refreshed or read', async () => {
    expect(await requestContext.run({ token: 'bearer-x' }, () => hasUsableToken())).toBe(true)
    expect(await requestContext.run({ token: undefined as any }, () => hasUsableToken())).toBe(false)
    expect(mockFetch).not.toHaveBeenCalled()
  })
})

describe('check_auth', () => {
  it('reports the account after an idle night instead of "Not authenticated"', async () => {
    mockFetch.mockResolvedValueOnce(refreshed()).mockResolvedValueOnce(me())
    const res = await handlerOf(registerAuthTools, 'tool', 'check_auth')({})
    expect(res.content[0].text).toContain('Authenticated as Owner (owner@example.com).')
    // The account read carried the rotated token.
    expect(mockFetch.mock.calls[1][1].headers.Authorization).toBe('Bearer fresh-access-token')
  })

  it('still says "Not authenticated" when the refresh is refused', async () => {
    mockFetch.mockResolvedValueOnce(json({ error: 'invalid_grant' }, 400))
    const res = await handlerOf(registerAuthTools, 'tool', 'check_auth')({})
    expect(res.content[0].text).toMatch(/^Not authenticated\. Use `authenticate`/)
  })
})

describe('authenticate', () => {
  it('does not start a new browser flow when the stored session only needed a refresh', async () => {
    mockFetch.mockResolvedValueOnce(refreshed())
    const res = await handlerOf(registerAuthTools, 'tool', 'authenticate')({ scope: 'mcp:read' })
    expect(res.content[0].text).toMatch(/^Already authenticated/)
  })
})

describe('resources', () => {
  // The API's real shapes, answered by path (the portfolio resource reads three endpoints).
  const byPath = (url: string) => {
    const path = new URL(url).pathname
    if (path === '/api/oauth/token') return refreshed()
    if (path === '/api/v1/portfolio') return json({ total: 10, change24h: 0, exchanges: [] })
    if (path === '/api/v1/positions') return json({ positions: [] })
    if (path === '/api/bots') return json({ docs: [{ id: 'b1', name: 'Bot', status: 'active' }] })
    return json({}, 404)
  }

  it('hosted: tradestaq://portfolio and tradestaq://bots use the request bearer', async () => {
    state.current = { baseUrl: 'https://www.tradestaq.com' } // no file token on the server
    mockFetch.mockImplementation(async (url: string) => byPath(url))
    const portfolio = await requestContext.run({ token: 'bearer-x' }, () =>
      handlerOf(registerResources, 'resource', 'portfolio')(new URL('tradestaq://portfolio')),
    )
    expect(JSON.parse(portfolio.contents[0].text)).toMatchObject({ totalBalance: 10, activeBots: 1, positions: [] })

    const bots = await requestContext.run({ token: 'bearer-x' }, () =>
      handlerOf(registerResources, 'resource', 'bots')(new URL('tradestaq://bots')),
    )
    expect(JSON.parse(bots.contents[0].text)[0]).toMatchObject({ id: 'b1', name: 'Bot' })
    expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(4)
    for (const call of mockFetch.mock.calls) expect(call[1].headers.Authorization).toBe('Bearer bearer-x')
  })

  it('stdio: an expired access token is refreshed before reading the portfolio', async () => {
    mockFetch.mockImplementation(async (url: string) => byPath(url))
    const res = await handlerOf(registerResources, 'resource', 'portfolio')(new URL('tradestaq://portfolio'))
    expect(JSON.parse(res.contents[0].text)).toMatchObject({ totalBalance: 10 })
    // One refresh, first; every read after it carries the rotated token.
    expect(new URL(mockFetch.mock.calls[0][0]).pathname).toBe('/api/oauth/token')
    expect(mockFetch.mock.calls.filter((c) => new URL(c[0]).pathname === '/api/oauth/token')).toHaveLength(1)
    for (const call of mockFetch.mock.calls.slice(1)) expect(call[1].headers.Authorization).toBe('Bearer fresh-access-token')
  })
})
