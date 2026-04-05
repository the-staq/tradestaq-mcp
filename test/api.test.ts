import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockLoadConfig, mockFetch } = vi.hoisted(() => ({
  mockLoadConfig: vi.fn(),
  mockFetch: vi.fn(),
}))

vi.mock('../src/config.js', () => ({
  loadConfig: mockLoadConfig,
}))

vi.stubGlobal('fetch', mockFetch)

import { api, ApiError } from '../src/api.js'

beforeEach(() => {
  vi.clearAllMocks()
  mockLoadConfig.mockReturnValue({
    token: 'test-token',
    baseUrl: 'https://tradestaq.com',
  })
})

describe('api', () => {
  it('successful GET returns parsed JSON', async () => {
    const body = { symbol: 'BTC/USDT', price: 50000 }
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => body,
    })

    const result = await api('/api/trading/price?symbol=BTC/USDT')
    expect(result).toEqual(body)
    expect(mockFetch).toHaveBeenCalledTimes(1)

    const [url, opts] = mockFetch.mock.calls[0]
    expect(url).toBe('https://tradestaq.com/api/trading/price?symbol=BTC/USDT')
    expect(opts.method).toBe('GET')
    expect(opts.headers.Authorization).toBe('Bearer test-token')
  })

  it('successful POST sends body and returns parsed JSON', async () => {
    const requestBody = { name: 'my-bot' }
    const responseBody = { id: 'bot-1' }
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => responseBody,
    })

    const result = await api('/api/bots', { method: 'POST', body: requestBody })
    expect(result).toEqual(responseBody)

    const [, opts] = mockFetch.mock.calls[0]
    expect(opts.method).toBe('POST')
    expect(opts.body).toBe(JSON.stringify(requestBody))
  })

  it('throws AUTH_EXPIRED when no token', async () => {
    mockLoadConfig.mockReturnValue({ baseUrl: 'https://tradestaq.com' })

    await expect(api('/api/anything')).rejects.toThrow(ApiError)
    await expect(api('/api/anything')).rejects.toMatchObject({
      code: 'AUTH_EXPIRED',
      status: 401,
    })
  })

  it('throws ApiError with code from response on 400', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { code: 'INVALID_PARAMS', message: 'Bad request' } }),
    })

    await expect(api('/api/something')).rejects.toMatchObject({
      status: 400,
      code: 'INVALID_PARAMS',
      message: 'Bad request',
      retryable: false,
    })
  })

  it('sets retryable=true on 429', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ error: { code: 'RATE_LIMITED', message: 'Too many requests' } }),
    })

    await expect(api('/api/something')).rejects.toMatchObject({
      status: 429,
      retryable: true,
    })
  })

  it('sets retryable=true on 500', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: { code: 'SERVER_ERROR', message: 'Internal error' } }),
    })

    await expect(api('/api/something')).rejects.toMatchObject({
      status: 500,
      retryable: true,
    })
  })

  it('throws TIMEOUT on AbortError', async () => {
    const abortError = new Error('The operation was aborted')
    abortError.name = 'AbortError'
    mockFetch.mockRejectedValue(abortError)

    await expect(api('/api/something')).rejects.toMatchObject({
      code: 'TIMEOUT',
      status: 408,
      retryable: true,
    })
  })

  it('throws NETWORK_ERROR on generic fetch failure', async () => {
    mockFetch.mockRejectedValue(new TypeError('fetch failed'))

    await expect(api('/api/something')).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
      status: 0,
      retryable: true,
    })
  })
})
