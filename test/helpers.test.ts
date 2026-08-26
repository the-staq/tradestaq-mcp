import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockApi } = vi.hoisted(() => ({ mockApi: vi.fn() }))
vi.mock('../src/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api.js')>('../src/api.js')
  return { ...actual, api: mockApi }
})

import { jsonResult, withErrorHandling, resolveStrategyName } from '../src/helpers.js'
import { ApiError } from '../src/api.js'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('jsonResult', () => {
  it('returns correct content structure', () => {
    const data = { symbol: 'BTC/USDT', price: 50000 }
    const result = jsonResult(data)

    expect(result).toEqual({
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    })
  })
})

describe('withErrorHandling', () => {
  it('passes through successful result', async () => {
    const successResult = { content: [{ type: 'text' as const, text: 'ok' }] }
    const handler = withErrorHandling(async () => successResult)

    const result = await handler()
    expect(result).toEqual(successResult)
  })

  it('catches ApiError and returns structured error with retryable', async () => {
    const handler = withErrorHandling(async () => {
      throw new ApiError(429, 'RATE_LIMITED', 'Too many requests', true)
    })

    const result = await handler()
    expect(result.isError).toBe(true)
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.error.code).toBe('RATE_LIMITED')
    expect(parsed.error.message).toBe('Too many requests')
    expect(parsed.error.retryable).toBe(true)
    expect(parsed.error.retryAfterMs).toBe(5000)
  })

  it('catches generic Error and returns INTERNAL_ERROR', async () => {
    const handler = withErrorHandling(async () => {
      throw new Error('Something broke')
    })

    const result = await handler()
    expect(result.isError).toBe(true)
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.error.code).toBe('INTERNAL_ERROR')
    expect(parsed.error.message).toBe('Something broke')
    expect(parsed.error.retryable).toBe(false)
  })
})

describe('resolveStrategyName', () => {
  it('returns the name from the owner-authoritative endpoint', async () => {
    mockApi.mockResolvedValueOnce({ data: { name: 'GridRunner' } })

    const name = await resolveStrategyName('s1')

    expect(name).toBe('GridRunner')
    expect(mockApi).toHaveBeenCalledWith('/api/user-strategies/s1')
  })

  it('falls back to the marketplace endpoint on a 403 (not the owner)', async () => {
    mockApi
      .mockRejectedValueOnce(new ApiError(403, 'HTTP_403', 'Forbidden', false))
      .mockResolvedValueOnce({ doc: { name: 'GhostRider' } })

    const name = await resolveStrategyName('s2')

    expect(name).toBe('GhostRider')
    expect(mockApi).toHaveBeenNthCalledWith(1, '/api/user-strategies/s2')
    expect(mockApi).toHaveBeenNthCalledWith(2, '/api/tradedroid/strategies/s2')
  })

  it('falls back to the marketplace endpoint on a 404', async () => {
    mockApi
      .mockRejectedValueOnce(new ApiError(404, 'HTTP_404', 'Not Found', false))
      .mockResolvedValueOnce({ doc: { name: 'Crowd Fade' } })

    const name = await resolveStrategyName('s3')

    expect(name).toBe('Crowd Fade')
  })

  it('falls back to the raw ID when both lookups fail', async () => {
    mockApi
      .mockRejectedValueOnce(new ApiError(404, 'HTTP_404', 'Not Found', false))
      .mockRejectedValueOnce(new ApiError(404, 'HTTP_404', 'Not Found', false))

    const name = await resolveStrategyName('s4')

    expect(name).toBe('s4')
  })

  it('falls back to the raw ID when the owner lookup throws a non-403/404 error', async () => {
    mockApi.mockRejectedValueOnce(new ApiError(500, 'HTTP_500', 'Internal error', true))

    const name = await resolveStrategyName('s5')

    expect(name).toBe('s5')
    expect(mockApi).toHaveBeenCalledTimes(1)
  })
})
