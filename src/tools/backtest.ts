import { z } from 'zod'
import { api, ApiError } from '../api.js'
import { jsonResult, withErrorHandling, resolveStrategyName } from '../helpers.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

// GET /api/backtests/:id returns the real metrics flat under `metrics`, not
// nested in a `results` wrapper (that field doesn't exist on the response at
// all) -- and the metric keys are totalReturnPercent/maxDrawdownPercent, not
// roi/maxDrawdown. Reading `result.results || result` then `.roi`/`.maxDrawdown`
// silently produced an all-undefined metrics object on every real backtest.
function extractMetrics(result: any) {
  const m = result?.metrics || {}
  return {
    totalReturnPercent: m.totalReturnPercent,
    winRate: m.winRate,
    totalTrades: m.totalTrades,
    maxDrawdownPercent: m.maxDrawdownPercent,
    sharpeRatio: m.sharpeRatio,
    profitFactor: m.profitFactor,
  }
}

export function registerBacktestTools(server: McpServer) {

  server.tool('what_if_backtest', 'Run a backtest on a strategy. Async, may take 30-120 seconds. Returns full performance metrics.', {
    strategyId: z.string().describe('Strategy ID to backtest'),
    symbol: z.string().default('BTC/USDT'),
    exchange: z.string().describe('Exchange account ID (use list_exchanges to find)'),
    timeframe: z.string().default('1h').describe('Candle timeframe (e.g. 1h, 4h, 1d)'),
    period: z.enum(['1m', '3m', '6m', '1y']).default('3m'),
    initialBalance: z.number().default(10000),
  }, withErrorHandling(async ({ strategyId, symbol, exchange: exchangeId, timeframe, period, initialBalance }) => {
    const now = new Date()
    const months: Record<string, number> = { '1m': 1, '3m': 3, '6m': 6, '1y': 12 }
    const startDate = new Date(now)
    startDate.setMonth(startDate.getMonth() - (months[period] || 3))

    // Real strategy name, not a generic placeholder -- this is what shows up
    // in the completion Telegram notification and the dashboard backtest
    // list, and "MCP Backtest ETH/USDT:USDT 3m" told the user nothing about
    // which strategy actually ran.
    const strategyName = await resolveStrategyName(strategyId)
    const name = `${strategyName} — ${symbol} ${period}`
    const job = await api<any>('/api/backtests', {
      method: 'POST',
      body: { name, strategyId, exchangeId, symbol, timeframe, startDate: startDate.toISOString(), endDate: now.toISOString(), initialBalance },
      timeout: 15_000,
    })

    const jobId = job.id || job.jobId || job._id
    if (!jobId) return { content: [{ type: 'text' as const, text: 'Backtest started but no job ID returned.' }] }

    // Poll for results
    const deadline = Date.now() + 120_000
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 3000))
      try {
        const result = await api<any>(`/api/backtests/${jobId}`)
        if (result.status === 'completed') {
          const metrics = extractMetrics(result)
          const end = typeof metrics.totalReturnPercent === 'number'
            ? initialBalance * (1 + metrics.totalReturnPercent / 100)
            : undefined
          return jsonResult({
            status: 'completed', strategy: strategyId, symbol, period,
            metrics,
            equity: { start: initialBalance, end },
          })
        }
        if (result.status === 'failed') {
          return { isError: true, content: [{ type: 'text' as const, text: `Backtest failed: ${result.error || 'unknown error'}` }] }
        }
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) continue
        throw err
      }
    }

    return jsonResult({ status: 'timeout', jobId, message: 'Still running. Use get_backtest_results to check later.' })
  }))

  server.tool('get_backtest_results', 'Check status/results of a previously started backtest.', {
    jobId: z.string().describe('Backtest job ID'),
  }, withErrorHandling(async ({ jobId }) => {
    const result = await api<any>(`/api/backtests/${jobId}`)
    if (result.status === 'completed') {
      return jsonResult({
        status: 'completed',
        metrics: extractMetrics(result),
      })
    }
    return { content: [{ type: 'text' as const, text: `Status: ${result.status || 'pending'}. Try again in a few seconds.` }] }
  }))

  server.tool('export_backtest', 'Get export links for a completed backtest. Returns CSV and PDF download URLs.', {
    id: z.string().describe('Backtest ID'),
  }, withErrorHandling(async ({ id }) => {
    const result = await api<any>(`/api/backtests/${id}`)
    if (result.status !== 'completed') {
      return { content: [{ type: 'text' as const, text: `Backtest ${id} is not completed yet (status: ${result.status || 'unknown'}). Wait for completion before exporting.` }] }
    }
    return jsonResult({
      id,
      status: 'completed',
      metrics: extractMetrics(result),
      exportLinks: {
        csv: `/api/backtests/${id}/export/csv`,
        pdf: `/api/backtests/${id}/export/pdf`,
      },
    })
  }))
}
