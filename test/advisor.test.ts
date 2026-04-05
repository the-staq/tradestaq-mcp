import { describe, it, expect } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerAdvisorTools } from '../src/tools/advisor.js'

describe('advisor tool registration', () => {
  it('registerAdvisorTools registers without error', () => {
    const server = new McpServer(
      { name: 'test-server', version: '0.0.1' },
      { capabilities: { logging: {} } },
    )
    expect(() => registerAdvisorTools(server)).not.toThrow()
  })

  it('registers suggest_strategies and get_market_context', () => {
    const server = new McpServer(
      { name: 'test-server', version: '0.0.1' },
      { capabilities: { logging: {} } },
    )
    const toolSpy = vi.spyOn(server, 'tool')
    registerAdvisorTools(server)
    expect(toolSpy).toHaveBeenCalledTimes(2)
    expect(toolSpy.mock.calls[0][0]).toBe('suggest_strategies')
    expect(toolSpy.mock.calls[1][0]).toBe('get_market_context')
  })
})
