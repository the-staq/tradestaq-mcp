import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export interface McpConfig {
  token?: string
  baseUrl: string
  tokenExpiresAt?: number
  // OAuth client_id from Dynamic Client Registration, cached across auth attempts.
  // Keyed under baseUrl so switching environments gets a fresh registration.
  oauthClientId?: string
  oauthClientIdForBaseUrl?: string
}

const CONFIG_DIR = path.join(os.homedir(), '.tradestaq')
const CONFIG_FILE = path.join(CONFIG_DIR, 'mcp-config.json')

let _cache: McpConfig | null = null

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

export function loadConfig(): McpConfig {
  if (_cache) return _cache
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
  _cache = config
  return config
}

export function saveConfig(config: McpConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 })
  _cache = config
}

export function clearToken(): void {
  _cache = null
  const config = loadConfig()
  delete config.token
  delete config.tokenExpiresAt
  // Also drop the cached OAuth client_id. It was registered with whatever
  // scope the last authenticate call used; a subsequent authenticate with
  // a different scope should re-register cleanly rather than reuse a
  // client_id bound to the old scope (some OAuth servers enforce the
  // registered scope as an upper bound on authorize-time scope requests).
  delete config.oauthClientId
  delete config.oauthClientIdForBaseUrl
  saveConfig(config)
}

export function isAuthenticated(): boolean {
  const config = loadConfig()
  if (!config.token || typeof config.token !== 'string' || config.token.length < 10) return false
  if (config.tokenExpiresAt && Date.now() > config.tokenExpiresAt) return false
  return true
}
