// close_position through the REAL api() (only fetch and the config file are stubbed): a close
// POST that gets no answer is sent exactly once and reported as an unknown outcome, never
// resent. Before the fix api() aborted a close at 30s and re-POSTed it (also on a 5xx /
// network error) while the first close was still running, closing the position 2-3 times.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

const { mockLoadConfig, mockFetch } = vi.hoisted(() => ({
  mockLoadConfig: vi.fn(),
  mockFetch: vi.fn(),
}))

vi.mock('../src/config.js', () => ({
  loadConfig: mockLoadConfig,
  saveConfig: vi.fn(),
}))

vi.stubGlobal('fetch', mockFetch)

import { registerBotTools } from '../src/tools/bot.js'

const BASE = 'https://tradestaq.com'
const SOL = { exchangeId: 'ex-1', exchange: 'kucoin', symbol: 'SOL/USDT', side: 'long', size: 52.81, botId: 'bot-sol', botName: 'MFRider SOL', botCount: 1 }
const ARGS = { exchangeId: 'ex-1', symbol: 'SOL/USDT', side: 'long', percentage: 50 }

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body })
const abortError = () => Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })

// Routes the stubbed fetch: the positions lookup answers with SOL, the close POST with `close`.
function route(close: (opts: any) => Promise<unknown>) {
  mockFetch.mockImplementation(async (url: string, opts: any) => {
    if (url === `${BASE}/api/v1/positions`) return ok({ positions: [SOL] })
    if (url === `${BASE}/api/positions/close`) return close(opts)
    throw new Error(`unexpected fetch ${url}`)
  })
}

const closeCalls = () => mockFetch.mock.calls.filter(([url]) => url === `${BASE}/api/positions/close`)

function closePosition() {
  const server = new McpServer({ name: 'test-server', version: '0.0.1' }, { capabilities: { logging: {} } })
  const toolSpy = vi.spyOn(server, 'tool')
  registerBotTools(server)
  const call = toolSpy.mock.calls.find((c) => c[0] === 'close_position')!
  return call[call.length - 1] as (args: any) => Promise<any>
}

function errorOf(result: any) {
  expect(result.isError).toBe(true)
  return JSON.parse(result.content[0].text).error
}

beforeEach(() => {
  vi.clearAllMocks()
  mockFetch.mockReset()
  mockLoadConfig.mockReturnValue({ token: 'test-token', baseUrl: BASE })
})

// Value: protects=one close_position call sends one close order; fails_when=api() resends the close POST after a timeout / 5xx / network error (2026-10 HIGH: a live 50% close closed 100%+); why_new=HIGH double-close fix; seam=fetch stub under the real api(); no_claim=the server's own idempotency dedupe
describe('close_position over the real api(): a close that gets no answer is never resent', () => {
  it.each([
    ['a 504 (proxy timeout)', async () => ({ ok: false, status: 504, json: async () => { throw new SyntaxError('<html>') } }), 'HTTP 504'],
    ['a 524 (Cloudflare timeout)', async () => ({ ok: false, status: 524, json: async () => { throw new SyntaxError('<html>') } }), 'HTTP 524'],
    ['a 503', async () => ({ ok: false, status: 503, json: async () => ({ success: false, message: 'down' }) }), 'HTTP 503'],
    ['a network error', async () => { throw new TypeError('fetch failed') }, 'a network error'],
    ['an abort', async () => { throw abortError() }, 'the request timed out'],
  ])('%s: the close POST is sent once; CLOSE_OUTCOME_UNKNOWN, not retryable', async (_label, close, reason) => {
    route(close)
    const error = errorOf(await closePosition()(ARGS))
    expect(closeCalls()).toHaveLength(1)
    expect(error).toMatchObject({ code: 'CLOSE_OUTCOME_UNKNOWN', retryable: false, closedOnExchange: 'maybe' })
    expect(error).not.toHaveProperty('retryAfterMs')
    expect(error.message).toContain(reason)
    expect(error.message).toContain('Check get_positions before retrying')
  })

  it('waits 120s for the close (not the default 30s), then aborts once and does not resend', async () => {
    vi.useFakeTimers()
    try {
      route((opts) => new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => reject(abortError()))
      }))
      const pending = closePosition()(ARGS)
      let settled = false
      void pending.then(() => { settled = true })

      await vi.advanceTimersByTimeAsync(0)
      expect(closeCalls()).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(119_999)
      expect(settled).toBe(false)
      expect(closeCalls()).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(1)
      // Checked before awaiting: a resend would hang on its own fresh timeout.
      expect(closeCalls()).toHaveLength(1)
      expect(settled).toBe(true)

      const error = errorOf(await pending)
      expect(error).toMatchObject({ code: 'CLOSE_OUTCOME_UNKNOWN', retryable: false })
    } finally {
      vi.useRealTimers()
    }
  })

  it('sends the same idempotency key as the Idempotency-Key header and the body requestId; Authorization stays the bearer', async () => {
    route(async () => ok({ success: true, closedSize: 26.405, filledSize: 26.405, exitPrice: 191.2, botId: 'bot-sol', partial: true }))
    const result = await closePosition()(ARGS)
    expect(result.isError).toBeUndefined()
    const [, opts] = closeCalls()[0]
    const body = JSON.parse(opts.body)
    expect(body).toMatchObject({ exchangeId: 'ex-1', symbol: 'SOL/USDT', side: 'long', size: 26.405, botId: 'bot-sol' })
    expect(typeof body.requestId).toBe('string')
    expect(opts.headers['Idempotency-Key']).toBe(body.requestId)
    expect(opts.headers.Authorization).toBe('Bearer test-token')
  })

  it('the positions lookup before the close keeps the default retries', async () => {
    let lookups = 0
    mockFetch.mockImplementation(async (url: string) => {
      if (url === `${BASE}/api/v1/positions`) {
        lookups++
        return lookups === 1 ? { ok: false, status: 503, json: async () => ({}) } : ok({ positions: [SOL] })
      }
      return ok({ success: true, closedSize: 26.405, exitPrice: 191.2 })
    })
    const result = await closePosition()(ARGS)
    expect(result.isError).toBeUndefined()
    expect(lookups).toBe(2)
    expect(closeCalls()).toHaveLength(1)
  })
})
