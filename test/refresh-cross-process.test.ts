// Several copies of the stdio server share ~/.tradestaq/mcp-config.json (an interactive
// session plus headless `claude -p` runs). Each cached the config for its whole life and
// refreshed on its own, so after one rotated the refresh token another later sent the stale
// copy it still held; the server took that as a reused (stolen) refresh token and revoked the
// whole family, signing every copy out with AUTH_EXPIRED.
//
// These tests run the REAL config and api modules, one fresh module instance per simulated
// process (own cache, own single-flight), all on one temp config dir via HOME. Only HTTP is
// faked: a token endpoint that rotates refresh tokens and revokes the family on reuse, like
// TradeStaq's /api/oauth/token.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }))
vi.stubGlobal('fetch', mockFetch)

const BASE = 'https://tradestaq.test'
const HOUR = 3600e3
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const json = (body: unknown, status = 200) => ({
  ok: status < 400,
  status,
  headers: new Headers(),
  json: async () => body,
  text: async () => JSON.stringify(body),
})

// The refresh grant reduced to what this bug is about: a refresh token works once and
// rotates; one presented again revokes the family (every refresh and access token in it).
class FakeAuthServer {
  current = 'tsr_0'
  used = new Set<string>()
  revoked = false
  minted = 0
  refreshCalls: string[] = []
  liveAccess = new Set(['access-token-0'])
  onRefresh?: () => void

  async handle(url: string, init: any) {
    if (new URL(url).pathname === '/api/oauth/token') {
      const sent = new URLSearchParams(init.body).get('refresh_token')!
      this.refreshCalls.push(sent)
      await sleep(50) // in flight long enough for the other processes to pile in
      this.onRefresh?.()
      if (this.used.has(sent)) {
        this.revoked = true
        this.liveAccess.clear()
      }
      if (this.revoked || sent !== this.current) return json({ error: 'invalid_grant' }, 400)
      this.used.add(sent)
      this.minted++
      this.current = `tsr_${this.minted}`
      this.liveAccess.add(`access-token-${this.minted}`)
      return json({ access_token: `access-token-${this.minted}`, refresh_token: this.current, expires_in: 3600 })
    }
    // Any API route: 200 for a live access token, else 401.
    const bearer = String(init.headers.Authorization).replace(/^Bearer /, '')
    return this.liveAccess.has(bearer) ? json({ ok: true, bearer }) : json({ error: 'unauthorized' }, 401)
  }
}

let home: string
let server: FakeAuthServer
const saved = { HOME: process.env.HOME, TRADESTAQ_TOKEN: process.env.TRADESTAQ_TOKEN, TRADESTAQ_BASE_URL: process.env.TRADESTAQ_BASE_URL }

const configDir = () => path.join(home, '.tradestaq')
const configFile = () => path.join(configDir(), 'mcp-config.json')
const lockFile = () => `${configFile()}.lock`
const readFile = () => JSON.parse(fs.readFileSync(configFile(), 'utf-8'))
function writeFile(config: object) {
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 })
  fs.writeFileSync(configFile(), JSON.stringify(config), { mode: 0o600 })
}
// A signed-in session whose access token expired an hour ago (refresh token good).
const session = (over: object = {}) => ({
  baseUrl: BASE,
  token: 'access-token-0',
  tokenExpiresAt: Date.now() - HOUR,
  refreshToken: 'tsr_0',
  refreshExpiresAt: Date.now() + 29 * 24 * HOUR,
  oauthClientId: 'tsc_client',
  oauthClientIdForBaseUrl: BASE,
  oauthClientRefreshCapable: true,
  ...over,
})

/** A server process: fresh config + api modules (own cache, own single-flight), config cached at start. */
async function startProcess() {
  vi.resetModules()
  const config = await import('../src/config.js')
  const api = await import('../src/api.js')
  const { requestContext } = await import('../src/request-context.js')
  // Never the real ~/.tradestaq.
  expect(config.configFilePath()).toBe(configFile())
  config.loadConfig()
  return { config, api, requestContext }
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tradestaq-mcp-test-'))
  process.env.HOME = home
  delete process.env.TRADESTAQ_TOKEN
  delete process.env.TRADESTAQ_BASE_URL
  if (os.homedir() !== home) throw new Error('HOME override not honored; refusing to touch the real config')
  server = new FakeAuthServer()
  mockFetch.mockReset()
  mockFetch.mockImplementation((url: string, init: any) => server.handle(url, init))
  writeFile(session())
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  fs.rmSync(home, { recursive: true, force: true })
})

describe('refresh across processes sharing the config file', () => {
  it('three processes refreshing at once send ONE refresh, and all end up on the new pair', async () => {
    const procs = [await startProcess(), await startProcess(), await startProcess()]

    const results = await Promise.all(procs.map((p) => p.api.api('/api/bots')))

    expect(server.refreshCalls).toEqual(['tsr_0'])
    expect(server.revoked).toBe(false)
    expect(results).toEqual([1, 2, 3].map(() => ({ ok: true, bearer: 'access-token-1' })))
    for (const p of procs) expect(p.config.loadConfig()).toMatchObject({ token: 'access-token-1', refreshToken: 'tsr_1' })
    expect(readFile()).toMatchObject({ token: 'access-token-1', refreshToken: 'tsr_1', oauthClientId: 'tsc_client' })
    expect(fs.existsSync(lockFile())).toBe(false)
  })

  it('a process holding a rotated-away refresh token in memory uses the file instead of refreshing', async () => {
    const a = await startProcess()
    const b = await startProcess()
    await a.api.api('/api/bots') // A rotates tsr_0 → tsr_1
    expect(b.config.loadConfig()).toMatchObject({ token: 'access-token-0', refreshToken: 'tsr_0' }) // B's stale copy

    expect(await b.api.api('/api/bots')).toEqual({ ok: true, bearer: 'access-token-1' })
    expect(server.refreshCalls).toEqual(['tsr_0']) // B sent nothing
    expect(server.revoked).toBe(false)
  })

  it('when the file pair has expired too, it refreshes with the FILE refresh token, never its stale one', async () => {
    const a = await startProcess()
    const b = await startProcess()
    await a.api.api('/api/bots') // tsr_1 on disk
    writeFile({ ...readFile(), tokenExpiresAt: Date.now() - 1000 }) // an hour on: access-token-1 expired as well

    expect(await b.api.api('/api/bots')).toEqual({ ok: true, bearer: 'access-token-2' })
    expect(server.refreshCalls).toEqual(['tsr_0', 'tsr_1'])
    expect(server.revoked).toBe(false)
  })

  it('a 401 re-reads the file and retries with the token another process rotated in, without refreshing', async () => {
    writeFile(session({ tokenExpiresAt: Date.now() + 50 * 60e3 })) // looks good for 50 min
    server.liveAccess.delete('access-token-0') // but the server refuses it
    const a = await startProcess()
    const b = await startProcess()

    expect(await a.api.api('/api/bots')).toEqual({ ok: true, bearer: 'access-token-1' }) // A: 401 → refresh
    expect(await b.api.api('/api/bots')).toEqual({ ok: true, bearer: 'access-token-1' }) // B: 401 → file
    expect(server.refreshCalls).toEqual(['tsr_0'])
    expect(server.revoked).toBe(false)
  })

  it('a process that has no token cached picks up a sign-in another process wrote', async () => {
    writeFile({ baseUrl: BASE })
    const b = await startProcess() // started signed out
    writeFile(session({ token: 'access-token-0', tokenExpiresAt: Date.now() + HOUR })) // signed in elsewhere

    expect(await b.api.api('/api/bots')).toEqual({ ok: true, bearer: 'access-token-0' })
    expect(server.refreshCalls).toEqual([])
  })
})

describe('config lock', () => {
  const heldBy = (pid: number) => `${pid} ${os.hostname()} 0123456789abcdef`

  it('breaks a lock older than the stale timeout', async () => {
    fs.writeFileSync(lockFile(), heldBy(process.pid)) // holder "alive", so only its age counts
    const old = new Date(Date.now() - 60_000)
    fs.utimesSync(lockFile(), old, old)
    const p = await startProcess()

    const started = Date.now()
    expect(await p.api.hasUsableToken()).toBe(true)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(server.refreshCalls).toEqual(['tsr_0'])
    expect(fs.existsSync(lockFile())).toBe(false)
  })

  it('breaks a fresh lock at once when its holder process no longer exists', async () => {
    const deadPid = spawnSync(process.execPath, ['-e', '']).pid!
    fs.writeFileSync(lockFile(), heldBy(deadPid))
    const p = await startProcess()

    const started = Date.now()
    expect(await p.api.hasUsableToken()).toBe(true)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(server.refreshCalls).toEqual(['tsr_0'])
    expect(fs.existsSync(lockFile())).toBe(false)
  })

  it("waits for a live holder, never breaks its lock, then uses the pair it wrote", async () => {
    fs.writeFileSync(lockFile(), heldBy(process.pid))
    const p = await startProcess()

    const pending = p.api.hasUsableToken()
    await sleep(300)
    expect(server.refreshCalls).toEqual([])
    expect(fs.readFileSync(lockFile(), 'utf-8')).toBe(heldBy(process.pid))
    // The holder finishes: it rotated the pair and released the lock.
    writeFile(session({ token: 'access-token-9', tokenExpiresAt: Date.now() + HOUR, refreshToken: 'tsr_9' }))
    fs.rmSync(lockFile())

    expect(await pending).toBe(true)
    expect(server.refreshCalls).toEqual([])
    expect(p.config.loadConfig()).toMatchObject({ token: 'access-token-9', refreshToken: 'tsr_9' })
  })

  it('gives up after its wait budget without running the locked section, leaving the lock alone', async () => {
    fs.writeFileSync(lockFile(), heldBy(process.pid))
    const p = await startProcess()
    const section = vi.fn(async () => 'ran')

    await expect(p.config.withConfigLock(section, { waitMs: 200 })).rejects.toBeInstanceOf(p.config.ConfigLockTimeoutError)
    expect(section).not.toHaveBeenCalled()
    expect(fs.readFileSync(lockFile(), 'utf-8')).toBe(heldBy(process.pid))
  })

  it('releases the lock when the refresh request fails, keeping the tokens', async () => {
    const p = await startProcess()
    mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'))

    expect(await p.api.hasUsableToken()).toBe(false)
    expect(fs.existsSync(lockFile())).toBe(false)
    expect(readFile()).toMatchObject({ refreshToken: 'tsr_0' })
    expect(await p.api.hasUsableToken()).toBe(true) // the next call refreshes normally
  })
})

describe('atomic config write', () => {
  it('writes a temp file and renames it over the config: readers see the old file whole until then; 0600; no temp left', async () => {
    const p = await startProcess()
    fs.chmodSync(configFile(), 0o644) // even a looser file ends up 0600
    const before = fs.readFileSync(configFile(), 'utf-8')
    const atRename: string[] = []
    const rename = fs.renameSync
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      atRename.push(fs.readFileSync(configFile(), 'utf-8'))
      return rename(from, to)
    })

    p.config.saveConfig({ ...readFile(), token: 'access-token-new' })

    expect(atRename).toEqual([before])
    expect(readFile().token).toBe('access-token-new')
    expect(fs.statSync(configFile()).mode & 0o777).toBe(0o600)
    expect(fs.readdirSync(configDir())).toEqual(['mcp-config.json'])
  })

  it('a write that fails leaves the old file intact and no partial or temp file behind', async () => {
    const p = await startProcess()
    const before = fs.readFileSync(configFile(), 'utf-8')
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' })
    })

    expect(() => p.config.saveConfig({ ...readFile(), token: 'access-token-new' })).toThrow('EIO')
    expect(fs.readFileSync(configFile(), 'utf-8')).toBe(before)
    expect(fs.readdirSync(configDir())).toEqual(['mcp-config.json'])
  })
})

describe('invalid_grant', () => {
  it('clears the stored tokens when the file still holds the refresh token that was refused', async () => {
    server.revoked = true // e.g. signed out everywhere
    const p = await startProcess()

    expect(await p.api.hasUsableToken()).toBe(false)
    expect(server.refreshCalls).toEqual(['tsr_0'])
    const file = readFile()
    expect(file.token).toBeUndefined()
    expect(file.refreshToken).toBeUndefined()
    expect(file).toMatchObject({ baseUrl: BASE, oauthClientId: 'tsc_client' })
  })

  it('keeps tokens written to the file while the refused refresh was in flight', async () => {
    server.revoked = true
    // A sign-in elsewhere (or a copy of the server without the lock) writes a new pair meanwhile.
    server.onRefresh = () => writeFile(session({ token: 'access-token-other', tokenExpiresAt: Date.now() + HOUR, refreshToken: 'tsr_other' }))
    const p = await startProcess()

    expect(await p.api.hasUsableToken()).toBe(true)
    expect(readFile()).toMatchObject({ token: 'access-token-other', refreshToken: 'tsr_other' })
    expect(p.config.loadConfig()).toMatchObject({ token: 'access-token-other', refreshToken: 'tsr_other' })
  })
})

describe('hosted (per-request bearer)', () => {
  it('never refreshes, locks or writes the shared config file, even with an expired file token', async () => {
    const p = await startProcess()
    const before = fs.readFileSync(configFile(), 'utf-8')
    const mtime = fs.statSync(configFile()).mtimeMs
    const openSync = vi.spyOn(fs, 'openSync')
    const readFileSync = vi.spyOn(fs, 'readFileSync')
    server.liveAccess.add('bearer-x')

    const ok = await p.requestContext.run({ token: 'bearer-x' }, () => p.api.api('/api/bots'))
    expect(ok).toEqual({ ok: true, bearer: 'bearer-x' })
    // A refused bearer is the connector's to renew: no file read-back, no refresh.
    await expect(p.requestContext.run({ token: 'bearer-y' }, () => p.api.api('/api/bots'))).rejects.toMatchObject({ status: 401 })
    expect(await p.requestContext.run({ token: 'bearer-x' }, () => p.api.hasUsableToken())).toBe(true)

    expect(server.refreshCalls).toEqual([])
    expect(readFileSync).not.toHaveBeenCalled()
    expect(openSync).not.toHaveBeenCalled()
    expect(fs.existsSync(lockFile())).toBe(false)
    expect(fs.readFileSync(configFile(), 'utf-8')).toBe(before)
    expect(fs.statSync(configFile()).mtimeMs).toBe(mtime)
  })
})
