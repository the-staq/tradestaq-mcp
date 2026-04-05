import { z } from 'zod'
import { api } from '../api.js'
import { jsonResult, withErrorHandling } from '../helpers.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

export function registerBotTools(server: McpServer) {

  server.tool('list_bots', 'List all your trading bots with status and performance.', {}, withErrorHandling(async () => {
    const data = await api<any>('/api/bots')
    const bots = data.bots || data.docs || []
    if (!bots.length) return { content: [{ type: 'text' as const, text: 'No trading bots. Use deploy_bot to create one.' }] }
    return jsonResult(bots.map((b: any) => ({
      id: b.id || b._id, name: b.name, status: b.status,
      strategy: b.strategyName || b.strategy, symbol: b.symbol,
      exchange: b.exchangeName, isPaper: b.paperTrading, pnl: b.pnl,
    })))
  }))

  server.tool('get_bot_status', 'Get detailed status and performance for a specific bot.', {
    id: z.string().describe('Bot ID'),
  }, withErrorHandling(async ({ id }) => {
    const data = await api<any>(`/api/bots/${id}`)
    return jsonResult({
      id: data.id || data._id, name: data.name, status: data.status,
      strategy: data.strategyName, symbol: data.symbol, exchange: data.exchangeName,
      isPaper: data.paperTrading, createdAt: data.createdAt,
      performance: { pnl: data.pnl, winRate: data.winRate, totalTrades: data.totalTrades },
      config: { leverage: data.leverage, stopLoss: data.stopLoss, takeProfit: data.takeProfit },
    })
  }))

  server.tool(
    'deploy_bot',
    'Deploy a strategy as a trading bot. Defaults to paper trading for safety.',
    {
      strategyId: z.string().describe('Strategy ID to deploy'),
      exchangeId: z.string().describe('Exchange account ID'),
      symbol: z.string().default('BTC/USDT'),
      name: z.string().optional(),
      live: z.boolean().default(false).describe('If true, trades with real money. Defaults to paper.'),
      leverage: z.number().min(1).max(20).default(1),
      stopLoss: z.number().optional().describe('Stop loss % (e.g. 5)'),
      takeProfit: z.number().optional().describe('Take profit % (e.g. 10)'),
    },
    withErrorHandling(async ({ strategyId, exchangeId, symbol, name, live, leverage, stopLoss, takeProfit }) => {
      const data = await api<any>('/api/bots', {
        method: 'POST',
        body: { strategyId, exchangeId, symbol, name, paperTrading: !live, leverage, stopLoss, takeProfit },
      })
      const mode = live ? 'LIVE' : 'PAPER (simulated)'
      return {
        content: [{
          type: 'text' as const,
          text: `Bot deployed in ${mode} mode.\nID: ${data.id || data._id}\nSymbol: ${symbol}\nLeverage: ${leverage}x\n${live ? '\nThis bot is trading with REAL money.' : '\nPaper trading. No real money at risk.'}`,
        }],
      }
    }),
  )

  server.tool('stop_bot', 'Stop a running trading bot. Open positions remain.', {
    id: z.string().describe('Bot ID to stop'),
  }, withErrorHandling(async ({ id }) => {
    await api<any>(`/api/bots/${id}/status`, { method: 'PUT', body: { status: 'stopped' } })
    return { content: [{ type: 'text' as const, text: `Bot ${id} stopped. Open positions remain until manually closed.` }] }
  }))

  server.tool('close_position', 'Close an open trading position. WARNING: This executes a market order to close your position.', {
    tradeId: z.string().describe('Trade/position ID to close'),
    exchangeId: z.string().describe('Exchange account ID where the position is open'),
    symbol: z.string().describe('Trading pair (e.g. BTC/USDT)'),
    percentage: z.number().min(1).max(100).default(100).describe('Percentage of position to close (100 = full close)'),
  }, withErrorHandling(async ({ tradeId, exchangeId, symbol, percentage }) => {
    const data = await api<any>('/api/positions/close', {
      method: 'POST',
      body: { tradeId, exchangeId, symbol, size: String(percentage) },
    })
    const pnl = data.pnl ?? data.body?.pnl
    return {
      content: [{
        type: 'text' as const,
        text: `Position closed${percentage < 100 ? ` (${percentage}%)` : ''}.\nSymbol: ${symbol}\n${pnl != null ? `PnL: ${pnl}` : ''}\n\nUse get_positions to verify.`,
      }],
    }
  }))
}
