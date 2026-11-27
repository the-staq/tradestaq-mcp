import { describe, it, expect } from 'vitest'
import { isBlockedAddress, isOwnHost, templateProblem, urlProblem } from '../src/tools/webhook-rules.js'
import { webhookProblem, webhooksProblem } from '../src/tools/webhooks.js'

// The server's save-time rules (mfanya-client src/lib/outgoing-webhooks, v0.30.0.0), copied so
// deploy_bot can refuse a webhook before it creates a bot.

describe('urlProblem: the server\'s validateWebhookUrlSyntax', () => {
  it.each([
    ['http://example.com/h', 'https://'],
    ['ftp://example.com/h', 'https://'],
    ['https://user:pw@example.com/h', 'username or password'],
    ['https://user@example.com/h', 'username or password'],
    ['https://example.com:8443/h', '443'],
    ['https://tradestaq.com/h', 'TradeStaq'],
    ['https://www.tradestaq.com/api/webhooks/trade/x', 'TradeStaq'],
    ['https://MCP.TradeStaq.com./h', 'TradeStaq'],
    ['https://mfanya.com/h', 'TradeStaq'],
    ['https://app.mfanya.com/h', 'TradeStaq'],
    ['https://10.0.0.1/h', 'not allowed'],
    ['https://10.1/h', 'not allowed'],
    ['https://127.0.0.1/h', 'not allowed'],
    ['https://2130706433/h', 'not allowed'],
    ['https://0x7f.1/h', 'not allowed'],
    ['https://0177.0.0.1/h', 'not allowed'],
    ['https://169.254.169.254/latest/meta-data', 'not allowed'],
    ['https://172.16.5.4/h', 'not allowed'],
    ['https://192.168.1.1/h', 'not allowed'],
    ['https://100.64.0.1/h', 'not allowed'],
    ['https://0.0.0.0/h', 'not allowed'],
    ['https://224.0.0.1/h', 'not allowed'],
    ['https://255.255.255.255/h', 'not allowed'],
    ['https://198.18.0.1/h', 'not allowed'],
    ['https://[::1]/h', 'not allowed'],
    ['https://[::]/h', 'not allowed'],
    ['https://[::ffff:10.0.0.1]/h', 'not allowed'],
    ['https://[::ffff:127.0.0.1]/h', 'not allowed'],
    ['https://[::ffff:0:a00:1]/h', 'not allowed'],
    ['https://[64:ff9b::a00:1]/h', 'not allowed'],
    ['https://[64:ff9b:1::1]/h', 'not allowed'],
    ['https://[2002:a00:1::]/h', 'not allowed'],
    ['https://[fc00::1]/h', 'not allowed'],
    ['https://[fd12:3456::1]/h', 'not allowed'],
    ['https://[fe80::1]/h', 'not allowed'],
    ['https://[ff02::1]/h', 'not allowed'],
    ['https://[2001:db8::1]/h', 'not allowed'],
    ['https://[100::1]/h', 'not allowed'],
    ['https://localhost/h', 'public host'],
    ['https://localhost./h', 'public host'],
    ['https://localhost../h', 'public host'],
    ['https://api.localhost/h', 'public host'],
    ['https://intranet/h', 'public host'],
    ['https://' + 'a'.repeat(250) + '.com/h', 'longer than 253'],
    ['not a url', 'not a valid URL'],
  ])('refuses %s', (url, why) => {
    expect(urlProblem(url)).toContain(why)
  })

  it.each([
    'https://example.com/h',
    'https://example.com:443/h',
    'https://www.okx.com/algo/signal/trigger',
    'https://8.8.8.8/h',
    'https://[2606:4700:4700::1111]/h',
    'https://[::ffff:8.8.8.8]/h',
    'https://nottradestaq.com/h',
    'https://tradestaq.com.example.org/h',
    'https://exämple.com/h',
  ])('accepts %s', (url) => {
    expect(urlProblem(url)).toBeUndefined()
  })

  it('isOwnHost and isBlockedAddress follow the server', () => {
    expect(isOwnHost('x.y.tradestaq.com')).toBe(true)
    expect(isOwnHost('tradestaq.co')).toBe(false)
    expect(isBlockedAddress('not-an-ip')).toBe(true)
    expect(isBlockedAddress('1.1.1.1')).toBe(false)
    expect(isBlockedAddress('203.0.113.9')).toBe(true)
  })
})

describe('templateProblem: the server\'s validateTemplate', () => {
  it.each([
    ['trailing comma', '{"side":"{{side}}",}'],
    ['single quotes', "{'side':'{{side}}'}"],
    ['missing brace', '{"side":"{{side}}"'],
    ['unquoted key', '{side: "{{side}}"}'],
    ['text after the object', '{"a":1} x'],
  ])('refuses a template that is not JSON once filled in (%s)', (_l, t) => {
    expect(templateProblem(t, [], [])).toContain('not valid JSON')
  })

  it('refuses a body over 16 KB with every constant and secret at its 500-character maximum', () => {
    const t = '[' + Array.from({ length: 40 }, () => '"{{const.A}}"').join(',') + ']'
    expect(templateProblem(t, ['A'], [])).toContain('16 KB')
    // the same with 20 references fits (about 10 KB)
    expect(templateProblem('[' + Array.from({ length: 20 }, () => '"{{const.A}}"').join(',') + ']', ['A'], [])).toBeUndefined()
    // secrets count at 500 characters too
    expect(templateProblem('[' + Array.from({ length: 40 }, () => '"{{secret.S}}"').join(',') + ']', [], ['S'])).toContain('16 KB')
  })

  it.each([
    ['{"a":"{{nope}}"}', 'unknown variable'],
    ['{"a":"{{const.B}}"}', 'constants has no "B"'],
    ['{"a":"{{secret.B}}"}', 'secrets has no "B"'],
    ['{"a":"{{secret.lower}}"}', 'UPPER_CASE'],
    ['{"a":"{{side}"}', 'never closed'],
    ['{"a":"{{ }}"}', 'empty placeholder'],
  ])('refuses %s', (t, why) => {
    expect(templateProblem(t, ['A'], ['S'])).toContain(why)
  })

  it('accepts valid templates, an empty one, and unknown constant/secret lists when not given', () => {
    expect(templateProblem('', [], [])).toBeUndefined()
    expect(templateProblem('   ', [], [])).toBeUndefined()
    expect(templateProblem('{"side":"{{side}}","px":{{price}},"pnl":{{pnl}},"t":"{{const.A}}","k":"{{secret.S}}","paper":{{is_paper}},"txt":{{bot_name}}}', ['A'], ['S'])).toBeUndefined()
    expect(templateProblem('{"t":"{{const.ANY}}","k":"{{secret.ANY}}"}', undefined, undefined)).toBeUndefined()
    // a quote inside a constant is escaped, as the server renders it
    expect(templateProblem('{"q":"\\"{{const.A}}\\""}', ['A'], [])).toBeUndefined()
  })
})

describe('webhookProblem: headers, secrets and the create/update difference', () => {
  const base = { name: 'a', url: 'https://example.com/h' }

  it.each([
    ['X-TradeStaq-Event-Id'],
    ['x-tradestaq-anything'],
    ['Content-Type'],
    ['USER-AGENT'],
    ['host'],
  ])('refuses the reserved header %s', (name) => {
    expect(webhookProblem({ ...base, headers: [{ name, value: 'v' }] })).toContain('set by TradeStaq')
  })

  it('refuses a header or secret value shaped like stored ciphertext, and a header listed twice in any case', () => {
    const cipher = `${'a'.repeat(30)}:${'b'.repeat(20)}:${'c'.repeat(20)}`
    expect(webhookProblem({ ...base, headers: [{ name: 'X-Key', value: cipher }] })).toContain('not accepted')
    expect(webhookProblem({ ...base, secrets: [{ name: 'TOK', value: cipher }] })).toContain('not accepted')
    // two colons but 60 characters or fewer is a normal value
    expect(webhookProblem({ ...base, headers: [{ name: 'X-Key', value: 'a:b:c' }] })).toBeUndefined()
    expect(webhookProblem({ ...base, headers: [{ name: 'X-Key', value: '1' }, { name: 'x-key', value: '2' }] })).toContain('twice')
  })

  it('the https check runs in the client function itself, not only in the zod schema', () => {
    expect(webhookProblem({ ...base, url: 'http://example.com/h' })).toContain('https://')
  })

  it('a NEW destination without constants or secrets has none: a reference to one is refused', () => {
    const hook = { ...base, bodyTemplate: '{"t":"{{const.TOK}}","k":"{{secret.KEY}}"}' }
    expect(webhooksProblem([hook])).toContain('constants has no "TOK"')
    expect(webhooksProblem([{ ...hook, constants: { TOK: 'x' } }])).toContain('secrets has no "KEY"')
    expect(webhooksProblem([{ ...hook, constants: { TOK: 'x' }, secrets: [{ name: 'KEY', value: 'v' }] }])).toBeUndefined()
    // an update that leaves constants and secrets alone cannot check them
    expect(webhookProblem({ bodyTemplate: hook.bodyTemplate })).toBeUndefined()
    // but still checks JSON
    expect(webhookProblem({ bodyTemplate: '{"t":"{{const.TOK}}",}' })).toContain('not valid JSON')
  })
})
