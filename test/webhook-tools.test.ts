import { describe, it, expect, vi, beforeEach } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerWebhookTools } from '../src/tools/webhooks.js'
import { registerBotTools } from '../src/tools/bot.js'
import { ApiError } from '../src/api.js'

const { mockApi } = vi.hoisted(() => ({ mockApi: vi.fn() }))
vi.mock('../src/api.js', async (orig) => ({ ...(await orig<typeof import('../src/api.js')>()), api: mockApi }))

beforeEach(() => {
  vi.resetAllMocks()
})

function register(fn: (s: McpServer) => void) {
  const server = new McpServer({ name: 'test-server', version: '0.0.1' }, { capabilities: { logging: {} } })
  const spy = vi.spyOn(server, 'tool')
  fn(server)
  return spy.mock.calls
}
function handler(name: string) {
  const calls = [...register(registerWebhookTools), ...register(registerBotTools)]
  const call = calls.find((c) => c[0] === name)
  if (!call) throw new Error(`tool ${name} was not registered`)
  return call[call.length - 1] as (args: any) => Promise<any>
}
function annotationsOf(name: string) {
  const call = register(registerWebhookTools).find((c) => c[0] === name)!
  return call[call.length - 2] as Record<string, unknown>
}
const descriptionOf = (name: string) => register(registerWebhookTools).find((c) => c[0] === name)![1] as string

const textOf = (r: any) => r.content[0].text as string
const jsonOf = (r: any) => JSON.parse(textOf(r))

const BOT = 'c'.repeat(24)
const DEST = 'd'.repeat(24)
const SECRET = 'Bearer sk-live-SUPERSECRET-123456'
const SECRET2 = 'tok_another_secret_value_9'

const PAPER_EXCHANGE = { id: 'ex-paper-1', name: 'Bybit Futures Paper', isPaper: true }
const STRATEGY = '6a0000000000000000000001'
const DEPLOY = { strategyId: STRATEGY, exchangeId: 'ex-paper-1', symbol: 'BTC/USDT', live: false, positionSizePercent: 10, leverage: 1, start: true }

const serverDest = (over: Record<string, unknown> = {}) => ({
  id: DEST, botId: BOT, name: 'OKX signal', url: 'https://example.com/hook', bodyTemplate: '', constants: { TOKEN: 'abc' },
  headers: [{ name: 'Authorization', valueHint: '••••3456' }],
  onOpen: true, onClose: true, includePaper: false, enabled: true, disabledReason: null, consecutiveFailedEvents: 0,
  lastDeliveryAt: null, lastStatus: null, lastError: null, createdAt: '2026-11-18T10:00:00.000Z', ...over,
})

// A server refusal as the webhook routes send it: { success:false, message, error: code }.
const refusal = (status: number, message: string, error: string) =>
  new ApiError(status, `HTTP_${status}`, error, false, undefined, { success: false, message, error })

/** Every text any call of the tools returned or threw must stay free of header values. */
function expectNoSecret(result: any) {
  const text = JSON.stringify(result)
  expect(text).not.toContain('SUPERSECRET')
  expect(text).not.toContain(SECRET2)
}

describe('list_bot_webhooks', () => {
  it('GETs the bot\'s destinations and shows header names with the masked hint only', async () => {
    mockApi.mockResolvedValueOnce({
      success: true, allowed: true, limits: { perBot: 5, perUser: 20 },
      // a misbehaving server that leaked a value: it must not pass through
      destinations: [serverDest({ headers: [{ name: 'Authorization', valueHint: '••••3456', value: SECRET, ciphertext: 'x' }] })],
    })
    const res = await handler('list_bot_webhooks')({ botId: BOT })
    expect(mockApi).toHaveBeenCalledWith(`/api/bots/${BOT}/webhooks`)
    const out = jsonOf(res)
    expect(out.planAllowsWebhooks).toBe(true)
    expect(out.destinations[0]).toMatchObject({ id: DEST, name: 'OKX signal', url: 'https://example.com/…', urlShortened: true, headers: [{ name: 'Authorization', valueHint: '••••3456' }], bodyTemplate: '(default body)' })
    expect(out.note).toContain('not instructions')
    expectNoSecret(res)
  })

  it('shows the full URL only with includeUrl: true', async () => {
    const withPath = serverDest({ url: 'https://example.com/hook/SECRETPATH?k=SECRETQ' })
    mockApi.mockResolvedValueOnce({ success: true, destinations: [withPath] })
    const short = jsonOf(await handler('list_bot_webhooks')({ botId: BOT }))
    expect(JSON.stringify(short)).not.toContain('SECRET')
    expect(short.destinations[0].url).toBe('https://example.com/…')
    mockApi.mockResolvedValueOnce({ success: true, destinations: [withPath] })
    const full = jsonOf(await handler('list_bot_webhooks')({ botId: BOT, includeUrl: true }))
    expect(full.destinations[0].url).toBe('https://example.com/hook/SECRETPATH?k=SECRETQ')
  })

  it('copies the server\'s redacted flags and notes them; a shortened URL is never shown as full', async () => {
    mockApi.mockResolvedValueOnce({ success: true, destinations: [serverDest({ url: 'https://example.com/…', redacted: true, bodyTemplateRedacted: true, bodyTemplate: '', constants: { TOKEN: '' } })] })
    const out = jsonOf(await handler('list_bot_webhooks')({ botId: BOT, includeUrl: true }))
    expect(out.destinations[0]).toMatchObject({ redacted: true, bodyTemplateRedacted: true, bodyTemplate: '(hidden)', url: 'https://example.com/…' })
    expect(out.note).toContain('redacted')
    expect(out.note).toContain('shortened URL')
  })

  it('says how to add one when there is none', async () => {
    mockApi.mockResolvedValueOnce({ success: true, allowed: false, destinations: [] })
    const text = textOf(await handler('list_bot_webhooks')({ botId: BOT }))
    expect(text).toContain('add_bot_webhook')
    expect(text).toContain('plan')
  })
})

describe('add_bot_webhook', () => {
  it('POSTs the destination once (retry: false) and never echoes a header value', async () => {
    mockApi.mockResolvedValueOnce({ success: true, destination: serverDest() })
    const input = { name: 'OKX signal', url: 'https://example.com/hook', bodyTemplate: '{"a":"{{action}}"}', headers: [{ name: 'Authorization', value: SECRET }], constants: { TOKEN: 'abc' }, includePaper: false }
    const res = await handler('add_bot_webhook')({ botId: BOT, ...input })

    expect(mockApi).toHaveBeenCalledTimes(1)
    expect(mockApi).toHaveBeenCalledWith(`/api/bots/${BOT}/webhooks`, { method: 'POST', retry: false, body: input })
    expect(jsonOf(res).destination.headers).toEqual([{ name: 'Authorization', valueHint: '••••3456' }])
    expect(textOf(res)).toContain('write-only')
    expectNoSecret(res)
  })

  it('surfaces the server\'s plan refusal with its sentence, and never the header value', async () => {
    mockApi.mockRejectedValueOnce(refusal(403, `Your current plan does not include outgoing webhooks. (${SECRET})`, 'plan_required'))
    const res = await handler('add_bot_webhook')({ botId: BOT, name: 'x', url: 'https://example.com/h', headers: [{ name: 'Authorization', value: SECRET }] })
    expect(res.isError).toBe(true)
    const { error } = jsonOf(res)
    expect(error.code).toBe('plan_required')
    expect(error.message).toContain('plan does not include outgoing webhooks')
    expect(error.message).toContain('upgrade')
    expectNoSecret(res)
  })

  it.each([
    [409, 'A bot can have at most 5 webhook destinations.', 'limit_per_bot'],
    [400, 'The template is not valid JSON once its variables are filled in.', 'The template is not valid JSON once its variables are filled in.'],
  ])('passes a %s through with its message', async (status, message, error) => {
    mockApi.mockRejectedValueOnce(refusal(status as number, message as string, error as string))
    const res = await handler('add_bot_webhook')({ botId: BOT, name: 'x', url: 'https://example.com/h' })
    expect(res.isError).toBe(true)
    expect(jsonOf(res).error.message).toContain(message as string)
  })

  it('a timeout is WEBHOOK_OUTCOME_UNKNOWN (it may exist), not retryable', async () => {
    mockApi.mockRejectedValueOnce(new ApiError(408, 'TIMEOUT', 'Request timed out', false))
    const res = await handler('add_bot_webhook')({ botId: BOT, name: 'x', url: 'https://example.com/h' })
    const { error } = jsonOf(res)
    expect(error.code).toBe('WEBHOOK_OUTCOME_UNKNOWN')
    expect(error.retryable).toBe(false)
    expect(error.message).toContain('list_bot_webhooks')
  })

  it('describes the events, the confirmation, the variables, the plan and the secrets rule', () => {
    const d = descriptionOf('add_bot_webhook')
    for (const v of ['action', 'side', 'symbol', 'base', 'quote', 'instrument_id', 'price', 'size', 'notional_usd', 'stop', 'take_profit', 'pnl', 'reason', 'bot_name', 'strategy', 'bot_id', 'event_id', 'timestamp', 'timestamp_ms', 'is_paper', 'source']) {
      expect(d).toContain(`{{${v}}}`)
    }
    expect(d).toContain('{{const.NAME}}')
    expect(d).toContain('signal forwarding')
    expect(d).toContain('confirm the URL')
    expect(d).toContain('paste a secret')
    expect(d).toContain('includePaper')
  })
})

describe('update_bot_webhook', () => {
  it('PATCHes only the fields given, once, and a header without a value keeps its stored one', async () => {
    mockApi.mockResolvedValueOnce({ success: true, destination: serverDest({ enabled: true }) })
    const res = await handler('update_bot_webhook')({ botId: BOT, destinationId: DEST, enabled: true, headers: [{ name: 'Authorization' }, { name: 'X-Key', value: SECRET2 }] })
    expect(mockApi).toHaveBeenCalledWith(`/api/bots/${BOT}/webhooks/${DEST}`, {
      method: 'PATCH', retry: false,
      body: { enabled: true, headers: [{ name: 'Authorization' }, { name: 'X-Key', value: SECRET2 }] },
    })
    expectNoSecret(res)
  })

  it('refuses an empty change without calling the API', async () => {
    const res = await handler('update_bot_webhook')({ botId: BOT, destinationId: DEST })
    expect(res.isError).toBe(true)
    expect(jsonOf(res).error.code).toBe('NO_CHANGES')
    expect(mockApi).not.toHaveBeenCalled()
  })

  it('scrubs a header value out of a server error', async () => {
    mockApi.mockRejectedValueOnce(refusal(400, `Header "X-Key" invalid: ${SECRET2}`, 'x'))
    const res = await handler('update_bot_webhook')({ botId: BOT, destinationId: DEST, headers: [{ name: 'X-Key', value: SECRET2 }] })
    expect(res.isError).toBe(true)
    expectNoSecret(res)
  })
})

describe('delete_bot_webhook', () => {
  it('DELETEs by bot and destination and is marked destructive, with a confirm-first description', async () => {
    mockApi.mockResolvedValueOnce({ success: true })
    const res = await handler('delete_bot_webhook')({ botId: BOT, destinationId: DEST })
    expect(mockApi).toHaveBeenCalledWith(`/api/bots/${BOT}/webhooks/${DEST}`, { method: 'DELETE', retry: false })
    expect(textOf(res)).toContain('deleted')
    expect(annotationsOf('delete_bot_webhook')).toMatchObject({ destructiveHint: true })
    expect(descriptionOf('delete_bot_webhook')).toContain('confirm with the user')
  })
})

describe('preview_bot_webhook', () => {
  it('previews a saved destination (no network to the user URL), with an optional unsaved template', async () => {
    mockApi.mockResolvedValueOnce({ success: true, body: '{"a":"enter_long"}', validJson: true, headerNames: ['Content-Type', 'User-Agent', 'Authorization'] })
    const res = await handler('preview_bot_webhook')({ botId: BOT, destinationId: DEST, bodyTemplate: '{"a":"{{action}}"}' })
    expect(mockApi).toHaveBeenCalledWith(`/api/bots/${BOT}/webhooks/${DEST}/preview`, { method: 'POST', body: { bodyTemplate: '{"a":"{{action}}"}' } })
    expect(jsonOf(res)).toMatchObject({ body: '{"a":"enter_long"}', validJson: true, headerNames: ['Content-Type', 'User-Agent', 'Authorization'] })
    expect(annotationsOf('preview_bot_webhook')).toMatchObject({ readOnlyHint: true })
  })

  it('previews an unsaved template on the bot-level preview route', async () => {
    mockApi.mockResolvedValueOnce({ success: true, body: '{}', validJson: true, headerNames: ['Content-Type', 'User-Agent'] })
    await handler('preview_bot_webhook')({ botId: BOT, bodyTemplate: '{}', constants: { A: 'b' }, headerNames: ['Authorization'] })
    expect(mockApi).toHaveBeenCalledWith(`/api/bots/${BOT}/webhooks/preview`, { method: 'POST', body: { bodyTemplate: '{}', constants: { A: 'b' }, headerNames: ['Authorization'] } })
  })
})

describe('test_bot_webhook', () => {
  it('without confirm: true it never calls the API', async () => {
    for (const confirm of [false, undefined]) {
      const res = await handler('test_bot_webhook')({ botId: BOT, destinationId: DEST, confirm })
      expect(res.isError).toBe(true)
      expect(jsonOf(res).error.code).toBe('CONFIRM_REQUIRED')
    }
    expect(mockApi).not.toHaveBeenCalled()
  })

  it('with confirm: true it sends the request once with { confirm: true } and reports the receiver\'s answer', async () => {
    mockApi.mockResolvedValueOnce({ success: true, ok: true, status: 200, ms: 120, error: null, excerpt: '{"code":"0"}' })
    const res = await handler('test_bot_webhook')({ botId: BOT, destinationId: DEST, confirm: true })
    expect(mockApi).toHaveBeenCalledTimes(1)
    expect(mockApi).toHaveBeenCalledWith(`/api/bots/${BOT}/webhooks/${DEST}/test`, { method: 'POST', retry: false, body: { confirm: true } })
    expect(jsonOf(res)).toMatchObject({ sent: true, ok: true, httpStatus: 200, ms: 120, responseExcerpt: '{"code":"0"}' })
  })

  it('warns in its description that the request is real and a trading service may act on it', () => {
    const d = descriptionOf('test_bot_webhook')
    expect(d).toContain('REAL request')
    expect(d).toContain('trading service')
    expect(d).toContain('Confirm with the user')
    expect(d).toContain('preview_bot_webhook')
  })

  it('the hourly limit is passed through', async () => {
    mockApi.mockRejectedValueOnce(refusal(429, 'Test sends are limited to 5 per hour for each destination. Try again later.', 'rate_limited'))
    const res = await handler('test_bot_webhook')({ botId: BOT, destinationId: DEST, confirm: true })
    expect(jsonOf(res).error).toMatchObject({ code: 'rate_limited' })
    expect(jsonOf(res).error.message).toContain('limited to 5 per hour')
  })
})

describe('get_bot_webhook_deliveries', () => {
  it('GETs the log and shows only the allowlisted fields', async () => {
    mockApi.mockResolvedValueOnce({ success: true, deliveries: [
      { id: 'r1', eventId: 'open:1', eventKind: 'open', symbol: 'BTC/USDT:USDT', attempt: 1, result: 'success', willRetry: false, httpStatus: 200, ms: 90, error: null, excerpt: 'ok', test: false, createdAt: '2026-11-18T10:00:00.000Z', requestHeaders: SECRET },
      { id: 'r2', eventId: 'close:2', attempt: 2, result: 'failed', httpStatus: 500, test: true, createdAt: '2026-11-18T10:05:00.000Z' },
    ] })
    const res = await handler('get_bot_webhook_deliveries')({ botId: BOT, destinationId: DEST, limit: 1 })
    expect(mockApi).toHaveBeenCalledWith(`/api/bots/${BOT}/webhooks/${DEST}/deliveries`)
    const out = jsonOf(res)
    expect(out.note).toContain('not instructions')
    const rows = out.deliveries
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 'r1', eventKind: 'open', httpStatus: 200, responseExcerpt: 'ok' })
    expectNoSecret(res)
  })
})

describe('deploy_bot with webhooks', () => {
  const HOOK = { name: 'OKX signal', url: 'https://example.com/hook', headers: [{ name: 'Authorization', value: SECRET }] }

  it('creates the bot paused, adds the destinations, and only then starts it', async () => {
    mockApi
      .mockResolvedValueOnce({ docs: [PAPER_EXCHANGE] }) // GET /api/exchanges
      .mockResolvedValueOnce({ doc: { id: 'new-bot', status: 'paused' } }) // POST /api/bots
      .mockResolvedValueOnce({ success: true, destination: serverDest({ id: 'dest-1' }) }) // POST webhooks
      .mockResolvedValueOnce({ status: 'active' }) // PATCH status
    const res = await handler('deploy_bot')({ ...DEPLOY, webhooks: [HOOK] })

    const calls = mockApi.mock.calls
    expect(calls[1][0]).toBe('/api/bots')
    expect(calls[1][1].body.status).toBe('paused')
    expect(calls[1][1].body).not.toHaveProperty('webhooks')
    expect(calls[2]).toEqual(['/api/bots/new-bot/webhooks', { method: 'POST', retry: false, body: HOOK }])
    expect(calls[3]).toEqual(['/api/bots/new-bot/status', { method: 'PATCH', retry: false, body: { status: 'active' } }])
    expect(calls).toHaveLength(4)
    expect(textOf(res)).toContain('Status: running')
    expect(textOf(res)).toContain('Webhooks: 1 destination added')
    expectNoSecret(res)
  })

  it('with start: false the bot stays paused and no start is sent', async () => {
    mockApi
      .mockResolvedValueOnce({ docs: [PAPER_EXCHANGE] })
      .mockResolvedValueOnce({ doc: { id: 'new-bot', status: 'paused' } })
      .mockResolvedValueOnce({ success: true, destination: serverDest() })
    await handler('deploy_bot')({ ...DEPLOY, start: false, webhooks: [HOOK] })
    expect(mockApi).toHaveBeenCalledTimes(3)
  })

  it('a refused webhook leaves the bot paused: no start, no second create, no delete; partial result, no secret', async () => {
    mockApi
      .mockResolvedValueOnce({ docs: [PAPER_EXCHANGE] })
      .mockResolvedValueOnce({ doc: { id: 'new-bot', status: 'paused' } })
      .mockResolvedValueOnce({ success: true, destination: serverDest({ id: 'dest-1' }) })
      .mockRejectedValueOnce(refusal(400, `Header "Authorization" is invalid: ${SECRET}`, 'x'))
    const res = await handler('deploy_bot')({ ...DEPLOY, webhooks: [{ ...HOOK, name: 'first' }, { ...HOOK, name: 'second' }, { ...HOOK, name: 'third' }] })

    const paths = mockApi.mock.calls.map((c) => `${c[1]?.method ?? 'GET'} ${c[0]}`)
    expect(paths).toEqual(['GET /api/exchanges', 'POST /api/bots', 'POST /api/bots/new-bot/webhooks', 'POST /api/bots/new-bot/webhooks'])
    expect(paths.filter((p) => p === 'POST /api/bots')).toHaveLength(1) // creation not retried
    expect(paths.some((p) => p.includes('/status'))).toBe(false) // not started
    expect(paths.some((p) => p.startsWith('DELETE'))).toBe(false) // not deleted

    expect(res.isError).toBe(true)
    const { error } = jsonOf(res)
    expect(error.code).toBe('WEBHOOK_SETUP_FAILED')
    expect(error.botId).toBe('new-bot')
    expect(error.message).toContain('new-bot')
    expect(error.message).toContain('webhook 2 of 3')
    expect(error.message).toContain('"second"')
    expect(error.message).toContain('NOT started')
    expect(error.message).toContain('add_bot_webhook')
    expect(error.webhooksAdded).toEqual([{ id: 'dest-1', name: 'first' }])
    expect(error.webhooksNotAttempted).toEqual(['third'])
    expectNoSecret(res)
  })

  it('a webhook that got no answer says it may exist, and still does not start the bot', async () => {
    mockApi
      .mockResolvedValueOnce({ docs: [PAPER_EXCHANGE] })
      .mockResolvedValueOnce({ doc: { id: 'new-bot', status: 'paused' } })
      .mockRejectedValueOnce(new ApiError(504, 'HTTP_504', 'API returned 504 with a non-JSON response', false))
    const res = await handler('deploy_bot')({ ...DEPLOY, webhooks: [HOOK] })
    expect(mockApi).toHaveBeenCalledTimes(3)
    expect(jsonOf(res).error.message).toContain('may already exist')
  })

  it('with a preset and webhooks: preset check, then webhooks, then one start', async () => {
    mockApi
      .mockResolvedValueOnce({ docs: [PAPER_EXCHANGE] })
      .mockResolvedValueOnce({ doc: { id: 'new-bot', status: 'paused' }, appliedPreset: { name: 'Long Short', slug: 'p' } })
      .mockResolvedValueOnce({ success: true, destination: serverDest() })
      .mockResolvedValueOnce({ status: 'active' })
    await handler('deploy_bot')({ ...DEPLOY, presetId: 'p', webhooks: [HOOK] })
    expect(mockApi.mock.calls.map((c) => c[0])).toEqual(['/api/exchanges', '/api/bots', '/api/bots/new-bot/webhooks', '/api/bots/new-bot/status'])
  })

  it('without webhooks nothing changes: created running in one POST, no webhook or status call', async () => {
    mockApi
      .mockResolvedValueOnce({ docs: [PAPER_EXCHANGE] })
      .mockResolvedValueOnce({ doc: { id: 'new-bot', status: 'active' } })
    const res = await handler('deploy_bot')(DEPLOY)
    expect(mockApi).toHaveBeenCalledTimes(2)
    expect(mockApi.mock.calls[1][1].body).not.toHaveProperty('status')
    expect(textOf(res)).not.toContain('Webhooks')
  })
})

describe('update_bot with webhooks', () => {
  const HOOK = { name: 'Relay', url: 'https://example.com/hook', headers: [{ name: 'X-Key', value: SECRET }] }

  it('a webhooks-only call only POSTs adds: no GET, no PATCH, no delete, no listing', async () => {
    mockApi.mockResolvedValueOnce({ success: true, destination: serverDest({ id: 'dest-9', name: 'Relay' }) })
    const res = await handler('update_bot')({ id: BOT, webhooks: [HOOK] })
    expect(mockApi.mock.calls).toEqual([[`/api/bots/${BOT}/webhooks`, { method: 'POST', retry: false, body: HOOK }]])
    expect(textOf(res)).toContain('webhooks added: "Relay"')
    expectNoSecret(res)
  })

  it('with other changes: the bot PATCH goes first, then the adds', async () => {
    mockApi
      .mockResolvedValueOnce({ id: BOT, positionSizing: { type: 'percentage', value: 10, leverage: 1 } }) // GET bot
      .mockResolvedValueOnce({ success: true }) // PATCH
      .mockResolvedValueOnce({ success: true, destination: serverDest({ id: 'dest-9', name: 'Relay' }) }) // POST webhook
      .mockResolvedValueOnce({ id: BOT, status: 'active', positionSizing: { type: 'percentage', value: 10, leverage: 3 } }) // GET after
    const res = await handler('update_bot')({ id: BOT, leverage: 3, webhooks: [HOOK] })
    const seq = mockApi.mock.calls.map((c) => `${c[1]?.method ?? 'GET'} ${c[0]}`)
    expect(seq).toEqual([`GET /api/bots/${BOT}`, `PATCH /api/bots/${BOT}`, `POST /api/bots/${BOT}/webhooks`, `GET /api/bots/${BOT}`])
    expect(jsonOf(res).webhooks).toEqual({ added: [{ id: 'dest-9', name: 'Relay' }] })
  })

  it('a refused add reports the saved bot change and the failed webhook, retrying nothing', async () => {
    mockApi
      .mockResolvedValueOnce({ id: BOT, positionSizing: { type: 'percentage', value: 10, leverage: 1 } })
      .mockResolvedValueOnce({ success: true })
      .mockRejectedValueOnce(refusal(403, 'Your current plan does not include outgoing webhooks.', 'plan_required'))
    const res = await handler('update_bot')({ id: BOT, leverage: 3, webhooks: [HOOK] })
    expect(mockApi).toHaveBeenCalledTimes(3)
    expect(res.isError).toBe(true)
    const { error } = jsonOf(res)
    expect(error.code).toBe('WEBHOOK_SETUP_FAILED')
    expect(error.message).toContain('leverage: 3x')
    expect(error.message).toContain('saved')
    expect(error.message).toContain('plan does not include outgoing webhooks')
    expectNoSecret(res)
  })

  it('still refuses a call with nothing to change', async () => {
    const res = await handler('update_bot')({ id: BOT })
    expect(jsonOf(res).error.code).toBe('NO_CHANGES')
    expect(mockApi).not.toHaveBeenCalled()
  })

  it('says in its description that webhooks are only added', () => {
    const d = register(registerBotTools).find((c) => c[0] === 'update_bot')![1] as string
    expect(d).toContain('never replaces or deletes')
    expect(d).toContain('update_bot_webhook')
    expect(d).toContain('delete_bot_webhook')
  })
})

// --- review fixes ---------------------------------------------------------------

describe('test_bot_webhook: sent comes from evidence', () => {
  it.each([
    ['Destination not found.'],
    ['Your plan does not include outgoing webhooks.'],
    ['Test sends are unavailable right now. Try again shortly.'],
    ['The host could not be reached.'],
  ])('status null (%s): sent false, nothing claimed', async (error) => {
    mockApi.mockResolvedValueOnce({ success: true, ok: false, status: null, ms: 0, error, excerpt: null })
    const res = await handler('test_bot_webhook')({ botId: BOT, destinationId: DEST, confirm: true })
    expect(res.isError).toBe(true)
    const { error: e } = jsonOf(res)
    expect(e.code).toBe('WEBHOOK_TEST_NOT_SENT')
    expect(e.sent).toBe(false)
    expect(e.message).toContain(error)
    expect(textOf(res)).not.toContain('A real request was sent')
  })

  it('a non-2xx answer still counts as sent (the URL answered)', async () => {
    mockApi.mockResolvedValueOnce({ success: true, ok: false, status: 401, ms: 80, error: 'HTTP 401', excerpt: 'bad token' })
    const out = jsonOf(await handler('test_bot_webhook')({ botId: BOT, destinationId: DEST, confirm: true }))
    expect(out).toMatchObject({ sent: true, ok: false, httpStatus: 401 })
  })

  it('masks Bearer values the receiver echoed back', async () => {
    mockApi.mockResolvedValueOnce({ success: true, ok: false, status: 400, ms: 80, error: 'HTTP 400', excerpt: 'got Authorization: Bearer abcdef123456789 sorry' })
    const res = await handler('test_bot_webhook')({ botId: BOT, destinationId: DEST, confirm: true })
    expect(textOf(res)).not.toContain('abcdef123456789')
  })
})

describe('secret scrubbing', () => {
  it('scrubs a value that straddles the 300-character cut', async () => {
    const secret = 'ZZSECRETVALUEZZ'
    const message = `${'x'.repeat(295)}${secret} tail`
    mockApi.mockRejectedValueOnce(refusal(400, message, 'x'))
    const res = await handler('add_bot_webhook')({ botId: BOT, name: 'x', url: 'https://example.com/h', headers: [{ name: 'X-Key', value: secret }] })
    expect(textOf(res)).not.toContain('SECRET')
    expect(textOf(res)).not.toContain('ZZSECRETV')
  })

  it('scrubs a short value only as a whole token', async () => {
    mockApi.mockRejectedValueOnce(refusal(400, 'bad value 42 for header, count 142', 'x'))
    const res = await handler('add_bot_webhook')({ botId: BOT, name: 'x', url: 'https://example.com/h', headers: [{ name: 'X-Key', value: '42' }] })
    const msg = jsonOf(res).error.message
    expect(msg).toContain('bad value [hidden] for header')
    expect(msg).toContain('142')
  })
})

describe('error contract', () => {
  it.each([['busy', 409], ['unavailable', 503]])('%s means nothing was saved (not WEBHOOK_OUTCOME_UNKNOWN) and is safe to retry', async (code, status) => {
    mockApi.mockRejectedValueOnce(refusal(status as number, 'Another change is in progress.', code as string))
    const res = await handler('add_bot_webhook')({ botId: BOT, name: 'x', url: 'https://example.com/h' })
    const { error } = jsonOf(res)
    expect(error.code).toBe(code)
    expect(error.retryable).toBe(true)
    expect(error.message).toContain('Nothing was saved')
  })

  it('a webhook refused as "unavailable" in deploy_bot is not reported as maybe-created', async () => {
    mockApi.mockResolvedValueOnce({ docs: [PAPER_EXCHANGE] }).mockResolvedValueOnce({ doc: { id: 'new-bot', status: 'paused' } })
      .mockRejectedValueOnce(refusal(503, 'Could not save right now.', 'unavailable'))
    const res = await handler('deploy_bot')({ ...DEPLOY, webhooks: [{ name: 'a', url: 'https://example.com/h' }] })
    expect(jsonOf(res).error.message).not.toContain('may already exist')
  })

  it('update_bot_webhook refuses a shortened URL before calling the API', async () => {
    const res = await handler('update_bot_webhook')({ botId: BOT, destinationId: DEST, url: 'https://example.com/…' })
    expect(jsonOf(res).error.code).toBe('INVALID_WEBHOOK')
    expect(mockApi).not.toHaveBeenCalled()
  })

  it('the description says a read-only login cannot preview', () => {
    expect(descriptionOf('preview_bot_webhook')).toContain('read-only login cannot preview')
  })
})

describe('client-side checks run before any bot exists', () => {
  const base = { ...DEPLOY }
  it.each([
    ['an unknown template variable', { name: 'a', url: 'https://example.com/h', bodyTemplate: '{"a":"{{nope}}"}' }, 'unknown variable'],
    ['a const the constants do not define', { name: 'a', url: 'https://example.com/h', bodyTemplate: '{"a":"{{const.TOK}}"}', constants: { OTHER: '1' } }, '"TOK"'],
    ['a blocked header name', { name: 'a', url: 'https://example.com/h', headers: [{ name: 'Content-Type', value: 'x' }] }, 'set by TradeStaq'],
    ['an internal host', { name: 'a', url: 'https://localhost/h' }, 'public host'],
    ['a port other than 443', { name: 'a', url: 'https://example.com:8443/h' }, '443'],
  ])('deploy_bot refuses %s and creates nothing', async (_l, hook, text) => {
    const res = await handler('deploy_bot')({ ...base, webhooks: [hook] })
    expect(res.isError).toBe(true)
    expect(jsonOf(res).error.code).toBe('INVALID_WEBHOOK')
    expect(jsonOf(res).error.message).toContain(text)
    expect(mockApi).not.toHaveBeenCalled()
  })

  it('update_bot refuses a bad webhook before reading or writing anything', async () => {
    const res = await handler('update_bot')({ id: BOT, leverage: 2, webhooks: [{ name: 'a', url: 'https://example.com/h', bodyTemplate: '{{bad}}' }] })
    expect(jsonOf(res).error.code).toBe('INVALID_WEBHOOK')
    expect(mockApi).not.toHaveBeenCalled()
  })

  it('accepts a valid template with a defined const', async () => {
    mockApi.mockResolvedValueOnce({ success: true, destination: serverDest() })
    const res = await handler('add_bot_webhook')({ botId: BOT, name: 'a', url: 'https://example.com/h', bodyTemplate: '{"t":"{{const.TOK}}","p":{{price}}}', constants: { TOK: 'x' } })
    expect(res.isError).toBeUndefined()
  })
})

describe('deploy_bot webhook flow edge cases', () => {
  const HOOK = { name: 'OKX signal', url: 'https://example.com/hook', headers: [{ name: 'Authorization', value: SECRET }] }

  it('a bot the server created RUNNING is paused before the webhooks are added', async () => {
    mockApi
      .mockResolvedValueOnce({ docs: [PAPER_EXCHANGE] })
      .mockResolvedValueOnce({ doc: { id: 'new-bot', status: 'active' } })
      .mockResolvedValueOnce({ status: 'paused' }) // pause
      .mockResolvedValueOnce({ success: true, destination: serverDest() })
      .mockResolvedValueOnce({ status: 'active' }) // start
    await handler('deploy_bot')({ ...DEPLOY, webhooks: [HOOK] })
    expect(mockApi.mock.calls.map((c) => `${c[1]?.method ?? 'GET'} ${c[0]}`)).toEqual([
      'GET /api/exchanges', 'POST /api/bots', 'PATCH /api/bots/new-bot/status', 'POST /api/bots/new-bot/webhooks', 'PATCH /api/bots/new-bot/status',
    ])
    expect(mockApi.mock.calls[2][1]).toEqual({ method: 'PATCH', retry: false, body: { status: 'paused' } })
  })

  it('if a RUNNING bot cannot be paused it says so and adds nothing', async () => {
    mockApi
      .mockResolvedValueOnce({ docs: [PAPER_EXCHANGE] })
      .mockResolvedValueOnce({ doc: { id: 'new-bot', status: 'active' } })
      .mockRejectedValueOnce(new ApiError(500, 'HTTP_500', 'boom', false))
    const res = await handler('deploy_bot')({ ...DEPLOY, webhooks: [HOOK] })
    const { error } = jsonOf(res)
    expect(error.code).toBe('BOT_RUNNING_WITHOUT_WEBHOOKS')
    expect(error.message).toContain('RUNNING')
    expect(error.message).toContain('stop_bot')
    expect(mockApi).toHaveBeenCalledTimes(3)
  })

  it('a webhook failure is not retryable and starts with "Do NOT call deploy_bot again"', async () => {
    mockApi.mockResolvedValueOnce({ docs: [PAPER_EXCHANGE] }).mockResolvedValueOnce({ doc: { id: 'new-bot', status: 'paused' } })
      .mockRejectedValueOnce(refusal(403, 'Your current plan does not include outgoing webhooks.', 'plan_required'))
    const { error } = jsonOf(await handler('deploy_bot')({ ...DEPLOY, webhooks: [HOOK] }))
    expect(error.retryable).toBe(false)
    expect(error.message.startsWith('Do NOT call deploy_bot again')).toBe(true)
    expect(error.message).toContain('status is PAUSED')
  })

  it('a webhook failure with start: false says it was not started as asked', async () => {
    mockApi.mockResolvedValueOnce({ docs: [PAPER_EXCHANGE] }).mockResolvedValueOnce({ doc: { id: 'new-bot', status: 'paused' } })
      .mockRejectedValueOnce(refusal(409, 'A bot can have at most 5 webhook destinations.', 'limit_per_bot'))
    const res = await handler('deploy_bot')({ ...DEPLOY, start: false, webhooks: [HOOK] })
    expect(jsonOf(res).error.message).toContain('as you asked')
    expect(mockApi).toHaveBeenCalledTimes(3)
  })

  it('DEPLOY_OUTCOME_UNKNOWN with webhooks says the bot has no webhook yet', async () => {
    mockApi.mockResolvedValueOnce({ docs: [PAPER_EXCHANGE] }).mockRejectedValueOnce(new ApiError(408, 'TIMEOUT', 'Request timed out', false))
    const { error } = jsonOf(await handler('deploy_bot')({ ...DEPLOY, webhooks: [HOOK] }))
    expect(error.code).toBe('DEPLOY_OUTCOME_UNKNOWN')
    expect(error.message).toContain('has no webhook yet')
    expect(error.message).toContain('add_bot_webhook')
    expect(mockApi).toHaveBeenCalledTimes(2)
  })

  it('PRESET_UNSUPPORTED with webhooks says the webhooks were NOT added, and the bot is not started', async () => {
    mockApi.mockResolvedValueOnce({ docs: [PAPER_EXCHANGE] }).mockResolvedValueOnce({ doc: { id: 'new-bot', status: 'paused' } })
    const res = await handler('deploy_bot')({ ...DEPLOY, presetId: 'p', webhooks: [HOOK] })
    const { error } = jsonOf(res)
    expect(error.code).toBe('PRESET_UNSUPPORTED')
    expect(error.message).toContain('webhooks were NOT added')
    expect(mockApi).toHaveBeenCalledTimes(2)
  })

  it('a start the server refuses after the webhooks went in leaves the bot paused and says so', async () => {
    mockApi
      .mockResolvedValueOnce({ docs: [PAPER_EXCHANGE] })
      .mockResolvedValueOnce({ doc: { id: 'new-bot', status: 'paused' } })
      .mockResolvedValueOnce({ success: true, destination: serverDest() })
      .mockRejectedValueOnce(new ApiError(409, 'HTTP_409', 'Another bot already trades that coin', false))
    const res = await handler('deploy_bot')({ ...DEPLOY, webhooks: [HOOK] })
    const text = textOf(res)
    expect(text).toContain('NOT started')
    expect(text).toContain('Another bot already trades that coin')
    expect(text).toContain('Webhooks: 1 destination added')
  })
})

describe('update_bot with webhooks: edge cases', () => {
  it('PRESET_UNSUPPORTED says the webhooks were NOT added', async () => {
    mockApi
      .mockResolvedValueOnce({ id: BOT, triggerType: 'strategy', strategy: STRATEGY })
      .mockResolvedValueOnce({ success: true }) // PATCH without appliedPreset
    const res = await handler('update_bot')({ id: BOT, presetId: 'p', webhooks: [{ name: 'a', url: 'https://example.com/h' }] })
    const { error } = jsonOf(res)
    expect(error.code).toBe('PRESET_UNSUPPORTED')
    expect(error.message).toContain('webhooks were NOT added')
    expect(mockApi.mock.calls.some((c) => String(c[0]).endsWith('/webhooks'))).toBe(false)
  })

  it('the failure result carries the PATCH warnings', async () => {
    mockApi
      .mockResolvedValueOnce({ id: BOT, positionSizing: { type: 'percentage', value: 10, leverage: 1 } })
      .mockResolvedValueOnce({ success: true, warnings: ['Not enough candle history'] })
      .mockRejectedValueOnce(refusal(403, 'Your current plan does not include outgoing webhooks.', 'plan_required'))
    const { error } = jsonOf(await handler('update_bot')({ id: BOT, leverage: 3, webhooks: [{ name: 'a', url: 'https://example.com/h' }] }))
    expect(error.warnings).toEqual(['Not enough candle history'])
    expect(error.retryable).toBe(false)
    expect(error.message.startsWith('Do NOT repeat')).toBe(true)
  })
})

// --- through a real MCP client: the zod schemas and annotations actually run ----------

describe('through an MCP client', () => {
  async function client() {
    const { McpServer: S } = await import('@modelcontextprotocol/sdk/server/mcp.js')
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
    const server = new S({ name: 't', version: '1' }, { capabilities: { logging: {} } })
    registerWebhookTools(server)
    registerBotTools(server)
    const [a, b] = InMemoryTransport.createLinkedPair()
    const c = new Client({ name: 'c', version: '1' })
    await Promise.all([server.connect(a), c.connect(b)])
    return c
  }
  const call = async (c: any, name: string, args: Record<string, unknown>) => {
    const r: any = await c.callTool({ name, arguments: args })
    return { isError: !!r.isError, text: r.content[0].text as string }
  }

  it('rejects an http URL, a bad header name, a non-ASCII header value and too many constants or webhooks, and calls nothing', async () => {
    const c = await client()
    const ok = { botId: BOT, name: 'a', url: 'https://example.com/h' }
    const bad: Array<[string, Record<string, unknown>]> = [
      ['add_bot_webhook', { ...ok, url: 'http://example.com/h' }],
      ['add_bot_webhook', { ...ok, headers: [{ name: 'Bad Name', value: 'x' }] }],
      ['add_bot_webhook', { ...ok, headers: [{ name: 'X-Key', value: 'café' }] }],
      ['add_bot_webhook', { ...ok, headers: [{ name: 'X-Key', value: 'line\nbreak' }] }],
      ['add_bot_webhook', { ...ok, constants: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`C${i}`, 'v'])) }],
      ['add_bot_webhook', { ...ok, constants: { 'bad-name': 'v' } }],
      ['deploy_bot', { ...DEPLOY, webhooks: Array.from({ length: 6 }, (_, i) => ({ name: `w${i}`, url: 'https://example.com/h' })) }],
      ['test_bot_webhook', { botId: BOT, destinationId: DEST }],
    ]
    for (const [name, args] of bad) {
      const r = await call(c, name, args)
      expect(r.isError, `${name} ${JSON.stringify(args).slice(0, 60)}`).toBe(true)
      expect(r.text).toContain('Input validation error')
    }
    expect(mockApi).not.toHaveBeenCalled()
  })

  it('accepts a valid add and sends it', async () => {
    mockApi.mockResolvedValueOnce({ success: true, destination: serverDest() })
    const c = await client()
    const r = await call(c, 'add_bot_webhook', { botId: BOT, name: 'a', url: 'https://example.com/h', headers: [{ name: 'Authorization', value: SECRET }] })
    expect(r.isError).toBe(false)
    expect(r.text).not.toContain('SUPERSECRET')
  })

  it('publishes the annotations the descriptions promise', async () => {
    const c = await client()
    const { tools } = await c.listTools()
    const ann = (n: string) => tools.find((t) => t.name === n)!.annotations as any
    expect(ann('delete_bot_webhook').destructiveHint).toBe(true)
    expect(ann('update_bot').idempotentHint).toBe(false)
    expect(ann('list_bot_webhooks').readOnlyHint).toBe(true)
    expect(ann('preview_bot_webhook').readOnlyHint).toBe(true)
    expect(ann('test_bot_webhook').readOnlyHint).toBe(false)
    const confirm = (tools.find((t) => t.name === 'test_bot_webhook')!.inputSchema as any)
    expect(confirm.required).toContain('confirm')
  })
})

// --- secrets, copy bots, delivery notes ------------------------------------------

describe('secrets (write-only body values)', () => {
  const TOKEN = 'OKXTOKEN-very-secret-9876'

  it('add_bot_webhook sends secrets once and never echoes a value; the view shows name and hint only', async () => {
    mockApi.mockResolvedValueOnce({ success: true, destination: serverDest({ secrets: [{ name: 'OKX_TOKEN', valueHint: '••••9876', value: TOKEN }] }) })
    const input = { name: 'a', url: 'https://example.com/h', bodyTemplate: '{"t":"{{secret.OKX_TOKEN}}"}', secrets: [{ name: 'OKX_TOKEN', value: TOKEN }] }
    const res = await handler('add_bot_webhook')({ botId: BOT, ...input })
    expect(mockApi).toHaveBeenCalledWith(`/api/bots/${BOT}/webhooks`, { method: 'POST', retry: false, body: input })
    expect(jsonOf(res).destination.secrets).toEqual([{ name: 'OKX_TOKEN', valueHint: '••••9876' }])
    expect(textOf(res)).not.toContain(TOKEN)
  })

  it('a secret value is scrubbed from a server error', async () => {
    mockApi.mockRejectedValueOnce(refusal(400, `Bad secret ${TOKEN}`, 'x'))
    const res = await handler('add_bot_webhook')({ botId: BOT, name: 'a', url: 'https://example.com/h', secrets: [{ name: 'OKX_TOKEN', value: TOKEN }] })
    expect(textOf(res)).not.toContain(TOKEN)
  })

  it('update_bot_webhook: a secret without a value keeps its stored one (sent by name only)', async () => {
    mockApi.mockResolvedValueOnce({ success: true, destination: serverDest() })
    await handler('update_bot_webhook')({ botId: BOT, destinationId: DEST, secrets: [{ name: 'OKX_TOKEN' }, { name: 'OTHER', value: TOKEN }] })
    expect(mockApi.mock.calls[0][1].body).toEqual({ secrets: [{ name: 'OKX_TOKEN' }, { name: 'OTHER', value: TOKEN }] })
  })

  it('deploy_bot refuses {{secret.X}} without that secret, and a duplicate secret, before creating a bot', async () => {
    for (const hook of [
      { name: 'a', url: 'https://example.com/h', bodyTemplate: '{"t":"{{secret.NOPE}}"}', secrets: [{ name: 'OTHER', value: 'v' }] },
      { name: 'a', url: 'https://example.com/h', secrets: [{ name: 'A', value: 'v' }, { name: 'A', value: 'w' }] },
    ]) {
      const res = await handler('deploy_bot')({ ...DEPLOY, webhooks: [hook] })
      expect(jsonOf(res).error.code).toBe('INVALID_WEBHOOK')
    }
    expect(mockApi).not.toHaveBeenCalled()
  })

  it('deploy_bot and update_bot pass secrets through to the webhook POST and keep them out of results', async () => {
    const hook = { name: 'a', url: 'https://example.com/h', bodyTemplate: '{"t":"{{secret.OKX_TOKEN}}"}', secrets: [{ name: 'OKX_TOKEN', value: TOKEN }] }
    mockApi.mockResolvedValueOnce({ docs: [PAPER_EXCHANGE] }).mockResolvedValueOnce({ doc: { id: 'new-bot', status: 'paused' } })
      .mockResolvedValueOnce({ success: true, destination: serverDest() }).mockResolvedValueOnce({ status: 'active' })
    const r1 = await handler('deploy_bot')({ ...DEPLOY, webhooks: [hook] })
    expect(mockApi.mock.calls[2][1].body).toEqual(hook)
    expect(textOf(r1)).not.toContain(TOKEN)
    mockApi.mockReset()
    mockApi.mockResolvedValueOnce({ success: true, destination: serverDest() })
    const r2 = await handler('update_bot')({ id: BOT, webhooks: [hook] })
    expect(mockApi.mock.calls[0][1].body).toEqual(hook)
    expect(textOf(r2)).not.toContain(TOKEN)
  })

  it('rejects bad secret names and values through the real schema', async () => {
    const { McpServer: S } = await import('@modelcontextprotocol/sdk/server/mcp.js')
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
    const server = new S({ name: 't', version: '1' }, { capabilities: { logging: {} } })
    registerWebhookTools(server)
    const [a, b] = InMemoryTransport.createLinkedPair()
    const c = new Client({ name: 'c', version: '1' })
    await Promise.all([server.connect(a), c.connect(b)])
    const ok = { botId: BOT, name: 'a', url: 'https://example.com/h' }
    for (const secrets of [
      [{ name: 'lower', value: 'v' }],
      [{ name: '1BAD', value: 'v' }],
      [{ name: 'OK', value: 'café' }],
      [{ name: 'OK', value: 'x'.repeat(501) }],
      Array.from({ length: 11 }, (_, i) => ({ name: `S${i}`, value: 'v' })),
    ]) {
      const r: any = await c.callTool({ name: 'add_bot_webhook', arguments: { ...ok, secrets } })
      expect(r.isError).toBe(true)
    }
    expect(mockApi).not.toHaveBeenCalled()
  })

  it('describes {{secret.NAME}}, price_known and keeps tokens out of constants', () => {
    const d = descriptionOf('add_bot_webhook')
    expect(d).toContain('{{secret.NAME}}')
    expect(d).toContain('{{price_known}}')
    expect(d).toContain('NEVER in constants')
  })
})

describe('server refusals and delivery notes', () => {
  it('headers_reenter_required is explained: re-send every header and secret', async () => {
    mockApi.mockRejectedValueOnce(refusal(400, 'You changed the URL host, so the saved header values cannot be reused.', 'headers_reenter_required'))
    const res = await handler('update_bot_webhook')({ botId: BOT, destinationId: DEST, url: 'https://other.example.com/h' })
    const { error } = jsonOf(res)
    expect(error.code).toBe('headers_reenter_required')
    expect(error.message).toContain('EVERY header and EVERY secret')
    expect(descriptionOf('update_bot_webhook')).toContain('header AND secret')
  })

  it('not_available_for_copy_bots is explained, in add_bot_webhook and in deploy_bot', async () => {
    mockApi.mockRejectedValueOnce(refusal(403, 'Copy-follower bots cannot send webhooks.', 'not_available_for_copy_bots'))
    const res = await handler('add_bot_webhook')({ botId: BOT, name: 'a', url: 'https://example.com/h' })
    expect(jsonOf(res).error.code).toBe('not_available_for_copy_bots')
    expect(jsonOf(res).error.message).toContain('copy-follower')

    mockApi.mockReset()
    mockApi.mockResolvedValueOnce({ docs: [PAPER_EXCHANGE] }).mockResolvedValueOnce({ doc: { id: 'new-bot', status: 'paused' } })
      .mockRejectedValueOnce(refusal(403, 'Copy-follower bots cannot send webhooks.', 'not_available_for_copy_bots'))
    const dep = await handler('deploy_bot')({ ...DEPLOY, webhooks: [{ name: 'a', url: 'https://example.com/h' }] })
    expect(jsonOf(dep).error.message).toContain('Copy-follower bots cannot send webhooks')
    expect(jsonOf(dep).error.code).toBe('WEBHOOK_SETUP_FAILED')
  })

  it('add and test descriptions state at-least-once delivery, event_id dedupe, orphan exits and the 5 minute drop', () => {
    for (const name of ['add_bot_webhook', 'test_bot_webhook']) {
      const d = descriptionOf(name)
      expect(d).toContain('at least once')
      expect(d).toContain('X-TradeStaq-Event-Id')
      expect(d).toContain('position the receiver does not hold')
      expect(d).toContain('older than 5 minutes')
    }
    expect(descriptionOf('add_bot_webhook')).toContain('not_available_for_copy_bots')
  })
})
