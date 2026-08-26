import { describe, it, expect, vi, beforeEach } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerStrategyLabTools } from '../src/tools/strategy-lab.js'
import { ApiError } from '../src/api.js'

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
  registerStrategyLabTools(server)
  const call = toolSpy.mock.calls.find((c) => c[0] === name)
  if (!call) throw new Error(`tool ${name} was not registered`)
  return call[call.length - 1] as (args: any) => Promise<any>
}

async function jsonOf(result: any) {
  return JSON.parse(result.content[0].text)
}

describe('start_optimization_run', () => {
  it('without acknowledgeCost, surfaces the cost preview and does not report a jobId', async () => {
    mockApi.mockResolvedValue({
      status: 'cost_estimate',
      estimatedCost: 10,
      creditsPerExperiment: 0.5,
      maxExperiments: 20,
      balance: 25,
      sufficient: true,
      acknowledgeCost: false,
    })

    const handler = getToolHandler('start_optimization_run')
    const result = await handler({ strategyId: 's1', exchangeId: 'e1', maxExperiments: 20 })
    const body = await jsonOf(result)

    expect(body.status).toBe('cost_estimate')
    expect(body.estimatedCost).toBe(10)
    expect(body.walletBalance).toBe(25)
    expect(body.sufficientBalance).toBe(true)
    expect(body.jobId).toBeUndefined()
  })

  it('with acknowledgeCost:true, queues the run and returns the jobId', async () => {
    mockApi.mockResolvedValue({
      message: 'Optimization started',
      jobId: 'job-1',
      estimatedCost: 10,
      config: { strategy: 's1', symbol: 'BTC/USDT', timeframe: '1h', experiments: 20, profile: 'balanced' },
    })

    const handler = getToolHandler('start_optimization_run')
    const result = await handler({ strategyId: 's1', exchangeId: 'e1', acknowledgeCost: true })
    const body = await jsonOf(result)

    expect(body.status).toBe('started')
    expect(body.jobId).toBe('job-1')
    expect(body.config).toEqual({ strategy: 's1', symbol: 'BTC/USDT', timeframe: '1h', experiments: 20, profile: 'balanced' })

    const [url, opts] = mockApi.mock.calls[0]
    expect(url).toBe('/api/strategy-lab')
    expect(opts.method).toBe('POST')
    expect(opts.body).toMatchObject({ strategyId: 's1', exchangeId: 'e1', acknowledgeCost: true })
  })

  it('surfaces a 403 when the soft-launch kill switch is off', async () => {
    mockApi.mockRejectedValue(new ApiError(403, 'HTTP_403', 'Strategy Lab is not yet available.', false))

    const handler = getToolHandler('start_optimization_run')
    const result = await handler({ strategyId: 's1', exchangeId: 'e1', acknowledgeCost: true })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('not yet available')
  })

  it('surfaces a 402 on insufficient wallet balance', async () => {
    mockApi.mockRejectedValue(new ApiError(402, 'HTTP_402', 'Insufficient wallet balance', false))

    const handler = getToolHandler('start_optimization_run')
    const result = await handler({ strategyId: 's1', exchangeId: 'e1', acknowledgeCost: true })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('Insufficient wallet balance')
  })

  it('surfaces a 409 when a run is already active for this user', async () => {
    mockApi.mockRejectedValue(new ApiError(409, 'HTTP_409', 'You already have an optimization running — wait for it to finish or cancel it first', false))

    const handler = getToolHandler('start_optimization_run')
    const result = await handler({ strategyId: 's1', exchangeId: 'e1', acknowledgeCost: true })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('already have an optimization running')
  })

  it('passes through optional tuning params', async () => {
    mockApi.mockResolvedValue({ jobId: 'job-2', estimatedCost: 5, config: {} })

    const handler = getToolHandler('start_optimization_run')
    await handler({
      strategyId: 's1',
      exchangeId: 'e1',
      symbol: 'ETH/USDT',
      timeframe: '4h',
      maxExperiments: 10,
      scoringProfile: 'aggressive',
      trainSplit: 0.8,
      userGuidance: 'focus on reducing drawdown',
      acknowledgeCost: true,
    })

    const [, opts] = mockApi.mock.calls[0]
    expect(opts.body).toMatchObject({
      symbol: 'ETH/USDT',
      timeframe: '4h',
      maxExperiments: 10,
      scoringProfile: 'aggressive',
      trainSplit: 0.8,
      userGuidance: 'focus on reducing drawdown',
    })
  })
})

describe('get_optimization_status', () => {
  it('passes through the cached OptimizationProgress shape', async () => {
    mockApi.mockResolvedValue({
      jobId: 'job-1',
      progress: {
        status: 'running',
        phase: 'backtesting',
        currentExperiment: 3,
        totalExperiments: 20,
        improvementsFound: 1,
        baselineScore: 5.2,
        bestScore: 7.1,
        bestMetrics: { totalTrades: 40, winRate: 55 },
        experiments: [{ index: 1, status: 'improved', score: 7.1 }],
        savedVersionId: 'v-abc',
        activeGuidance: undefined,
      },
    })

    const handler = getToolHandler('get_optimization_status')
    const result = await handler({ jobId: 'job-1' })
    const body = await jsonOf(result)

    expect(body.progress.status).toBe('running')
    expect(body.progress.currentExperiment).toBe(3)
    expect(body.progress.savedVersionId).toBe('v-abc')
    expect(mockApi).toHaveBeenCalledWith('/api/strategy-lab?jobId=job-1')
  })

  it('passes through the BullMQ-fallback shape when the progress cache entry is missing', async () => {
    mockApi.mockResolvedValue({ jobId: 'job-1', state: 'waiting', progress: 0, failedReason: undefined })

    const handler = getToolHandler('get_optimization_status')
    const result = await handler({ jobId: 'job-1' })
    const body = await jsonOf(result)

    expect(body.state).toBe('waiting')
  })

  it('surfaces a 404 when the job is not found or not owned by the caller', async () => {
    mockApi.mockRejectedValue(new ApiError(404, 'HTTP_404', 'Job not found', false))

    const handler = getToolHandler('get_optimization_status')
    const result = await handler({ jobId: 'nope' })

    expect(result.isError).toBe(true)
  })

  it('URL-encodes the jobId', async () => {
    mockApi.mockResolvedValue({ jobId: 'job with spaces', progress: {} })
    const handler = getToolHandler('get_optimization_status')
    await handler({ jobId: 'job with spaces' })

    expect(mockApi).toHaveBeenCalledWith('/api/strategy-lab?jobId=job%20with%20spaces')
  })
})

describe('cancel_optimization_run', () => {
  it('requests cancellation', async () => {
    mockApi.mockResolvedValue({ message: 'Cancel requested — will stop after current experiment', jobId: 'job-1' })

    const handler = getToolHandler('cancel_optimization_run')
    const result = await handler({ jobId: 'job-1' })
    const body = await jsonOf(result)

    expect(body.message).toContain('Cancel requested')
    expect(body.jobId).toBe('job-1')

    const [url, opts] = mockApi.mock.calls[0]
    expect(url).toBe('/api/strategy-lab')
    expect(opts.method).toBe('PUT')
    expect(opts.body).toEqual({ jobId: 'job-1', action: 'cancel' })
  })

  it('surfaces a 409 when the run already finished', async () => {
    mockApi.mockRejectedValue(new ApiError(409, 'HTTP_409', 'This optimization run has already finished', false))

    const handler = getToolHandler('cancel_optimization_run')
    const result = await handler({ jobId: 'job-1' })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('already finished')
  })
})

describe('send_optimization_guidance', () => {
  it('injects guidance', async () => {
    mockApi.mockResolvedValue({ message: 'Guidance injected — will apply on next experiment', jobId: 'job-1' })

    const handler = getToolHandler('send_optimization_guidance')
    const result = await handler({ jobId: 'job-1', guidance: 'try tighter stop losses' })
    const body = await jsonOf(result)

    expect(body.message).toContain('Guidance injected')

    const [url, opts] = mockApi.mock.calls[0]
    expect(url).toBe('/api/strategy-lab')
    expect(opts.method).toBe('PUT')
    expect(opts.body).toEqual({ jobId: 'job-1', guidance: 'try tighter stop losses' })
  })

  it('surfaces a 409 when the run already finished', async () => {
    mockApi.mockRejectedValue(new ApiError(409, 'HTTP_409', 'This optimization run has already finished', false))

    const handler = getToolHandler('send_optimization_guidance')
    const result = await handler({ jobId: 'job-1', guidance: 'anything' })

    expect(result.isError).toBe(true)
  })
})
