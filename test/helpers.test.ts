import { describe, it, expect, vi, beforeEach } from 'vitest'
import { jsonResult, withErrorHandling } from '../src/helpers.js'
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
