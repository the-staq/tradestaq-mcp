import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export interface McpConfig {
  token?: string
  baseUrl: string
  tokenExpiresAt?: number
}

const CONFIG_DIR = path.join(os.homedir(), '.tradestaq')
const CONFIG_FILE = path.join(CONFIG_DIR, 'mcp-config.json')

let _cache: McpConfig | null = null

export function loadConfig(): McpConfig {
  if (_cache) return _cache
  const defaults: McpConfig = { baseUrl: 'https://tradestaq.com' }
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf-8')
    const config = { ...defaults, ...JSON.parse(raw) }
    _cache = config
    return config
  } catch {
    _cache = defaults
    return defaults
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
  saveConfig(config)
}

export function isAuthenticated(): boolean {
  const config = loadConfig()
  if (!config.token) return false
  if (config.tokenExpiresAt && Date.now() > config.tokenExpiresAt) return false
  return true
}
