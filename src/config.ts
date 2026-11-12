import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

export interface McpConfig {
  token?: string
  baseUrl: string
  tokenExpiresAt?: number
  // Rotating OAuth 2.1 refresh token (opaque). Used to silently mint a fresh
  // access token when the short-lived one expires — no browser re-consent.
  refreshToken?: string
  refreshExpiresAt?: number
  // OAuth client_id from Dynamic Client Registration, cached across auth attempts.
  // Keyed under baseUrl so switching environments gets a fresh registration.
  oauthClientId?: string
  oauthClientIdForBaseUrl?: string
  // True once the cached client_id was registered WITH the refresh_token grant.
  // Clients registered by older versions lack it, so we re-register rather than
  // reuse a client that can't issue refresh tokens.
  oauthClientRefreshCapable?: boolean
}

const CONFIG_DIR = path.join(os.homedir(), '.tradestaq')
const CONFIG_FILE = path.join(CONFIG_DIR, 'mcp-config.json')
const LOCK_FILE = `${CONFIG_FILE}.lock`

let _cache: McpConfig | null = null

/** The config file this process reads and writes (~/.tradestaq/mcp-config.json). */
export function configFilePath(): string {
  return CONFIG_FILE
}

// The apex host (tradestaq.com) 301-redirects to www, and fetch/undici strips
// the Authorization header on that cross-origin redirect — so an apex baseUrl
// authenticates fine at the OAuth layer but every subsequent API call reaches
// the upstream with no bearer and 401s ("authenticated, but every tool fails").
// Force www so API calls stay same-origin and the bearer survives. Mirrors the
// www-forcing in the site's .well-known/oauth-* routes; a stray apex value from
// ANY source (stale config file, env override, user input) can no longer strip
// auth. Non-apex hosts (staging, self-hosted, custom) are left untouched.
export function normalizeBaseUrl(url: string): string {
  return url.replace(/^https:\/\/tradestaq\.com/, 'https://www.tradestaq.com')
}

function readConfig(): McpConfig {
  const defaults: McpConfig = { baseUrl: 'https://www.tradestaq.com' }

  // Environment variables override file config (useful for CI, Claude Code, etc.)
  const envToken = process.env.TRADESTAQ_TOKEN
  const envBaseUrl = process.env.TRADESTAQ_BASE_URL

  let config: McpConfig
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf-8')
    config = { ...defaults, ...JSON.parse(raw) }
  } catch {
    config = { ...defaults }
  }
  if (envToken) config.token = envToken
  if (envBaseUrl) config.baseUrl = envBaseUrl
  config.baseUrl = normalizeBaseUrl(config.baseUrl)
  return config
}

/** The config, read from disk once per process and cached. */
export function loadConfig(): McpConfig {
  if (!_cache) _cache = readConfig()
  return _cache
}

/**
 * Read the config from disk again, replacing this process's cached copy. Several copies of
 * the stdio server share one config file (an interactive session, headless `claude -p`
 * runs), so another one may have signed in or rotated the tokens since this process cached
 * them. Its refresh token is then the only valid one: the cached one is already used, and
 * the server revokes the whole session when a used refresh token comes back.
 */
export function reloadConfig(): McpConfig {
  _cache = readConfig()
  return _cache
}

/**
 * Write the config atomically: a temp file in the same directory, renamed over the old one.
 * A reader in another process sees the old file or the new one, never a half-written one
 * (which reads as "no config": no tokens, no OAuth client). The file is always 0600.
 */
export function saveConfig(config: McpConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
  const tmp = `${CONFIG_FILE}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  try {
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600, flag: 'wx', flush: true })
    fs.renameSync(tmp, CONFIG_FILE)
  } catch (err) {
    fs.rmSync(tmp, { force: true })
    throw err
  }
  _cache = config
}

export function clearToken(): void {
  _cache = null
  const config = loadConfig()
  delete config.token
  delete config.tokenExpiresAt
  delete config.refreshToken
  delete config.refreshExpiresAt
  // Also drop the cached OAuth client_id. It was registered with whatever
  // scope the last authenticate call used; a subsequent authenticate with
  // a different scope should re-register cleanly rather than reuse a
  // client_id bound to the old scope (some OAuth servers enforce the
  // registered scope as an upper bound on authorize-time scope requests).
  delete config.oauthClientId
  delete config.oauthClientIdForBaseUrl
  delete config.oauthClientRefreshCapable
  saveConfig(config)
}

export function isAuthenticated(): boolean {
  const config = loadConfig()
  if (!config.token || typeof config.token !== 'string' || config.token.length < 10) return false
  if (config.tokenExpiresAt && Date.now() > config.tokenExpiresAt) return false
  return true
}

// ── Cross-process lock around the token refresh ─────────────────────────────
//
// An exclusive lockfile next to the config (created with O_CREAT|O_EXCL), holding
// "<pid> <hostname> <nonce>". A holder keeps it for one refresh request (bounded by that
// request's timeout, well under LOCK_STALE_MS) and removes it in `finally`. A lock older
// than LOCK_STALE_MS, or left by a process on this host that no longer exists (a headless
// run killed mid-refresh), is broken. A waiter gives up after LOCK_WAIT_MS, which outlasts
// LOCK_STALE_MS, so it can always break a lock whose holder died.

const LOCK_STALE_MS = 30_000
const LOCK_WAIT_MS = 35_000

export class ConfigLockTimeoutError extends Error {
  constructor() {
    super('Timed out waiting for the TradeStaq config lock')
    this.name = 'ConfigLockTimeoutError'
  }
}

export interface ConfigLockOptions {
  /** Give up after this many ms (default 35s). */
  waitMs?: number
  /** Break a lock whose file is older than this many ms (default 30s). */
  staleMs?: number
}

/**
 * Run `fn` holding the config lock, so no other process sharing the config file runs its
 * own locked section at the same time. Throws ConfigLockTimeoutError (without running `fn`)
 * when the lock can't be had within `waitMs`.
 */
export async function withConfigLock<T>(fn: () => Promise<T>, opts: ConfigLockOptions = {}): Promise<T> {
  const waitMs = opts.waitMs ?? LOCK_WAIT_MS
  const staleMs = opts.staleMs ?? LOCK_STALE_MS
  const owner = `${process.pid} ${os.hostname()} ${crypto.randomBytes(8).toString('hex')}`
  const deadline = Date.now() + waitMs
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })

  while (!tryCreateLock(owner)) {
    if (breakLockIfStale(staleMs)) continue
    if (Date.now() >= deadline) throw new ConfigLockTimeoutError()
    await new Promise((resolve) => setTimeout(resolve, 25 + Math.random() * 50))
  }
  try {
    return await fn()
  } finally {
    releaseLock(owner)
  }
}

function tryCreateLock(owner: string): boolean {
  let fd: number
  try {
    fd = fs.openSync(LOCK_FILE, 'wx', 0o600)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw err
  }
  try {
    fs.writeSync(fd, owner)
  } finally {
    fs.closeSync(fd)
  }
  return true
}

/** True when the lock was removed (or had already gone), so the caller should try again now. */
function breakLockIfStale(staleMs: number): boolean {
  let seen: string
  let st: fs.Stats
  try {
    seen = fs.readFileSync(LOCK_FILE, 'utf-8')
    st = fs.statSync(LOCK_FILE)
  } catch {
    return true
  }
  if (Date.now() - st.mtimeMs <= staleMs && !holderIsGone(seen)) return false

  // Move it aside (atomic) instead of unlinking it: of several waiters breaking the same
  // lock, only one rename finds it.
  const aside = `${LOCK_FILE}.${crypto.randomBytes(6).toString('hex')}.stale`
  try {
    fs.renameSync(LOCK_FILE, aside)
  } catch {
    return true
  }
  try {
    // Another waiter may have broken this same lock a moment earlier and taken a fresh one,
    // which is then what was just moved. Put that back (link never replaces a lock taken since).
    const moved = fs.statSync(aside)
    if (moved.ino !== st.ino || moved.dev !== st.dev || fs.readFileSync(aside, 'utf-8') !== seen) {
      fs.linkSync(aside, LOCK_FILE)
    }
  } catch {
    // The lock was taken again meanwhile; that holder keeps it.
  }
  fs.rmSync(aside, { force: true })
  return true
}

/** The lock's holder was a process on this host that no longer exists. */
function holderIsGone(content: string): boolean {
  const [pidText, host] = content.split(' ')
  const pid = Number(pidText)
  if (!Number.isInteger(pid) || pid <= 0 || host !== os.hostname()) return false
  try {
    process.kill(pid, 0)
    return false
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

function releaseLock(owner: string): void {
  try {
    // Only our own lock: if ours was broken as stale, the file is someone else's now.
    if (fs.readFileSync(LOCK_FILE, 'utf-8') === owner) fs.unlinkSync(LOCK_FILE)
  } catch {
    // Already gone.
  }
}
