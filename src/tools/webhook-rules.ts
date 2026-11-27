import net from 'node:net'

// The rules TradeStaq applies when it saves an outgoing webhook destination, copied from the
// server (mfanya-client src/lib/outgoing-webhooks/ssrf-guard.ts, template.ts and headers.ts,
// as live in v0.30.0.0). deploy_bot runs them BEFORE it creates a bot, so a destination the
// server would refuse never leaves a new paused bot behind. The server stays the authority:
// these copies only refuse earlier, and a rule added on the server later is still enforced
// there (after the bot exists).

// --- URL: validateWebhookUrlSyntax -------------------------------------------------

export const MAX_HOST_LENGTH = 253

type V4Range = [number, number]

function v4(a: number, b: number, c: number, d: number): number {
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0
}

const BLOCKED_V4: V4Range[] = [
  [v4(0, 0, 0, 0), 8], // "this" network
  [v4(10, 0, 0, 0), 8], // private
  [v4(100, 64, 0, 0), 10], // CGNAT
  [v4(127, 0, 0, 0), 8], // loopback
  [v4(169, 254, 0, 0), 16], // link-local, cloud metadata
  [v4(172, 16, 0, 0), 12], // private
  [v4(192, 0, 0, 0), 24], // IETF protocol assignments
  [v4(192, 0, 2, 0), 24], // TEST-NET-1
  [v4(192, 88, 99, 0), 24], // 6to4 relay anycast
  [v4(192, 168, 0, 0), 16], // private
  [v4(192, 31, 196, 0), 24], // AS112-v4
  [v4(192, 52, 193, 0), 24], // AMT
  [v4(192, 175, 48, 0), 24], // direct delegation AS112
  [v4(198, 18, 0, 0), 15], // benchmarking
  [v4(198, 51, 100, 0), 24], // TEST-NET-2
  [v4(203, 0, 113, 0), 24], // TEST-NET-3
  [v4(224, 0, 0, 0), 4], // multicast
  [v4(240, 0, 0, 0), 4], // reserved, incl. 255.255.255.255
]

function parseV4(address: string): number | null {
  const parts = address.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null
    const n = Number(p)
    if (n > 255) return null
    value = (value << 8) | n
  }
  return value >>> 0
}

function v4Blocked(value: number): boolean {
  for (const [network, prefix] of BLOCKED_V4) {
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
    if (((value & mask) >>> 0) === ((network & mask) >>> 0)) return true
  }
  return false
}

/** An IPv6 address as 8 16-bit groups, or null when it is not valid IPv6. */
function parseV6(address: string): number[] | null {
  let a = address.replace(/%.*$/, '')
  if (!net.isIPv6(a)) return null
  // A dotted IPv4 tail ("::ffff:10.0.0.1") becomes two hex groups.
  const lastColon = a.lastIndexOf(':')
  const tail = a.slice(lastColon + 1)
  if (tail.includes('.')) {
    const value = parseV4(tail)
    if (value === null) return null
    a = `${a.slice(0, lastColon + 1)}${(value >>> 16).toString(16)}:${(value & 0xffff).toString(16)}`
  }
  const halves = a.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - head.length - rest.length
  if (halves.length === 1 ? head.length !== 8 : missing < 0) return null
  const groups = halves.length === 1 ? head : [...head, ...Array(missing).fill('0'), ...rest]
  const out = groups.map((g) => parseInt(g, 16))
  if (out.length !== 8 || out.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff)) return null
  return out
}

function v6Blocked(g: number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g
  const embedded = ((g6 << 16) | g7) >>> 0
  // :: (unspecified) and ::1 (loopback)
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) return true
  // ::ffff:a.b.c.d (IPv4-mapped) and ::a.b.c.d (IPv4-compatible): the IPv4 address decides
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) return v4Blocked(embedded)
  // ::ffff:0:a.b.c.d (IPv4-translated)
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) return v4Blocked(embedded)
  // 64:ff9b::/96 (NAT64): the embedded IPv4 decides; 64:ff9b:1::/48 is local-use
  if (g0 === 0x64 && g1 === 0xff9b) return g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 ? v4Blocked(embedded) : true
  // 100::/64 discard-only
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return true
  // 2001::/23 (IETF protocol assignments, Teredo) and 2001:db8::/32 (documentation)
  if (g0 === 0x2001 && (g1 < 0x200 || g1 === 0xdb8)) return true
  // 2002::/16 (6to4): the embedded IPv4 decides
  if (g0 === 0x2002) return v4Blocked(((g1 << 16) | g2) >>> 0)
  // fc00::/7 unique local
  if ((g0 & 0xfe00) === 0xfc00) return true
  // fe80::/10 link-local and fec0::/10 site-local
  if ((g0 & 0xffc0) === 0xfe80 || (g0 & 0xffc0) === 0xfec0) return true
  // ff00::/8 multicast
  if ((g0 & 0xff00) === 0xff00) return true
  return false
}

/** True for an address (IPv4 or IPv6 text) TradeStaq never connects to. An unparseable address is blocked. */
export function isBlockedAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, '')
  if (net.isIPv4(bare)) {
    const value = parseV4(bare)
    return value === null || v4Blocked(value)
  }
  const groups = parseV6(bare)
  if (!groups) return true
  return v6Blocked(groups)
}

/** TradeStaq's own domains: a webhook may not point back at them (a loop between bots). */
export const OWN_DOMAINS = ['tradestaq.com', 'mfanya.com']

export function isOwnHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').replace(/\.+$/, '').toLowerCase()
  return OWN_DOMAINS.some((own) => h === own || h.endsWith(`.${own}`))
}

/** The first reason the server refuses this URL, or undefined. No DNS: the server also refuses, at send time, a host that RESOLVES to a private address. */
export function urlProblem(url: string): string | undefined {
  let u: URL
  try { u = new URL(url.trim()) } catch { return 'the URL is not a valid URL' }
  if (u.protocol !== 'https:') return 'the URL must start with https://'
  if (u.username || u.password) return 'the URL must not contain a username or password: use a header'
  if (u.port && u.port !== '443') return 'only port 443 is allowed'
  const host = u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  if (!host) return 'the URL has no host'
  if (host.length > MAX_HOST_LENGTH) return `the host is longer than ${MAX_HOST_LENGTH} characters`
  if (isOwnHost(host)) return 'a webhook cannot point back at TradeStaq (tradestaq.com, mfanya.com or their subdomains)'
  if (net.isIP(host)) {
    return isBlockedAddress(host) ? 'that address is not allowed (private, loopback, link-local or reserved)' : undefined
  }
  // Stricter than the server on one point: every trailing dot goes ("localhost.." is still localhost).
  const name = host.replace(/\.+$/, '')
  if (name === 'localhost' || name.endsWith('.localhost') || !name.includes('.')) return 'use a public host name'
  return undefined
}

// --- headers and secrets: validateHeaders / validateSecrets ---------------------------

/** Set by TradeStaq itself on every request. */
export const BLOCKED_HEADER_NAMES = ['host', 'content-length', 'connection', 'transfer-encoding', 'content-type', 'user-agent']
/** Every header starting with this is TradeStaq's (X-TradeStaq-Event-Id, X-TradeStaq-Delivery-Attempt). */
export const RESERVED_HEADER_PREFIX = 'x-tradestaq-'

export function isBlockedHeaderName(name: string): boolean {
  const lower = name.toLowerCase()
  return BLOCKED_HEADER_NAMES.includes(lower) || lower.startsWith(RESERVED_HEADER_PREFIX)
}

/** The server refuses a value shaped like its own stored ciphertext (it would be stored in clear). */
export function looksEncrypted(text: string): boolean {
  return text.split(':').length === 3 && text.length > 60
}

// --- body template: validateTemplate -------------------------------------------------

export const TEMPLATE_VARIABLES = [
  'action', 'side', 'symbol', 'base', 'quote', 'instrument_id', 'price', 'size',
  'notional_usd', 'stop', 'take_profit', 'pnl', 'reason', 'bot_name', 'strategy',
  'bot_id', 'event_id', 'timestamp', 'timestamp_ms', 'is_paper', 'source', 'price_known',
] as const

export const MAX_RENDERED_BODY_BYTES = 16 * 1024
/** The server renders every constant and secret at the longest value it accepts for its size check. */
const WORST_CASE_VALUE_LENGTH = 500

const VARIABLE_SET = new Set<string>(TEMPLATE_VARIABLES)
const CONST_REF = /^const\.([A-Za-z_][A-Za-z0-9_]{0,39})$/
const SECRET_REF = /^secret\.([A-Z][A-Z0-9_]{0,39})$/

type Scalar = string | number | boolean | null

/** The server's sample event (a BTC long entry), as template values. */
function sampleValues(): Record<string, Scalar> {
  const at = new Date()
  return {
    action: 'enter_long', side: 'long', symbol: 'BTC/USDT:USDT', base: 'BTC', quote: 'USDT',
    instrument_id: 'BTC-USDT-SWAP', price: 67250.5, size: 0.01, notional_usd: 672.51, stop: 65900,
    take_profit: 70000, pnl: null, reason: 'signal', bot_name: 'StormRider BTC', strategy: 'StormRider',
    bot_id: '665f1b7a9b1d4a0012ab1234', event_id: 'open:665f1c2e9b1d4a0012ab34cd',
    timestamp: at.toISOString(), timestamp_ms: at.getTime(), is_paper: false, source: 'strategy', price_known: true,
  }
}

interface Token { text: string | null, name?: string, inString: boolean }

/** Literal text and placeholders, tracking whether each placeholder sits inside a JSON string. */
function tokenize(template: string): { ok: true, tokens: Token[] } | { ok: false, error: string } {
  const tokens: Token[] = []
  let literal = ''
  let inString = false
  let i = 0
  while (i < template.length) {
    if (template.startsWith('{{', i)) {
      const end = template.indexOf('}}', i + 2)
      if (end === -1) return { ok: false, error: 'a {{ in the template is never closed with }}' }
      if (literal) tokens.push({ text: literal, inString })
      literal = ''
      const name = template.slice(i + 2, end).trim()
      if (!name) return { ok: false, error: 'the template has an empty placeholder {{ }}' }
      tokens.push({ text: null, name, inString })
      i = end + 2
      continue
    }
    const ch = template[i]
    literal += ch
    if (inString && ch === '\\') {
      if (i + 1 < template.length) literal += template[i + 1]
      i += 2
      continue
    }
    if (ch === '"') inString = !inString
    i++
  }
  if (literal) tokens.push({ text: literal, inString })
  return { ok: true, tokens }
}

function numberText(n: number): string {
  const s = String(n)
  return /e/i.test(s) ? n.toFixed(12).replace(/\.?0+$/, '') : s
}

function asText(v: Scalar): string {
  if (v === null) return ''
  return typeof v === 'number' ? numberText(v) : String(v)
}

function asJson(v: Scalar): string {
  if (v === null) return 'null'
  if (typeof v === 'number') return numberText(v)
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  return JSON.stringify(v)
}

/**
 * The first reason the server refuses this template, or undefined. `constantNames` /
 * `secretNames` undefined: not known (an update that leaves them alone), so a reference is
 * not checked against them but still rendered at the worst-case length.
 */
export function templateProblem(template: string, constantNames?: string[], secretNames?: string[]): string | undefined {
  if (!template || !template.trim()) return undefined
  const tokenized = tokenize(template)
  if (!tokenized.ok) return tokenized.error
  for (const t of tokenized.tokens) {
    if (t.text !== null) continue
    const name = t.name!
    if (VARIABLE_SET.has(name)) continue
    const sec = SECRET_REF.exec(name)
    if (sec) {
      if (secretNames !== undefined && !secretNames.includes(sec[1])) return `the template uses {{${name}}} but secrets has no "${sec[1]}"`
      continue
    }
    if (/^secret\./.test(name)) return `{{${name}}}: secret names are UPPER_CASE letters, digits and underscores, starting with a letter`
    const c = CONST_REF.exec(name)
    if (c) {
      if (constantNames !== undefined && !constantNames.includes(c[1])) return `the template uses {{${name}}} but constants has no "${c[1]}"`
      continue
    }
    return `the template uses an unknown variable {{${name}}}`
  }
  // Render as the server does: the sample event, every constant and secret at 500 characters.
  const values = sampleValues()
  const worst = 'x'.repeat(WORST_CASE_VALUE_LENGTH)
  let out = ''
  for (const t of tokenized.tokens) {
    if (t.text !== null) { out += t.text; continue }
    const value: Scalar = VARIABLE_SET.has(t.name!) ? values[t.name!] : worst
    out += t.inString ? JSON.stringify(asText(value)).slice(1, -1) : asJson(value)
  }
  if (Buffer.byteLength(out, 'utf8') > MAX_RENDERED_BODY_BYTES) {
    return `the body would be larger than ${MAX_RENDERED_BODY_BYTES / 1024} KB once filled in (each constant and secret counted at its maximum of ${WORST_CASE_VALUE_LENGTH} characters)`
  }
  try {
    JSON.parse(out)
  } catch {
    return 'the template is not valid JSON once its variables are filled in (no trailing commas, double quotes only, every brace closed; keep {{variables}} inside quotes for text, bare for numbers)'
  }
  return undefined
}
