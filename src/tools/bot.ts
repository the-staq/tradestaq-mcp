import { z } from 'zod'
import { api, ApiError } from '../api.js'
import { errorResult, jsonResult, withErrorHandling } from '../helpers.js'
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

// Only the fields an agent needs; requestedBy (a user id) is left out.
function stopAfterCloseView(v: any): { enabled: boolean, requestedAt?: string, completedAt?: string } {
  return {
    enabled: v?.enabled === true,
    ...(typeof v?.requestedAt === 'string' ? { requestedAt: v.requestedAt } : {}),
    ...(typeof v?.completedAt === 'string' ? { completedAt: v.completedAt } : {}),
  }
}

// --- get_bot_logs views -------------------------------------------------------
// Every field below is copied by name. Raw worker logs (spin `logs`, live-spin
// `lg`, td.log text) are never passed through: they can hold exchange error
// strings with account details and would flood the agent's context.

const RUN_KINDS = ['skipped_bar', 'skipped_other', 'no_signal', 'signal_queued', 'signal_dropped', 'error'] as const
const LOG_SECTIONS = ['runs', 'spinLogs', 'live'] as const

function capText(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string' || !v) return undefined
  return v.length > max ? `${v.slice(0, max)}…` : v
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

// Drops undefined values so the JSON only carries what the server sent.
function compact<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>
}

function runView(r: any) {
  return compact({
    ts: num(r?.ts),
    k: typeof r?.k === 'string' ? r.k : undefined,
    r: capText(r?.r, 64),
    bar: num(r?.bar),
    px: num(r?.px),
    em: num(r?.em),
    q: num(r?.q),
    dr: num(r?.dr),
    why: Array.isArray(r?.why) ? r.why.slice(0, 10).map((w: unknown) => capText(w, 100)).filter(Boolean) : undefined,
    err: capText(r?.err, 300),
    sk: num(r?.sk),
    ex: capText(r?.ex, 64),
  })
}

function signalsSummary(signals: unknown, count?: unknown) {
  const list = Array.isArray(signals) ? signals : []
  const types = list.map((s: any) => capText(s?.type ?? s?.action, 32)).filter(Boolean).slice(0, 10)
  return { count: num(count) ?? list.length, ...(types.length ? { types } : {}) }
}

function errorMessageOf(e: unknown): string | undefined {
  return capText(typeof e === 'string' ? e : (e as any)?.message, 300)
}

function spinLogView(d: any) {
  return compact({
    status: capText(d?.status, 32),
    createdAt: capText(d?.createdAt, 40),
    spinNumber: num(d?.execution?.spinNumber),
    executionTimeMs: num(d?.execution?.executionTimeMs),
    price: num(d?.marketContext?.price),
    signals: signalsSummary(d?.signals),
    error: errorMessageOf(d?.error),
  })
}

function liveSpinView(s: any) {
  return compact({
    status: capText(s?.status, 32),
    timestamp: num(s?.timestamp) ?? capText(s?.timestamp, 40),
    spinNumber: num(s?.spinNumber),
    executionTimeMs: num(s?.executionTimeMs),
    signals: signalsSummary(s?.signals, s?.signalCount),
    error: errorMessageOf(s?.error),
  })
}

// Numbers only; anything else the server adds is ignored.
function numericFields(o: unknown, keyMax = 64): Record<string, number> | null {
  if (!o || typeof o !== 'object') return null
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    const n = typeof v === 'string' && /^\d+(\.\d+)?$/.test(v) ? Number(v) : num(v)
    if (n !== undefined && /^[A-Za-z0-9_]+$/.test(k) && k.length <= keyMax) out[k] = n
  }
  return out
}

function lastSpinView(v: any) {
  if (!v || typeof v !== 'object') return null
  return compact({
    time: capText(v.time ?? v.lastSpinTime, 40) ?? num(v.time ?? v.lastSpinTime),
    status: capText(v.status, 32),
    lastProcessedCandle: num(v.lastProcessedCandle) ?? capText(v.lastProcessedCandle, 40),
    error: errorMessageOf(v.error),
  })
}

function sectionError(err: unknown) {
  if (err instanceof ApiError) return { code: err.code, message: capText(err.message, 300), retryable: err.retryable }
  return { code: 'INTERNAL_ERROR', message: capText((err as Error)?.message ?? 'Unknown error', 300), retryable: false }
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

  server.tool('get_bot_status', 'Get detailed status, configuration, and live performance for a specific trading bot by ID. Returns its run status, the strategy/symbol/exchange it trades, whether it is paper or live, P&L, win rate, total trades, and risk config (leverage, stop-loss, take-profit). Use it to check how a deployed bot is doing. stopAfterClose.enabled = true means the bot will pause itself once its current position closes (set with update_bot); completedAt is when it last did. Read-only — to stop a bot use stop_bot or update_bot stopAfterClose. Get bot IDs from list_bots.', {
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
      ...(data.stopAfterClose ? { stopAfterClose: stopAfterCloseView(data.stopAfterClose) } : {}),
    })
  }))

  server.tool('get_bot_logs', 'Explain what a strategy bot has been doing run by run: why it did or did not trade, which signals it queued or dropped, and which runs failed. Use it when a bot is not trading as expected, after get_bot_status. Read-only.\n\n' +
    'Sections (pick with `include`):\n' +
    '- runs (default): one entry per bot run, newest first. Fields: ts (run time, ms epoch), k (outcome kind, below), r (reason code, e.g. bar_wait, entry_backoff, timeout), bar (candle open time, ms), px (price), em (signals the strategy emitted), q (orders queued), dr (signals dropped), why (short reason codes for drops/skips), err (error text, truncated), sk (skipped runs folded into this entry since the previous one), ex (exchange). Also pendingSkips (bar_wait skips since the last entry: n, firstAt, lastAt, lastBar), lastSpin, and earlyExits (today\'s count of runs that stopped before saving, by reason code).\n' +
    '- spinLogs (default): stored per-run records: status (success | no_signal | error | timeout), createdAt, spinNumber, executionTimeMs, price, signals {count, types}, error message.\n' +
    '- live: the most recent in-memory runs (status, timestamp, spinNumber, executionTimeMs, signals, error) plus today\'s run summary counts.\n\n' +
    'Outcome kinds (k): skipped_bar = waiting for the next candle close on an on-bar-close bot, normal and not a problem; skipped_other = the run was skipped for another reason (r says why, e.g. the bar was already claimed); no_signal = the strategy ran and wanted no trade; signal_queued = it emitted signals and orders were sent to the executor (q > 0); signal_dropped = it emitted signals but none were queued (why says why, e.g. entry_backoff after rejected orders); error = the run failed (r and err say why, e.g. runtime, timeout).\n\n' +
    'Each section reports its own error if it cannot be loaded, so one failing section does not hide the others. Never returns raw worker log text. Get bot IDs from list_bots.', {
    botId: z.string().describe('The bot ID, obtained from list_bots.'),
    limit: z.number().int().min(1).max(100).default(25).describe('Entries per section, 1-100. Defaults to 25. The live section returns at most 50.'),
    include: z.array(z.enum(LOG_SECTIONS)).min(1).default(['runs', 'spinLogs']).describe('Sections to return: "runs", "spinLogs", "live". Defaults to ["runs", "spinLogs"].'),
    kind: z.array(z.enum(RUN_KINDS)).min(1).optional().describe('Only return runs of these outcome kinds, e.g. ["error", "signal_dropped"]. Applies to the runs section only.'),
  }, { title: 'Get Bot Logs', readOnlyHint: true }, withErrorHandling(async ({ botId, limit, include, kind }) => {
    const id = encodeURIComponent(botId)
    const n = String(limit ?? 25)
    const sections = [...new Set<(typeof LOG_SECTIONS)[number]>(include?.length ? include : ['runs', 'spinLogs'])]

    const fetchers: Record<(typeof LOG_SECTIONS)[number], () => Promise<unknown>> = {
      runs: async () => {
        const params = new URLSearchParams({ limit: n })
        if (kind?.length) params.set('kind', kind.join(','))
        const data = await api<any>(`/api/bots/${id}/runs?${params}`)
        const runs = Array.isArray(data?.runs) ? data.runs : []
        return {
          runs: runs.map(runView),
          pendingSkips: data?.pendingSkips ? compact({
            n: num(data.pendingSkips.n), firstAt: num(data.pendingSkips.firstAt),
            lastAt: num(data.pendingSkips.lastAt), lastBar: num(data.pendingSkips.lastBar),
          }) : null,
          lastSpin: lastSpinView(data?.lastSpin),
          earlyExits: numericFields(data?.earlyExits),
        }
      },
      spinLogs: async () => {
        const data = await api<any>(`/api/bots/${id}/spin-logs?limit=${n}`)
        const docs = Array.isArray(data?.docs) ? data.docs : []
        return compact({ logs: docs.map(spinLogView), total: num(data?.totalDocs), message: capText(data?.message, 200) })
      },
      live: async () => {
        const data = await api<any>(`/api/bots/${id}/live-spins?limit=${n}`)
        const spins = Array.isArray(data?.spins) ? data.spins : []
        return compact({ spins: spins.map(liveSpinView), todaySummary: numericFields(data?.summary), message: capText(data?.message, 200) })
      },
    }

    const settled = await Promise.allSettled(sections.map((s) => fetchers[s]()))
    const out: Record<string, unknown> = { botId }
    settled.forEach((res, i) => {
      out[sections[i]] = res.status === 'fulfilled' ? res.value : { error: sectionError(res.reason) }
    })
    // Nothing loaded: report it as a normal tool error (e.g. bot not found).
    if (settled.every((r) => r.status === 'rejected')) {
      const e = sectionError((settled[0] as PromiseRejectedResult).reason)
      return errorResult(e.code, e.message ?? 'Could not load bot logs', { retryable: e.retryable })
    }
    return jsonResult(out)
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
    'Update a deployed bot\'s risk settings (leverage, position size %, stop loss, take profit), its trade-notification toggle, and/or stopAfterClose (a graceful stop: the bot keeps managing its open position, opens no new entries, and pauses itself once flat; the owner is notified once). For risk or notification changes it fetches the bot\'s current settings first and merges your changes on top — the underlying PATCH endpoint expects full group objects (positionSizing, messaging/manualMessaging), so a naive partial update would silently wipe out any field you didn\'t mention. stopAfterClose is a plain top-level field and needs no fetch. Get bot IDs from list_bots; check current values with get_bot_status first.',
    {
      id: z.string().describe('The bot ID to update, obtained from list_bots.'),
      leverage: z.number().min(1).max(125).optional().describe('New leverage. Omit to leave unchanged.'),
      positionSizePercent: z.number().min(0).max(100).optional().describe('New position size as a percentage of account balance per trade. Omit to leave unchanged.'),
      stopLoss: z.number().optional().describe('New stop loss %. Omit to leave unchanged.'),
      takeProfit: z.number().optional().describe('New take profit %. Omit to leave unchanged.'),
      notifyOnTrade: z.boolean().optional().describe('Whether to send a Telegram notification for each trade this bot executes. Omit to leave unchanged.'),
      stopAfterClose: z.boolean().optional().describe('true: keep managing the open position, open no new entries, pause automatically once flat (immediately if already flat); false: cancel. Only an active bot can be set. Changing the bot\'s status (start_bot/stop_bot) also cancels it. Omit to leave unchanged.'),
    },
    { title: 'Update Bot', readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    withErrorHandling(async ({ id, leverage, positionSizePercent, stopLoss, takeProfit, notifyOnTrade, stopAfterClose }) => {
      const body: Record<string, unknown> = {}
      const parts: string[] = []

      const riskChanged = leverage !== undefined || positionSizePercent !== undefined || stopLoss !== undefined || takeProfit !== undefined
      // Only the grouped fields need the current bot for fetch-and-merge.
      let bot: any = {}
      if (riskChanged || notifyOnTrade !== undefined) {
        const raw = await api<any>(`/api/bots/${id}`)
        bot = raw.doc || raw
      }
      if (riskChanged) {
        const current = bot.positionSizing || { type: 'percentage', value: 10, leverage: 1 }
        const positionSizing = {
          ...current,
          ...(leverage !== undefined ? { leverage } : {}),
          ...(positionSizePercent !== undefined ? { value: positionSizePercent } : {}),
          ...(stopLoss !== undefined ? { stopLoss } : {}),
          ...(takeProfit !== undefined ? { takeProfit } : {}),
        }
        body.positionSizing = positionSizing
        parts.push(`leverage: ${positionSizing.leverage}x`, `position size: ${positionSizing.value}%`)
        if (positionSizing.stopLoss != null) parts.push(`stop loss: ${positionSizing.stopLoss}%`)
        if (positionSizing.takeProfit != null) parts.push(`take profit: ${positionSizing.takeProfit}%`)
      }

      if (notifyOnTrade !== undefined) {
        // Messaging settings live in a different group depending on trigger type
        // (`manualMessaging` for manual bots, `messaging` for webhook/strategy
        // bots) -- same partial-group-wipes-siblings hazard as positionSizing,
        // so fetch-then-merge whichever one this bot actually uses.
        const messagingKey = bot.triggerType === 'manual' ? 'manualMessaging' : 'messaging'
        body[messagingKey] = { ...(bot[messagingKey] || {}), notifyOnTrade }
        parts.push(`notifications: ${notifyOnTrade ? 'on' : 'off'}`)
      }

      if (stopAfterClose !== undefined) body.stopAfterClose = stopAfterClose

      if (!Object.keys(body).length) {
        throw new ApiError(400, 'NO_CHANGES', 'No fields provided to update.', false)
      }

      const res = await api<any>(`/api/bots/${id}`, { method: 'PATCH', body })
      if (stopAfterClose !== undefined) {
        const updated = res?.doc || res || {}
        const status = typeof updated.status === 'string' ? updated.status : undefined
        if (!stopAfterClose) {
          parts.push('stop after close: cancelled')
        } else if (status && status !== 'active') {
          // The server settles synchronously: a bot that was already flat
          // comes back in its resting status in the same response.
          parts.push(`stop after close: the bot was already flat, so it is now ${status}`)
        } else {
          parts.push('stop after close: the bot will keep managing its open position, open no new entries, and pause after its current position closes')
        }
      }
      return { content: [{ type: 'text' as const, text: `Bot ${id} updated. ${parts.join(', ')}` }] }
    }),
  )

  server.tool('start_bot', 'Activate a bot so it starts opening new positions on its next scheduled interval. Newly deployed strategy bots come up in "paused" status by default — this is the step that actually starts them trading (paper or live, depending on the exchange it\'s attached to). Check state first with get_bot_status; find bot IDs with list_bots.', {
    id: z.string().describe('The bot ID to activate, obtained from list_bots.'),
  }, { title: 'Start Bot', readOnlyHint: false, destructiveHint: false, idempotentHint: true }, withErrorHandling(async ({ id }) => {
    await api<any>(`/api/bots/${id}/status`, { method: 'PATCH', body: { status: 'active' } })
    return { content: [{ type: 'text' as const, text: `Bot ${id} activated.` }] }
  }))

  server.tool('stop_bot', 'Stop a running trading bot immediately. The bot stops trading entirely: any positions it currently holds stay open but are left unmanaged (no stop loss / take profit handling, no strategy exits) — close those separately with close_position. For a graceful stop that keeps managing the open position and pauses once it closes, use update_bot with stopAfterClose: true instead. The bot and its config are kept and can be restarted later (with start_bot), so this is a reversible state change, not a delete. Check state first with get_bot_status; find bot IDs with list_bots.', {
    id: z.string().describe('The bot ID to stop, obtained from list_bots.'),
  }, { title: 'Stop Bot', readOnlyHint: false, destructiveHint: false, idempotentHint: true }, withErrorHandling(async ({ id }) => {
    // PUT /api/bots/:id/status doesn't exist -- the route only exports PATCH.
    // A PUT here silently 404s/405s, so stop_bot never actually stopped anything.
    await api<any>(`/api/bots/${id}/status`, { method: 'PATCH', body: { status: 'stopped' } })
    return { content: [{ type: 'text' as const, text: `Bot ${id} stopped. Open positions remain until manually closed.` }] }
  }))

  server.tool('delete_bot', 'Permanently delete a trading bot and its configuration -- irreversible, the bot cannot be recovered after this call. Refuses if the bot still has an open trade recorded (the delete itself doesn\'t close positions, so deleting it now would orphan that trade with nothing left to manage or close it) -- close_position and stop_bot it first. Confirm with the user before calling. Get bot IDs from list_bots.', {
    id: z.string().describe('The bot ID to delete, obtained from list_bots.'),
  }, { title: 'Delete Bot', readOnlyHint: false, destructiveHint: true, idempotentHint: true }, withErrorHandling(async ({ id }) => {
    const raw = await api<any>(`/api/bots/${id}`)
    const bot = raw.doc || raw
    // openTradesCount is computed unconditionally by GET /api/bots/[id]
    // (unlike its `openPosition` field, which is only populated when
    // status === 'error') -- the reliable signal for "does this bot own
    // an open trade right now" regardless of its current status.
    if (bot.openTradesCount) {
      throw new ApiError(409, 'OPEN_POSITION_EXISTS', `Bot ${id} (${bot.name}) still has ${bot.openTradesCount} open trade(s) recorded -- deleting it now would orphan them with no bot left to manage or close them. Close the position first (close_position), then delete.`, false)
    }
    await api<any>(`/api/bots/${id}`, { method: 'DELETE' })
    return { content: [{ type: 'text' as const, text: `Bot ${id} (${bot.name}) permanently deleted.` }] }
  }))

  server.tool('export_bot_trades', 'Export a bot\'s trade history as structured data — every closed trade with entry/exit prices and P&L, plus a performance summary. Use it to review or report on how a specific bot has performed. Read-only. Get bot IDs from list_bots.', {
    id: z.string().describe('The bot ID whose trades to export, obtained from list_bots.'),
    format: z.enum(['summary', 'full']).default('summary').describe('"summary" = performance stats plus recent trades (default); "full" = every trade the bot has made.'),
  }, { title: 'Export Bot Trades', readOnlyHint: true }, withErrorHandling(async ({ id, format }) => {
    const raw = await api<any>(`/api/bots/${id}`)
    const bot = raw.doc || raw
    const ex = primaryExchangeOf(bot)

    // GET /api/trades/history now supports a real botId filter (added
    // alongside this fix). The OLD approach here -- scope by exchangeId,
    // filter to this bot client-side after the page limit was already
    // applied -- silently truncated any bot sharing a busy exchange with
    // other bots: confirmed live, one bot's export returned 36 of its real
    // 665 trade docs, another 37 of 2,490, both undercounting total PnL by
    // over 10x purely because exchange-mates' trades crowded the fixed-size
    // page before this bot's own trades were even reached.
    const fetchLimit = format === 'full' ? 1000 : 20
    const params = new URLSearchParams({ botId: id, limit: String(fetchLimit) })
    const tradesRes = await api<any>(`/api/trades/history?${params}`)
    const tradeList = tradesRes.trades || []
    const totalOnRecord = tradesRes.pagination?.total ?? tradeList.length
    const truncated = totalOnRecord > tradeList.length

    // Computed from what was actually fetched, not the bot document's own
    // stats field -- that field is empty/stale for at least some bots
    // (confirmed: both examples above had no stored stats at all), and a
    // number that doesn't match the trades listed right next to it is
    // exactly the kind of mismatch that caused this bug to look like data
    // corruption instead of a truncated fetch.
    const closingTrades = tradeList.filter((t: any) => t.status !== 'canceled' && typeof t.pnl === 'number')
    const totalPnl = closingTrades.reduce((sum: number, t: any) => sum + (t.pnl || 0), 0)
    const winningTrades = closingTrades.filter((t: any) => (t.pnl || 0) > 0).length

    const result: any = {
      bot: {
        id: bot.id || bot._id, name: bot.name, symbol: bot.symbol, status: bot.status,
        isPaper: ex ? !!ex.isPaper : undefined,
      },
      stats: {
        totalPnl,
        totalTrades: closingTrades.length,
        winningTrades,
        winRate: closingTrades.length ? (winningTrades / closingTrades.length) * 100 : undefined,
      },
      tradeCount: tradeList.length,
      ...(truncated ? {
        truncated: true,
        totalTradesOnRecord: totalOnRecord,
        warning: `Only the ${tradeList.length} most recent of ${totalOnRecord} total trades are included below -- the stats above reflect only this partial set, not the bot's full history. Ask for a narrower time range or treat totalPnl as a lower/upper bound only.`,
      } : {}),
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
