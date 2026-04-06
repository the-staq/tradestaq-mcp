import { z } from 'zod'
import { api, ApiError } from '../api.js'
import { jsonResult, withErrorHandling } from '../helpers.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

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

    const name = `MCP Backtest ${symbol} ${period}`
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
        if (result.status === 'completed' || result.results) {
          const r = result.results || result
          return jsonResult({
            status: 'completed', strategy: strategyId, symbol, period,
            metrics: { roi: r.roi, totalPnl: r.totalPnl, maxDrawdown: r.maxDrawdown, winRate: r.winRate, sharpeRatio: r.sharpeRatio, profitFactor: r.profitFactor, totalTrades: r.totalTrades },
            equity: { start: initialBalance, end: r.finalBalance || r.equity },
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
    if (result.status === 'completed' || result.results) {
      const r = result.results || result
      return jsonResult({
        status: 'completed',
        metrics: { roi: r.roi, totalPnl: r.totalPnl, maxDrawdown: r.maxDrawdown, winRate: r.winRate, sharpeRatio: r.sharpeRatio, totalTrades: r.totalTrades },
      })
    }
    return { content: [{ type: 'text' as const, text: `Status: ${result.status || 'pending'}. Try again in a few seconds.` }] }
  }))
}
