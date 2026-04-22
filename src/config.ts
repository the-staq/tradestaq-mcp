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

export function loadConfig(): McpConfig {
  if (_cache) return _cache
  const defaults: McpConfig = { baseUrl: 'https://tradestaq.com' }

  // Environment variables override file config (useful for CI, Claude Code, etc.)
  const envToken = process.env.TRADESTAQ_TOKEN
  const envBaseUrl = process.env.TRADESTAQ_BASE_URL

  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf-8')
    const config = { ...defaults, ...JSON.parse(raw) }
    if (envToken) config.token = envToken
    if (envBaseUrl) config.baseUrl = envBaseUrl
    _cache = config
    return config
  } catch {
    const config = { ...defaults }
    if (envToken) config.token = envToken
    if (envBaseUrl) config.baseUrl = envBaseUrl
    _cache = config
    return config
  }
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
