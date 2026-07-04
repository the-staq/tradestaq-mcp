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

  server.tool('get_bot_status', 'Get detailed status, configuration, and live performance for a specific trading bot by ID. Returns its run status, the strategy/symbol/exchange it trades, whether it is paper or live, P&L, win rate, total trades, and risk config (leverage, stop-loss, take-profit). Use it to check how a deployed bot is doing. Read-only — to stop a bot use stop_bot. Get bot IDs from list_bots.', {
    id: z.string().describe('The bot ID to inspect, obtained from list_bots.'),
  }, { title: 'Get Bot Status', readOnlyHint: true }, withErrorHandling(async ({ id }) => {
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

  server.tool('stop_bot', 'Stop a running trading bot so it stops opening new positions. Any positions it currently holds stay open — close those separately with close_position. The bot and its config are kept and can be restarted later, so this is a reversible state change, not a delete. Check state first with get_bot_status; find bot IDs with list_bots.', {
    id: z.string().describe('The bot ID to stop, obtained from list_bots.'),
  }, { title: 'Stop Bot', readOnlyHint: false, destructiveHint: false, idempotentHint: true }, withErrorHandling(async ({ id }) => {
    await api<any>(`/api/bots/${id}/status`, { method: 'PUT', body: { status: 'stopped' } })
    return { content: [{ type: 'text' as const, text: `Bot ${id} stopped. Open positions remain until manually closed.` }] }
  }))

  server.tool('export_bot_trades', 'Export a bot\'s trade history as structured data — every closed trade with entry/exit prices and P&L, plus a performance summary. Use it to review or report on how a specific bot has performed. Read-only. Get bot IDs from list_bots.', {
    id: z.string().describe('The bot ID whose trades to export, obtained from list_bots.'),
    format: z.enum(['summary', 'full']).default('summary').describe('"summary" = performance stats plus recent trades (default); "full" = every trade the bot has made.'),
  }, { title: 'Export Bot Trades', readOnlyHint: true }, withErrorHandling(async ({ id, format }) => {
    // Get bot details
    const bot = await api<any>(`/api/bots/${id}`)
    // Get trade history
    const trades = await api<any>(`/api/trades/history?botId=${id}&limit=${format === 'full' ? 200 : 20}`)
    const tradeList = trades.trades || trades || []

    const result: any = {
      bot: {
        id: bot.id || bot._id,
        name: bot.name,
        symbol: bot.symbol,
        status: bot.status,
        isPaper: bot.paperTrading,
      },
      stats: bot.stats || {},
      tradeCount: Array.isArray(tradeList) ? tradeList.length : 0,
      trades: Array.isArray(tradeList) ? tradeList.map((t: any) => ({
        symbol: t.symbol, side: t.side,
        entryPrice: t.entryPrice, exitPrice: t.exitPrice,
        pnl: t.pnl, size: t.size, leverage: t.leverage,
        status: t.status, openedAt: t.openedAt, closedAt: t.closedAt,
      })) : [],
      exportLinks: {
        csv: `/api/bots/${id}/export/csv`,
        pdf: `/api/bots/${id}/export/pdf`,
      },
    }

    return jsonResult(result)
  }))

  server.tool('close_position', 'Close an open trading position by placing a market order — fully or partially. This moves real money when the position is live, so confirm intent with the user before calling. Find the tradeId, exchangeId, and symbol with get_positions. Set percentage below 100 for a partial close.', {
    tradeId: z.string().describe('The trade/position ID to close, obtained from get_positions.'),
    exchangeId: z.string().describe('The exchange account ID where the position is open, from get_positions or list_exchanges.'),
    symbol: z.string().describe('Trading pair of the position, e.g. "BTC/USDT".'),
    percentage: z.number().min(1).max(100).default(100).describe('Percentage of the position to close, 1-100. 100 = full close (default); e.g. 50 closes half.'),
  }, { title: 'Close Position', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }, withErrorHandling(async ({ tradeId, exchangeId, symbol, percentage }) => {
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
