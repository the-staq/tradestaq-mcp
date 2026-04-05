import { describe, it, expect, vi, beforeEach } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerPrompts } from '../src/prompts/index.js'

beforeEach(() => {
  vi.clearAllMocks()
})

function createServer() {
  return new McpServer(
    { name: 'test-server', version: '0.0.1' },
    { capabilities: { logging: {} } },
  )
}

describe('prompt registration', () => {
  it('registerPrompts registers without error', () => {
    const server = createServer()
    expect(() => registerPrompts(server)).not.toThrow()
  })

  it('registers expected prompts on the server', () => {
    const server = createServer()
    const promptSpy = vi.spyOn(server, 'prompt')
    registerPrompts(server)

    expect(promptSpy).toHaveBeenCalledTimes(2)
    expect(promptSpy.mock.calls[0][0]).toBe('trading-assistant')
    expect(promptSpy.mock.calls[1][0]).toBe('strategy-builder')
  })
})
