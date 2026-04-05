import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('node:fs', () => ({
  default: {
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  },
}))

// We need to reset modules between tests to clear the module-level _cache
beforeEach(() => {
  vi.clearAllMocks()
  vi.resetModules()
})

async function freshImport() {
  const configModule = await import('../src/config.js')
  const fsModule = await import('node:fs')
  return { configModule, fs: fsModule.default }
}

describe('loadConfig', () => {
  it('returns defaults when config file does not exist', async () => {
    const { configModule, fs } = await freshImport()
    ;(fs.readFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('ENOENT: no such file or directory')
    })

    const config = configModule.loadConfig()
    expect(config).toEqual({ baseUrl: 'https://tradestaq.com' })
  })

  it('parses valid JSON file', async () => {
    const { configModule, fs } = await freshImport()
    const stored = { token: 'abc123', baseUrl: 'https://custom.com', tokenExpiresAt: 9999999999999 }
    ;(fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(JSON.stringify(stored))

    const config = configModule.loadConfig()
    expect(config.token).toBe('abc123')
    expect(config.baseUrl).toBe('https://custom.com')
    expect(config.tokenExpiresAt).toBe(9999999999999)
  })

  it('returns defaults on corrupt JSON', async () => {
    const { configModule, fs } = await freshImport()
    ;(fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue('not valid json{{{')

    const config = configModule.loadConfig()
    expect(config).toEqual({ baseUrl: 'https://tradestaq.com' })
  })

  it('returns cached value on second call (readFileSync called once)', async () => {
    const { configModule, fs } = await freshImport()
    const stored = { token: 'tok1' }
    ;(fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(JSON.stringify(stored))

    configModule.loadConfig()
    configModule.loadConfig()

    expect(fs.readFileSync).toHaveBeenCalledTimes(1)
  })
})

describe('saveConfig', () => {
  it('writes JSON and sets cache', async () => {
    const { configModule, fs } = await freshImport()
    const config = { baseUrl: 'https://tradestaq.com', token: 'newtoken' }

    configModule.saveConfig(config)

    expect(fs.mkdirSync).toHaveBeenCalledTimes(1)
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1)
    const writtenJson = (fs.writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1]
    expect(JSON.parse(writtenJson)).toEqual(config)

    // Verify cache is set: loadConfig should NOT call readFileSync
    const loaded = configModule.loadConfig()
    expect(loaded).toEqual(config)
    expect(fs.readFileSync).not.toHaveBeenCalled()
  })
})

describe('clearToken', () => {
  it('removes token and tokenExpiresAt but preserves baseUrl', async () => {
    const { configModule, fs } = await freshImport()
    const stored = { token: 'abc', baseUrl: 'https://custom.com', tokenExpiresAt: 123456 }
    ;(fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(JSON.stringify(stored))

    configModule.clearToken()

    expect(fs.writeFileSync).toHaveBeenCalledTimes(1)
    const writtenJson = (fs.writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1]
    const saved = JSON.parse(writtenJson)
    expect(saved.token).toBeUndefined()
    expect(saved.tokenExpiresAt).toBeUndefined()
    expect(saved.baseUrl).toBe('https://custom.com')
  })
})

describe('isAuthenticated', () => {
  it('returns false when no token', async () => {
    const { configModule, fs } = await freshImport()
    ;(fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(JSON.stringify({ baseUrl: 'https://tradestaq.com' }))

    expect(configModule.isAuthenticated()).toBe(false)
  })

  it('returns false when token is expired', async () => {
    const { configModule, fs } = await freshImport()
    ;(fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      JSON.stringify({ token: 'tok', tokenExpiresAt: Date.now() - 10000 }),
    )

    expect(configModule.isAuthenticated()).toBe(false)
  })

  it('returns true when token is valid and not expired', async () => {
    const { configModule, fs } = await freshImport()
    ;(fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      JSON.stringify({ token: 'eyJhbGciOiJIUzI1NiJ9.test-token-value', tokenExpiresAt: Date.now() + 60000 }),
    )

    expect(configModule.isAuthenticated()).toBe(true)
  })
})
