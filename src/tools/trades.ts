import { z } from 'zod'
import { api } from '../api.js'
import { jsonResult, withErrorHandling } from '../helpers.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

export function registerTradeTools(server: McpServer) {

  server.tool('get_trade_history', 'Get your closed trade history with PnL, entry/exit prices, and duration.', {
    exchange: z.string().optional().describe('Filter by exchange name'),
    symbol: z.string().optional().describe('Filter by trading pair symbol'),
    limit: z.number().default(50).describe('Number of trades to return (max 200)'),
    page: z.number().default(1).describe('Page number for pagination'),
  }, withErrorHandling(async ({ exchange, symbol, limit, page }) => {
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

  server.tool('get_performance_metrics', 'Get trading performance metrics: ROI, win rate, PnL, Sortino ratio.', {
    timeRange: z.enum(['today', '7d', '30d', '90d']).default('30d').describe('Time range for metrics'),
    tradeType: z.enum(['live', 'paper']).optional().describe('Filter by trade type'),
    exchangeId: z.string().optional().describe('Filter by exchange ID'),
  }, withErrorHandling(async ({ timeRange, tradeType, exchangeId }) => {
    const params = new URLSearchParams()
    params.set('timeRange', timeRange)
    if (tradeType) params.set('tradeType', tradeType)
    if (exchangeId) params.set('exchangeId', exchangeId)
    const data = await api<any>(`/api/trades/metrics?${params}`)
    return jsonResult(data)
  }))
}
