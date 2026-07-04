import { z } from 'zod'
import { api } from '../api.js'
import { jsonResult, withErrorHandling } from '../helpers.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

export function registerTradeTools(server: McpServer) {

  server.tool('get_trade_history', 'Get the user\'s closed trade history across exchanges — entry/exit prices, P&L, and holding duration per trade, with pagination. Use it to review past trades or answer questions about specific fills. Read-only. For aggregate metrics (ROI, win rate, Sortino) use get_performance_metrics instead.', {
    exchange: z.string().optional().describe('Optional filter by exchange name, e.g. "binance". Omit for all exchanges.'),
    symbol: z.string().optional().describe('Optional filter by trading pair, e.g. "BTC/USDT". Omit for all pairs.'),
    limit: z.number().default(50).describe('Number of trades to return, max 200. Defaults to 50.'),
    page: z.number().default(1).describe('Page number for pagination (1-based). Defaults to 1.'),
  }, { title: 'Get Trade History', readOnlyHint: true }, withErrorHandling(async ({ exchange, symbol, limit, page }) => {
    const params = new URLSearchParams()
    if (exchange) params.set('exchange', exchange)
    if (symbol) params.set('symbol', symbol)
    params.set('limit', String(Math.min(limit, 200)))
    params.set('page', String(page))
    const data = await api<any>(`/api/trades/history?${params}`)
    const trades = data.trades || data || []
    if (!Array.isArray(trades) || !trades.length) return { content: [{ type: 'text' as const, text: 'No closed trades found.' }] }
    return jsonResult(trades.map((t: any) => ({
      id: t.id, symbol: t.symbol, side: t.side,
      entryPrice: t.entryPrice, exitPrice: t.exitPrice,
      pnl: t.pnl, pnlPercent: t.pnlPercent,
      size: t.size, leverage: t.leverage,
      exchange: t.exchange, status: t.status,
      openedAt: t.openedAt, closedAt: t.closedAt,
    })))
  }))

  server.tool('get_performance_metrics', 'Get aggregate trading performance metrics over a time range: ROI, win rate, total P&L, and Sortino ratio. Use it to summarize how the user (or a subset of their trading) is performing. Read-only. For a list of individual trades use get_trade_history.', {
    timeRange: z.enum(['today', '7d', '30d', '90d']).default('30d').describe('Window for the metrics: today, 7d, 30d, or 90d. Defaults to 30d.'),
    tradeType: z.enum(['live', 'paper']).optional().describe('Optional filter: "live" or "paper" trades only. Omit to include both.'),
    exchangeId: z.string().optional().describe('Optional filter to a single exchange account ID (from list_exchanges). Omit for all.'),
  }, { title: 'Get Performance Metrics', readOnlyHint: true }, withErrorHandling(async ({ timeRange, tradeType, exchangeId }) => {
    const params = new URLSearchParams()
    params.set('timeRange', timeRange)
    if (tradeType) params.set('tradeType', tradeType)
    if (exchangeId) params.set('exchangeId', exchangeId)
    const data = await api<any>(`/api/trades/metrics?${params}`)
    return jsonResult(data)
  }))
}
