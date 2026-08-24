import { z } from 'zod'
import { api, ApiError } from '../api.js'
import { jsonResult, withErrorHandling } from '../helpers.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

// The Bots collection has NO top-level isPaper/paperTrading field -- whether a
// bot trades real money is determined entirely by the isPaper flag on the
// exchange(s) it's attached to (GET /api/bots enriches each bot with a
// populated `exchanges` array). Every tool below reads paper status from
// there, never from a bot-level field that doesn't exist.
function primaryExchangeOf(bot: any): any {
  return (bot.exchanges || [])[0]
}

function strategyNameOf(bot: any): string | undefined {
  if (bot.strategyDetails?.name) return bot.strategyDetails.name
  if (typeof bot.strategy === 'object' && bot.strategy) return bot.strategy.name
  return typeof bot.strategy === 'string' ? bot.strategy : undefined
}

export function registerBotTools(server: McpServer) {

  server.tool('list_bots', 'List all your trading bots with status and performance.', {}, withErrorHandling(async () => {
    const data = await api<any>('/api/bots')
    const bots = data.docs || data.bots || []
    if (!bots.length) return { content: [{ type: 'text' as const, text: 'No trading bots. Use deploy_bot to create one.' }] }
    return jsonResult(bots.map((b: any) => {
      const ex = primaryExchangeOf(b)
      return {
        id: b.id || b._id, name: b.name, status: b.status,
        strategy: strategyNameOf(b), symbol: b.symbol,
        exchange: ex?.accountLabel || ex?.name,
        isPaper: ex ? !!ex.isPaper : undefined,
        pnl: b.stats?.totalPnl,
      }
    }))
  }))

  server.tool('get_bot_status', 'Get detailed status, configuration, and live performance for a specific trading bot by ID. Returns its run status, the strategy/symbol/exchange it trades, whether it is paper or live, P&L, win rate, total trades, and risk config (leverage, stop-loss, take-profit). Use it to check how a deployed bot is doing. Read-only — to stop a bot use stop_bot. Get bot IDs from list_bots.', {
    id: z.string().describe('The bot ID to inspect, obtained from list_bots.'),
  }, { title: 'Get Bot Status', readOnlyHint: true }, withErrorHandling(async ({ id }) => {
    const raw = await api<any>(`/api/bots/${id}`)
    const data = raw.doc || raw
    const ex = primaryExchangeOf(data)
    const stats = data.stats || {}
    return jsonResult({
      id: data.id || data._id, name: data.name, status: data.status,
      strategy: strategyNameOf(data), symbol: data.symbol,
      exchange: ex?.accountLabel || ex?.name,
      isPaper: ex ? !!ex.isPaper : undefined,
      createdAt: data.createdAt,
      performance: {
        pnl: stats.totalPnl,
        winRate: stats.totalTrades ? (stats.winningTrades / stats.totalTrades) * 100 : undefined,
        totalTrades: stats.totalTrades,
        thirtyDayReturn: data.thirtyDayReturn,
      },
      config: {
        leverage: data.positionSizing?.leverage,
        stopLoss: data.positionSizing?.stopLoss,
        takeProfit: data.positionSizing?.takeProfit,
      },
      openPosition: data.openPosition,
    })
  }))

  server.tool(
    'deploy_bot',
    'Deploy a strategy as a trading bot. Defaults to paper trading for safety — whether a bot trades real money is determined entirely by the exchange account it\'s attached to (not by the `live` flag alone), so this refuses to deploy if `live` doesn\'t match the target exchange\'s own paper/live status. Check an exchange\'s status with list_exchanges first, or create one with create_paper_exchange.',
    {
      strategyId: z.string().describe('Strategy ID to deploy'),
      exchangeId: z.string().describe('Exchange account ID. Its own isPaper status (see list_exchanges) determines whether this bot trades real money — must match the `live` flag below.'),
      symbol: z.string().default('BTC/USDT'),
      market: z.enum(['spot', 'futures']).optional().describe('Market type. Omit to use the account default (spot).'),
      name: z.string().optional(),
      live: z.boolean().default(false).describe('Must match the target exchange\'s own paper/live status: false requires a paper exchange, true requires a live one. Defaults to false (paper) for safety.'),
      positionSizePercent: z.number().min(0).max(100).default(10).describe('Position size as a percentage of account balance per trade. Defaults to 10%.'),
      leverage: z.number().min(1).max(125).default(1),
      stopLoss: z.number().optional().describe('Stop loss % (e.g. 5)'),
      takeProfit: z.number().optional().describe('Take profit % (e.g. 10)'),
    },
    withErrorHandling(async ({ strategyId, exchangeId, symbol, market, name, live, positionSizePercent, leverage, stopLoss, takeProfit }) => {
      // The server enforces paper/live via OAuth scope tied to the target
      // exchange's real isPaper flag, but that surfaces as an opaque 403.
      // Check up front so a mismatch fails with an actionable message instead.
      const exchangesData = await api<any>('/api/exchanges')
      const exchanges = exchangesData.exchanges || exchangesData.docs || []
      const targetExchange = exchanges.find((e: any) => (e.id || e._id) === exchangeId)
      if (!targetExchange) {
        throw new ApiError(404, 'EXCHANGE_NOT_FOUND', `Exchange ${exchangeId} not found. Use list_exchanges to find a valid ID.`, false)
      }
      const exchangeIsPaper = !!targetExchange.isPaper
      if (live === exchangeIsPaper) {
        throw new ApiError(
          400,
          'PAPER_LIVE_MISMATCH',
          `live:${live} was requested but exchange "${targetExchange.name}" (${exchangeId}) is a ${exchangeIsPaper ? 'PAPER' : 'LIVE'} account. ` +
          `A bot's paper/live status is determined entirely by the exchange it's attached to, not by this flag. ` +
          (live
            ? 'Pick a live (non-paper) exchange from list_exchanges.'
            : 'Pick a paper exchange from list_exchanges (isPaper: true), or create one with create_paper_exchange.'),
          false,
        )
      }

      const data = await api<any>('/api/bots', {
        method: 'POST',
        body: {
          triggerType: 'strategy',
          strategy: strategyId,
          exchange: [exchangeId],
          symbol,
          name,
          ...(market ? { market } : {}),
          positionSizing: {
            type: 'percentage',
            value: positionSizePercent,
            leverage,
            ...(stopLoss !== undefined ? { stopLoss } : {}),
            ...(takeProfit !== undefined ? { takeProfit } : {}),
          },
        },
      })
      const bot = data.doc || data
      const mode = exchangeIsPaper ? 'PAPER (simulated)' : 'LIVE'
      return {
        content: [{
          type: 'text' as const,
          text: `Bot deployed in ${mode} mode on ${targetExchange.name}.\nID: ${bot.id || bot._id}\nSymbol: ${symbol}\nLeverage: ${leverage}x\n${exchangeIsPaper ? 'Paper trading. No real money at risk.' : '\nThis bot is trading with REAL money.'}`,
        }],
      }
    }),
  )

  server.tool(
    'update_bot',
    'Update a deployed bot\'s risk settings: leverage, position size (% of balance), stop loss, or take profit. Fetches the bot\'s current settings first and merges your changes on top — the underlying PATCH endpoint expects the full positionSizing object, so a naive partial update would silently wipe out any field you didn\'t mention. Get bot IDs from list_bots; check current values with get_bot_status first.',
    {
      id: z.string().describe('The bot ID to update, obtained from list_bots.'),
      leverage: z.number().min(1).max(125).optional().describe('New leverage. Omit to leave unchanged.'),
      positionSizePercent: z.number().min(0).max(100).optional().describe('New position size as a percentage of account balance per trade. Omit to leave unchanged.'),
      stopLoss: z.number().optional().describe('New stop loss %. Omit to leave unchanged.'),
      takeProfit: z.number().optional().describe('New take profit %. Omit to leave unchanged.'),
    },
    { title: 'Update Bot', readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    withErrorHandling(async ({ id, leverage, positionSizePercent, stopLoss, takeProfit }) => {
      const raw = await api<any>(`/api/bots/${id}`)
      const current = (raw.doc || raw).positionSizing || { type: 'percentage', value: 10, leverage: 1 }
      const positionSizing = {
        ...current,
        ...(leverage !== undefined ? { leverage } : {}),
        ...(positionSizePercent !== undefined ? { value: positionSizePercent } : {}),
        ...(stopLoss !== undefined ? { stopLoss } : {}),
        ...(takeProfit !== undefined ? { takeProfit } : {}),
      }
      await api<any>(`/api/bots/${id}`, { method: 'PATCH', body: { positionSizing } })
      return { content: [{ type: 'text' as const, text: `Bot ${id} updated. leverage: ${positionSizing.leverage}x, position size: ${positionSizing.value}%${positionSizing.stopLoss != null ? `, stop loss: ${positionSizing.stopLoss}%` : ''}${positionSizing.takeProfit != null ? `, take profit: ${positionSizing.takeProfit}%` : ''}` }] }
    }),
  )

  server.tool('start_bot', 'Activate a bot so it starts opening new positions on its next scheduled interval. Newly deployed strategy bots come up in "paused" status by default — this is the step that actually starts them trading (paper or live, depending on the exchange it\'s attached to). Check state first with get_bot_status; find bot IDs with list_bots.', {
    id: z.string().describe('The bot ID to activate, obtained from list_bots.'),
  }, { title: 'Start Bot', readOnlyHint: false, destructiveHint: false, idempotentHint: true }, withErrorHandling(async ({ id }) => {
    await api<any>(`/api/bots/${id}/status`, { method: 'PATCH', body: { status: 'active' } })
    return { content: [{ type: 'text' as const, text: `Bot ${id} activated.` }] }
  }))

  server.tool('stop_bot', 'Stop a running trading bot so it stops opening new positions. Any positions it currently holds stay open — close those separately with close_position. The bot and its config are kept and can be restarted later (with start_bot), so this is a reversible state change, not a delete. Check state first with get_bot_status; find bot IDs with list_bots.', {
    id: z.string().describe('The bot ID to stop, obtained from list_bots.'),
  }, { title: 'Stop Bot', readOnlyHint: false, destructiveHint: false, idempotentHint: true }, withErrorHandling(async ({ id }) => {
    // PUT /api/bots/:id/status doesn't exist -- the route only exports PATCH.
    // A PUT here silently 404s/405s, so stop_bot never actually stopped anything.
    await api<any>(`/api/bots/${id}/status`, { method: 'PATCH', body: { status: 'stopped' } })
    return { content: [{ type: 'text' as const, text: `Bot ${id} stopped. Open positions remain until manually closed.` }] }
  }))

  server.tool('export_bot_trades', 'Export a bot\'s trade history as structured data — every closed trade with entry/exit prices and P&L, plus a performance summary. Use it to review or report on how a specific bot has performed. Read-only. Get bot IDs from list_bots.', {
    id: z.string().describe('The bot ID whose trades to export, obtained from list_bots.'),
    format: z.enum(['summary', 'full']).default('summary').describe('"summary" = performance stats plus recent trades (default); "full" = every trade the bot has made.'),
  }, { title: 'Export Bot Trades', readOnlyHint: true }, withErrorHandling(async ({ id, format }) => {
    const raw = await api<any>(`/api/bots/${id}`)
    const bot = raw.doc || raw
    const ex = primaryExchangeOf(bot)

    // GET /api/trades/history has no botId filter at all -- it only supports
    // exchangeId/symbol/page/limit. Scope by the bot's own exchange server-side
    // (narrows the fetch) and filter to this bot's own trades client-side
    // (the route's .lean() docs carry the real `bot` field), since otherwise
    // this would silently return every trade across every bot on that exchange.
    const params = new URLSearchParams({ limit: String(format === 'full' ? 200 : 20) })
    if (ex) params.set('exchangeId', String(ex.id || ex._id))
    const trades = await api<any>(`/api/trades/history?${params}`)
    const tradeList = (trades.trades || []).filter((t: any) => String(t.bot) === id)

    const result: any = {
      bot: {
        id: bot.id || bot._id, name: bot.name, symbol: bot.symbol, status: bot.status,
        isPaper: ex ? !!ex.isPaper : undefined,
      },
      stats: bot.stats || {},
      tradeCount: tradeList.length,
      trades: tradeList.map((t: any) => ({
        symbol: t.symbol, side: t.side,
        entryPrice: t.entryPrice, exitPrice: t.exitPrice,
        pnl: t.pnl, size: t.size, leverage: t.leverage,
        status: t.status, openedAt: t.openedAt, closedAt: t.closedAt,
      })),
      exportLinks: {
        csv: `/api/bots/${id}/export/csv`,
        pdf: `/api/bots/${id}/export/pdf`,
      },
    }

    return jsonResult(result)
  }))

  server.tool('close_position', 'Close an open trading position by placing a market order — fully or partially. This moves real money when the position is live, so confirm intent with the user before calling. Find the exchangeId, symbol, and side with get_positions. Set percentage below 100 for a partial close.', {
    exchangeId: z.string().describe('The exchange account ID where the position is open, from get_positions or list_exchanges.'),
    symbol: z.string().describe('Trading pair of the position, e.g. "BTC/USDT".'),
    side: z.enum(['long', 'short']).describe('Position side, from get_positions.'),
    percentage: z.number().min(1).max(100).default(100).describe('Percentage of the position to close, 1-100. 100 = full close (default); e.g. 50 closes half.'),
  }, { title: 'Close Position', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }, withErrorHandling(async ({ exchangeId, symbol, side, percentage }) => {
    // The close endpoint takes an ABSOLUTE size, not a percentage -- resolve
    // the position's real size first so a 50% request actually closes half
    // the position instead of being misread as "close 50 units."
    const positionsData = await api<any>(`/api/v1/positions`)
    const position = (positionsData.positions || []).find(
      // UserPosition has both `exchange` (platform name, e.g. "binance") and
      // `exchangeId` (the actual account id) -- match on the id, not the name.
      (p: any) => String(p.exchangeId) === String(exchangeId) && p.symbol === symbol && p.side === side,
    )
    if (!position) {
      throw new ApiError(404, 'POSITION_NOT_FOUND', `No open ${side} position for ${symbol} on exchange ${exchangeId}. Use get_positions to see what's actually open.`, false)
    }
    const size = position.size * (percentage / 100)

    const data = await api<any>('/api/positions/close', {
      method: 'POST',
      body: { exchangeId, symbol, side, size },
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
