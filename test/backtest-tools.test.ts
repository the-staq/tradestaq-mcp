import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerBacktestTools } from '../src/tools/backtest.js'

const { mockApi } = vi.hoisted(() => ({ mockApi: vi.fn() }))
vi.mock('../src/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api.js')>('../src/api.js')
  return { ...actual, api: mockApi }
})

beforeEach(() => {
  vi.clearAllMocks()
})

function getToolHandler(name: string) {
  const server = new McpServer(
    { name: 'test-server', version: '0.0.1' },
    { capabilities: { logging: {} } },
  )
  const toolSpy = vi.spyOn(server, 'tool')
  registerBacktestTools(server)
  const call = toolSpy.mock.calls.find((c) => c[0] === name)
  if (!call) throw new Error(`tool ${name} was not registered`)
  return call[call.length - 1] as (args: any) => Promise<any>
}

async function jsonOf(result: any) {
  return JSON.parse(result.content[0].text)
}

// The real backtest completion metrics: GET /api/backtests/:id returns them
// flat under `metrics`, keyed totalReturnPercent/maxDrawdownPercent/etc --
// not nested in a `results` wrapper (that field never exists) and not keyed
// roi/maxDrawdown/totalPnl as the tool previously assumed.
const REAL_METRICS = {
  totalReturnPercent: -6.05,
  winRate: 37.0,
  totalTrades: 135,
  maxDrawdownPercent: 7.98,
  sharpeRatio: 0.42,
  profitFactor: 0.88,
}

describe('what_if_backtest', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('names the backtest with the real (owned) strategy name, and maps real completion metrics', async () => {
    mockApi
      .mockResolvedValueOnce({ data: { name: 'GridRunner' } }) // resolveStrategyName: owner-authoritative
      .mockResolvedValueOnce({ id: 'job-1' }) // POST /api/backtests
      .mockResolvedValueOnce({ status: 'completed', metrics: REAL_METRICS }) // poll

    const handler = getToolHandler('what_if_backtest')
    const promise = handler({ strategyId: 's1', symbol: 'ETH/USDT:USDT', exchange: 'ex1', timeframe: '1h', period: '3m', initialBalance: 10000 })
    await vi.advanceTimersByTimeAsync(3000)
    const result = await promise

    // Real strategy name in the backtest's name, not "MCP Backtest ..."
    const [, postOpts] = mockApi.mock.calls[1]
    expect(postOpts.body.name).toBe('GridRunner — ETH/USDT:USDT 3m')

    const body = await jsonOf(result)
    expect(body.status).toBe('completed')
    expect(body.metrics).toEqual(REAL_METRICS)
    expect(body.equity).toEqual({ start: 10000, end: 10000 * (1 - 0.0605) })
  })

  it('falls back to the marketplace strategy name on a 403 (not the owner)', async () => {
    const { ApiError } = await import('../src/api.js')
    mockApi
      .mockRejectedValueOnce(new ApiError(403, 'HTTP_403', 'Forbidden', false))
      .mockResolvedValueOnce({ doc: { name: 'GhostRider' } })
      .mockResolvedValueOnce({ id: 'job-2' })
      .mockResolvedValueOnce({ status: 'completed', metrics: {} })

    const handler = getToolHandler('what_if_backtest')
    const promise = handler({ strategyId: 's2', symbol: 'BTC/USDT', exchange: 'ex1', timeframe: '1h', period: '3m', initialBalance: 10000 })
    await vi.advanceTimersByTimeAsync(3000)
    await promise

    const [, postOpts] = mockApi.mock.calls[2]
    expect(postOpts.body.name).toBe('GhostRider — BTC/USDT 3m')
  })

  it('omits equity.end (does not fabricate a number) when totalReturnPercent is missing', async () => {
    mockApi
      .mockResolvedValueOnce({ data: { name: 'Strat' } })
      .mockResolvedValueOnce({ id: 'job-3' })
      .mockResolvedValueOnce({ status: 'completed', metrics: {} })

    const handler = getToolHandler('what_if_backtest')
    const promise = handler({ strategyId: 's3', symbol: 'BTC/USDT', exchange: 'ex1', timeframe: '1h', period: '3m', initialBalance: 10000 })
    await vi.advanceTimersByTimeAsync(3000)
    const result = await promise

    const body = await jsonOf(result)
    expect(body.equity).toEqual({ start: 10000, end: undefined })
  })

  it('surfaces a failed backtest as an error', async () => {
    mockApi
      .mockResolvedValueOnce({ data: { name: 'Strat' } })
      .mockResolvedValueOnce({ id: 'job-4' })
      .mockResolvedValueOnce({ status: 'failed', error: 'Strategy code threw an error' })

    const handler = getToolHandler('what_if_backtest')
    const promise = handler({ strategyId: 's4', symbol: 'BTC/USDT', exchange: 'ex1', timeframe: '1h', period: '3m', initialBalance: 10000 })
    await vi.advanceTimersByTimeAsync(3000)
    const result = await promise

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('Strategy code threw an error')
  })
})

describe('get_backtest_results', () => {
  it('maps real completion metrics (not results.roi/maxDrawdown)', async () => {
    mockApi.mockResolvedValueOnce({ status: 'completed', metrics: REAL_METRICS })

    const handler = getToolHandler('get_backtest_results')
    const result = await handler({ jobId: 'job-5' })

    const body = await jsonOf(result)
    expect(body.status).toBe('completed')
    expect(body.metrics).toEqual(REAL_METRICS)
  })

  it('reports pending status without metrics when not yet completed', async () => {
    mockApi.mockResolvedValueOnce({ status: 'running' })

    const handler = getToolHandler('get_backtest_results')
    const result = await handler({ jobId: 'job-6' })

    expect(result.content[0].text).toContain('running')
  })
})

describe('export_backtest', () => {
  it('maps real completion metrics and returns export links', async () => {
    mockApi.mockResolvedValueOnce({ status: 'completed', metrics: REAL_METRICS })

    const handler = getToolHandler('export_backtest')
    const result = await handler({ id: 'bt-7' })

    const body = await jsonOf(result)
    expect(body.metrics).toEqual(REAL_METRICS)
    expect(body.exportLinks).toEqual({ csv: '/api/backtests/bt-7/export/csv', pdf: '/api/backtests/bt-7/export/pdf' })
  })

  it('refuses to export a backtest that has not completed', async () => {
    mockApi.mockResolvedValueOnce({ status: 'running' })

    const handler = getToolHandler('export_backtest')
    const result = await handler({ id: 'bt-8' })

    expect(result.content[0].text).toContain('not completed yet');
  })
})
