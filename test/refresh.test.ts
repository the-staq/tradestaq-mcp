import { describe, it, expect, vi, beforeEach } from 'vitest'

// Stateful config mock: saveConfig updates the object loadConfig returns, the
// same way the real module-level cache behaves — so rotation is observable.
const { mockLoadConfig, mockSaveConfig, mockFetch, state } = vi.hoisted(() => {
  const state: { current: any } = { current: {} }
  return {
    state,
    mockLoadConfig: vi.fn(() => state.current),
    mockSaveConfig: vi.fn((c: any) => {
      state.current = c
    }),
    mockFetch: vi.fn(),
  }
})

vi.mock('../src/config.js', () => ({
  loadConfig: mockLoadConfig,
  saveConfig: mockSaveConfig,
}))
vi.stubGlobal('fetch', mockFetch)

import { api } from '../src/api.js'
import { requestContext } from '../src/request-context.js'

beforeEach(() => {
  vi.clearAllMocks()
  state.current = {
    token: 'old-access',
    baseUrl: 'https://www.tradestaq.com',
    refreshToken: 'tsr_refresh_1',
    oauthClientId: 'tsc_abc',
    oauthClientRefreshCapable: true,
    tokenExpiresAt: Date.now() + 60 * 1000, // ~1 min left → within the 5-min skew
    refreshExpiresAt: Date.now() + 30 * 24 * 3600 * 1000,
  }
})

describe('OAuth refresh (stdio)', () => {
  it('rotates an expiring access token BEFORE the API call, and uses the new one', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'new-access', refresh_token: 'tsr_refresh_2', expires_in: 3600 }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ price: 1 }) })

    const res = await api('/api/trading/price')
    expect(res).toEqual({ price: 1 })

    // First call is the refresh grant…
    const [refreshUrl, refreshOpts] = mockFetch.mock.calls[0]
    expect(refreshUrl).toBe('https://www.tradestaq.com/api/oauth/token')
    expect(refreshOpts.body).toContain('grant_type=refresh_token')
    expect(refreshOpts.body).toContain('refresh_token=tsr_refresh_1')
    // …then the real API call carries the NEW access token.
    expect(mockFetch.mock.calls[1][1].headers.Authorization).toBe('Bearer new-access')
    // Rotated pair persisted.
    expect(state.current.token).toBe('new-access')
    expect(state.current.refreshToken).toBe('tsr_refresh_2')
  })

  it('does not refresh when the access token still has ample life', async () => {
    state.current.tokenExpiresAt = Date.now() + 60 * 60 * 1000 // 60 min
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: 1 }) })

    await api('/api/x')
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(mockFetch.mock.calls[0][0]).toBe('https://www.tradestaq.com/api/x')
  })

  it('recovers from a 401 by rotating once and retrying', async () => {
    state.current.tokenExpiresAt = Date.now() + 60 * 60 * 1000 // healthy → no proactive refresh
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'new-access', refresh_token: 'tsr_2', expires_in: 3600 }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ recovered: true }) })

    const res = await api('/api/x')
    expect(res).toEqual({ recovered: true })
    expect(mockFetch.mock.calls[1][0]).toBe('https://www.tradestaq.com/api/oauth/token')
    expect(mockFetch.mock.calls[2][1].headers.Authorization).toBe('Bearer new-access')
  })

  it('clears tokens when the refresh token is rejected (invalid_grant)', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) })

    await expect(api('/api/x')).rejects.toMatchObject({ code: 'AUTH_EXPIRED' })
    expect(mockFetch).toHaveBeenCalledTimes(1) // only the refresh; no API call with a dead token
    expect(state.current.token).toBeUndefined()
    expect(state.current.refreshToken).toBeUndefined()
  })

  it('hosted (per-request bearer) never rotates the shared file token', async () => {
    state.current.tokenExpiresAt = Date.now() + 60 * 1000 // would trigger a stdio refresh
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: 1 }) })

    await requestContext.run({ token: 'req-bearer' }, async () => {
      await api('/api/x')
    })

    expect(mockFetch).toHaveBeenCalledTimes(1) // no /api/oauth/token call
    expect(mockFetch.mock.calls[0][1].headers.Authorization).toBe('Bearer req-bearer')
  })
})
