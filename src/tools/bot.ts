import { randomUUID } from 'node:crypto'
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

// A write sent with retry: false that got no answer: it timed out, never reached the server
// or the server/gateway failed (5xx, e.g. a Cloudflare 524 while the server kept working).
// The action may have been carried out. Returns a short reason, or undefined for a clean answer.
function noAnswerReason(err: unknown): string | undefined {
  if (!(err instanceof ApiError)) return undefined
  if (err.status === 408 || err.code === 'TIMEOUT') return 'the request timed out'
  if (err.status === 0 || err.code === 'NETWORK_ERROR') return 'a network error'
  if (err.status >= 500) return `HTTP ${err.status}`
  return undefined
}

// Server answers (503) that say the close was refused before anything was sent: the
// close lock could not be taken, or the exchange leg could not be read. Not "no answer".
const CLOSE_NOTHING_SENT_CODES = new Set(['CLOSE_LOCK_UNAVAILABLE', 'POSITION_UNREADABLE'])

// close_position errors after which the close may have executed. Each says to check
// get_positions first and is never retryable: a blind second close_position call could close
// the position again (50% twice is 100%; a spot resend sells coins outside the lots).
function closeMayHaveRunResult(err: unknown, position: string) {
  if (!(err instanceof ApiError)) return undefined
  if (err.code === 'CLOSE_IN_PROGRESS') {
    return errorResult('CLOSE_IN_PROGRESS', `Another close of the ${position} position is already running and may already have executed. Do not retry now: check get_positions before closing it again.`)
  }
  if (err.code === 'CLOSE_UNCONFIRMED') {
    return errorResult('CLOSE_UNCONFIRMED', `The close order for the ${position} position was sent, but its outcome could not be confirmed: it may have executed on the exchange. Check get_positions before retrying; never retry it blindly.`, { fields: { closedOnExchange: 'maybe' } })
  }
  // The server answered that it sent nothing (its own 503s): its code and message stand.
  if (CLOSE_NOTHING_SENT_CODES.has(err.code)) return undefined
  const reason = noAnswerReason(err)
  if (reason) {
    return errorResult('CLOSE_OUTCOME_UNKNOWN', `The close request for the ${position} position got no answer (${reason}), so the close may have executed on the exchange. Check get_positions before retrying: do not call close_position again for it until you have.`, { fields: { closedOnExchange: 'maybe' } })
  }
  return undefined
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
    sn: num(r?.sn),
    k: typeof r?.k === 'string' && (RUN_KINDS as readonly string[]).includes(r.k) ? r.k : undefined,
    r: capText(r?.r, 80),
    bar: num(r?.bar),
    px: num(r?.px),
    em: num(r?.em),
    q: num(r?.q),
    dr: num(r?.dr),
    why: Array.isArray(r?.why) ? r.why.slice(0, 10).map((w: unknown) => capText(w, 100)).filter(Boolean) : undefined,
    err: capText(r?.err, 300),
    ms: num(r?.ms),
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
    // The worker's run outcome (live-spin `oc`, served as `outcome`); absent on older entries.
    outcome: s?.outcome && typeof s.outcome === 'object' ? runView(s.outcome) : undefined,
  })
}

// Numbers only; anything else the server adds is ignored.
function numericFields(o: unknown, keyMax = 64): Record<string, number> | null {
  if (!o || typeof o !== 'object') return null
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    const n = typeof v === 'string' && /^\d+(\.\d+)?$/.test(v) ? Number(v) : num(v)
    if (n !== undefined && /^[A-Za-z0-9_:.-]+$/.test(k) && k.length <= keyMax) out[k] = n
  }
  return out
}

// /runs `earlyExits`: { yyyymmdd: { reasonCode: count } } (today + yesterday, UTC).
function earlyExitsView(o: unknown): Record<string, Record<string, number>> | null {
  if (!o || typeof o !== 'object') return null
  const out: Record<string, Record<string, number>> = {}
  for (const [day, counts] of Object.entries(o as Record<string, unknown>).slice(0, 7)) {
    if (!/^\d{8}$/.test(day)) continue
    const n = numericFields(counts, 80)
    if (n && Object.keys(n).length) out[day] = n
  }
  return out
}

// /runs `lastSpin`: { at, status, nextAt, lastProcessedCandle } (dates as ISO strings).
function lastSpinView(v: any) {
  if (!v || typeof v !== 'object') return null
  return compact({
    at: capText(v.at, 40) ?? num(v.at),
    status: capText(v.status, 32),
    nextAt: capText(v.nextAt, 40) ?? num(v.nextAt),
    lastProcessedCandle: num(v.lastProcessedCandle) ?? capText(v.lastProcessedCandle, 40),
  })
}

function sectionError(err: unknown) {
  const e: { code: string, message?: string, retryable: boolean, retryAfterMs?: number } = err instanceof ApiError
    ? { code: err.code, message: capText(err.message, 300), retryable: err.retryable }
    : { code: 'INTERNAL_ERROR', message: capText((err as Error)?.message ?? 'Unknown error', 300), retryable: false }
  if (err instanceof ApiError && err.retryable && err.retryAfterMs !== undefined) e.retryAfterMs = err.retryAfterMs
  return e
}

// --- update_bot helpers --------------------------------------------------------

const OBJECT_ID_RE = /^[0-9a-f]{24}$/i
const VERSION_CHANNELS = ['stable', 'beta', 'latest', 'custom'] as const
const EXECUTION_MODES = ['on_bar_close', 'continuous'] as const
// Strategy parameter names as strategies declare them (e.g. ENABLE_SHORTS, rsiPeriod).
const PARAM_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const PARAM_VALUE = z.union([
  z.number(), z.string().max(200), z.boolean(), z.null(),
  z.array(z.union([z.number(), z.string().max(100)])).max(50),
])
const MAX_OVERRIDES_SHOWN = 40
const FLAT_HINT = 'Pause it first with update_bot stopAfterClose:true (it keeps managing the position, opens nothing new and pauses once flat), wait until get_bot_status shows no openPosition, then retry.'

/** An id from a string, an ObjectId-like or a populated doc ({ id } / { _id } / { value }). */
function idOf(v: unknown): string {
  if (!v) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'object') return String((v as any).id ?? (v as any)._id ?? (v as any).value ?? '')
  return String(v)
}

/** A strategy ID as given, or a slug resolved through the strategy route (it takes either). */
async function resolveStrategyRef(ref: string): Promise<{ id: string, name?: string }> {
  const value = ref.trim()
  if (OBJECT_ID_RE.test(value)) return { id: value }
  const notFound = () => new ApiError(404, 'STRATEGY_NOT_FOUND', `No strategy "${value}" that you can deploy. Use list_strategies for IDs, or pass the strategy's exact slug.`, false)
  let raw: any
  try {
    raw = await api<any>(`/api/tradedroid/strategies/${encodeURIComponent(value)}`)
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 403)) throw notFound()
    throw err
  }
  const doc = raw?.doc || raw
  const id = idOf(doc)
  if (!OBJECT_ID_RE.test(id)) throw notFound()
  const name = capText(doc?.name, 80)
  return { id, ...(name ? { name } : {}) }
}

/** GET /api/bots/:id's open-position facts: openTradesCount (open lots) and openPosition (largest leg). */
function holdsPosition(bot: any): boolean {
  return (typeof bot?.openTradesCount === 'number' && bot.openTradesCount > 0)
    || (!!bot?.openPosition && typeof bot.openPosition === 'object')
}

function openPositionError(id: string, bot: any, what: 'strategy' | 'timeframe'): ApiError {
  const symbol = capText(bot?.openPosition?.symbol, 40) ?? capText(bot?.symbol, 40)
  const why = what === 'strategy'
    ? 'the new strategy would adopt a position it did not open'
    : 'the position would be managed on a timeframe it was not opened on'
  return new ApiError(409, 'OPEN_POSITION', `Bot ${id} holds an open position${symbol ? ` on ${symbol}` : ''}, so its ${what} cannot change now: ${why}. ${FLAT_HINT}`, false)
}

/** The PATCH error with what the agent needs to act on it; anything else unchanged. */
function explainPatchError(err: unknown, id: string, bot: any): unknown {
  if (!(err instanceof ApiError)) return err
  if (err.status === 409 && err.code === 'OPEN_POSITION') {
    return new ApiError(409, 'OPEN_POSITION', `${capText(err.message, 300) ?? `Bot ${id} holds an open position or order.`} ${FLAT_HINT}`, false)
  }
  if (err.code === 'INSUFFICIENT_SCOPE' && primaryExchangeOf(bot)?.isPaper === false) {
    return new ApiError(403, 'INSUFFICIENT_SCOPE', `Bot ${id} trades on a LIVE account, so any change to it needs the mcp:live scope. ${err.message}`, false)
  }
  return err
}

/** The bot's stored overrides when they are an object (a legacy JSON string is ignored, as the engine does). */
function currentOverrides(bot: any): Record<string, unknown> {
  const v = bot?.parameterOverrides
  return v && typeof v === 'object' && !Array.isArray(v) ? { ...v } : {}
}

/**
 * What a strategy bot runs, from GET /api/bots/:id (fields copied by name): the version
 * channel and the version it runs, preset, timeframe, mode, interval and parameter
 * overrides -- what update_bot can set. Version code and scheduler internals stay out.
 */
function strategyConfigView(b: any) {
  const spin = b?.spinConfig || {}
  // GET resolves pinnedVersion to the version the bot runs (its channel's, or the pin).
  const pv = b?.pinnedVersion && typeof b.pinnedVersion === 'object' ? b.pinnedVersion : null
  const overrides = currentOverrides(b)
  const keys = Object.keys(overrides)
  const shown = Object.fromEntries(keys.slice(0, MAX_OVERRIDES_SHOWN).map((k) => {
    const v = overrides[k]
    return [k, typeof v === 'string' ? capText(v, 100) : v]
  }))
  return compact({
    versionChannel: b?.versionChannel || 'stable',
    version: pv ? (pv.semanticVersion ?? pv.version) : undefined,
    versionId: pv ? (idOf(pv) || undefined) : (typeof b?.pinnedVersion === 'string' ? b.pinnedVersion : undefined),
    preset: idOf(b?.preset) || null,
    timeframe: b?.timeframe,
    executionMode: spin.executionMode,
    spinIntervalSeconds: num(spin.interval),
    parameterOverrides: shown,
    parameterOverridesTotal: keys.length > MAX_OVERRIDES_SHOWN ? keys.length : undefined,
  })
}

/** The bot's configuration after an update, from GET /api/bots/:id (fields copied by name). */
function botConfigView(b: any) {
  const ex = primaryExchangeOf(b || {})
  const ps = b?.positionSizing || {}
  const strategyName = b?.strategyDetails?.name ?? (b?.strategy && typeof b.strategy === 'object' ? b.strategy.name : undefined)
  return compact({
    id: b?.id || b?._id,
    name: b?.name,
    status: b?.status,
    isPaper: ex ? !!ex.isPaper : undefined,
    exchange: ex?.accountLabel || ex?.name,
    symbol: b?.symbol,
    strategy: compact({ id: idOf(b?.strategy) || undefined, name: capText(strategyName, 80) }),
    ...strategyConfigView(b),
    positionSizing: compact({ type: ps.type, value: ps.value, leverage: ps.leverage, stopLoss: ps.stopLoss, takeProfit: ps.takeProfit }),
    openPosition: b?.openPosition,
    stopAfterClose: b?.stopAfterClose ? stopAfterCloseView(b.stopAfterClose) : undefined,
  })
}

/** PATCH's `warnings` (history supply, interval fit, pin notes) and legacy `warning`, capped. */
function serverWarnings(res: any): string[] {
  const out: string[] = []
  for (const w of [...(Array.isArray(res?.warnings) ? res.warnings : []), res?.warning]) {
    const text = capText(w, 300)
    if (text && !out.includes(text)) out.push(text)
    if (out.length >= 10) break
  }
  return out
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

  server.tool('get_bot_status', 'Get detailed status, configuration, and live performance for a specific trading bot by ID. Returns its run status, the strategy/symbol/exchange it trades, whether it is paper or live, P&L, win rate, total trades, risk config (leverage, stop-loss, take-profit, position size) and, for a strategy bot, strategyConfig (version channel and the version it runs, preset, timeframe, execution mode, interval, parameter overrides: what update_bot can change). Use it to check how a deployed bot is doing. stopAfterClose.enabled = true means the bot will pause itself once its current position closes (set with update_bot); completedAt is when it last did. Read-only — to stop a bot use stop_bot or update_bot stopAfterClose. Get bot IDs from list_bots.', {
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
        positionSize: data.positionSizing?.value,
        positionSizeType: data.positionSizing?.type,
      },
      // What update_bot can change on a strategy bot (e.g. to copy another bot's settings).
      ...(data.triggerType === 'strategy' ? { strategyConfig: strategyConfigView(data) } : {}),
      openPosition: data.openPosition,
      ...(data.stopAfterClose ? { stopAfterClose: stopAfterCloseView(data.stopAfterClose) } : {}),
    })
  }))

  server.tool('get_bot_logs', 'Explain what a strategy bot has been doing run by run: why it did or did not trade, which signals it queued or dropped, and which runs failed. Use it when a bot is not trading as expected, after get_bot_status. Read-only.\n\n' +
    'Sections (pick with `include`):\n' +
    '- runs (default): one entry per bot run, newest first. Fields: ts (run time, ms epoch), k (outcome kind, below), r (reason code, e.g. bar_wait, entry_backoff, timeout), bar (candle open time, ms), px (price), em (signals the strategy emitted), q (orders queued), dr (signals dropped), why (short reason codes for drops/skips), err (error text, truncated), sk (skipped runs folded into this entry since the previous one), ex (executor result for the queued orders: filled | blocked | ignored | failed), sn (spin number), ms (run duration). Also pendingSkips (bar_wait skips since the last entry: n, firstAt, lastAt, lastBar), lastSpin (at, status, nextAt, lastProcessedCandle), and earlyExits (runs that stopped before saving, by UTC day yyyymmdd then reason code, today and yesterday).\n' +
    '- spinLogs (default): stored per-run records: status (success | no_signal | error | timeout), createdAt, spinNumber, executionTimeMs, price, signals {count, types}, error message.\n' +
    '- live: the most recent in-memory runs (status, timestamp, spinNumber, executionTimeMs, signals, error, outcome in the runs format above) plus today\'s run summary counts (todaySummary).\n\n' +
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
          earlyExits: earlyExitsView(data?.earlyExits),
        }
      },
      spinLogs: async () => {
        const data = await api<any>(`/api/bots/${id}/spin-logs?limit=${n}`)
        const docs = Array.isArray(data?.docs) ? data.docs : []
        return compact({ logs: docs.map(spinLogView), total: num(data?.totalDocs), message: capText(data?.message, 200) })
      },
      live: async () => {
        // summary=true: the route only returns today's summary when asked.
        const data = await api<any>(`/api/bots/${id}/live-spins?limit=${n}&summary=true`)
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
      return errorResult(e.code, e.message ?? 'Could not load bot logs', { retryable: e.retryable, retryAfterMs: e.retryAfterMs })
    }
    return jsonResult(out)
  }))

  server.tool(
    'deploy_bot',
    'Deploy a strategy as a trading bot. Defaults to paper trading for safety — whether a bot trades real money is determined entirely by the exchange account it\'s attached to (not by the `live` flag alone), so this refuses to deploy if `live` doesn\'t match the target exchange\'s own paper/live status. Check an exchange\'s status with list_exchanges first, or create one with create_paper_exchange. The bot trades on the strategy\'s own timeframe unless you pass `timeframe`; omit `name` and the server names it.',
    {
      strategyId: z.string().describe('Strategy ID to deploy'),
      exchangeId: z.string().describe('Exchange account ID. Its own isPaper status (see list_exchanges) determines whether this bot trades real money — must match the `live` flag below.'),
      symbol: z.string().default('BTC/USDT'),
      market: z.enum(['spot', 'futures']).optional().describe('Market type. Omit to use the account default (spot).'),
      name: z.string().optional().describe('Bot name. Omit to let the server name it.'),
      timeframe: z.string().optional().describe('Candle timeframe the bot trades on (e.g. 15m, 1h, 4h, 1d). Omit to use the strategy\'s own timeframe; only set it to override that. Your plan may limit which timeframes are allowed.'),
      live: z.boolean().default(false).describe('Must match the target exchange\'s own paper/live status: false requires a paper exchange, true requires a live one. Defaults to false (paper) for safety.'),
      positionSizePercent: z.number().min(0).max(100).default(10).describe('Position size as a percentage of account balance per trade. Defaults to 10%.'),
      leverage: z.number().min(1).max(125).default(1),
      stopLoss: z.number().optional().describe('Stop loss % (e.g. 5)'),
      takeProfit: z.number().optional().describe('Take profit % (e.g. 10)'),
    },
    withErrorHandling(async ({ strategyId, exchangeId, symbol, market, name, timeframe, live, positionSizePercent, leverage, stopLoss, takeProfit }) => {
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

      // Creating a bot is not idempotent: sent once (retry: false), since a resend after a
      // timeout or gateway 5xx could create a second bot trading the same account.
      let data: any
      try {
        data = await api<any>('/api/bots', {
          method: 'POST',
          retry: false,
          body: {
            triggerType: 'strategy',
            strategy: strategyId,
            exchange: [exchangeId],
            symbol,
            // Only sent when given: with no name the server names the bot, and
            // with no timeframe it uses the strategy's own timeframe.
            ...(name ? { name } : {}),
            ...(timeframe ? { timeframe } : {}),
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
      } catch (err) {
        const reason = noAnswerReason(err)
        if (reason) {
          return errorResult('DEPLOY_OUTCOME_UNKNOWN', `The deploy request got no answer (${reason}), so the bot may have been created. Check list_bots before deploying again: do not call deploy_bot again until you have.`)
        }
        throw err
      }
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
    'Edit a deployed bot. One call can rename it, switch it to another strategy or apply a preset, change its timeframe, execution mode or run interval, set strategy parameters, change its version channel, and change its risk settings (leverage, position size %, stop loss, take profit), trade notifications or stopAfterClose. All of it goes in ONE update, so a strategy switch never lands half-done.\n\n' +
    'Merging: the bot\'s current settings are fetched first and your changes go on top. Grouped settings (positionSizing, messaging, spinConfig, parameterOverrides) are merged, never wiped by a partial change. Size and leverage are NEVER changed unless you pass positionSizePercent / leverage, also when you switch strategy or apply a preset.\n\n' +
    'Strategy switch (strategyId) and timeframe change need the bot to be FLAT: no open position and no working order. A bot that holds one is refused (OPEN_POSITION) and nothing is changed, because the new strategy would adopt a position it did not open (e.g. a long-only strategy inheriting a short). Pause it first with stopAfterClose:true (it keeps managing the position, opens nothing new and pauses once flat), wait until get_bot_status shows no openPosition, then switch. A switch starts the strategy state over and drops the old strategy\'s parameters, preset and stale owed exits; the new strategy runs its stable channel unless you pass versionChannel / pinnedVersionId. The bot keeps its status: a paused bot stays paused until you start_bot it.\n\n' +
    'Preset (presetId): applies it as the dashboard does when you pick one: its strategy, parameter overrides, timeframe, execution mode / interval and version, with anything you pass explicitly on top. The same flat rule applies when it changes the strategy or timeframe.\n\n' +
    'Scope: editing a paper bot needs mcp:paper; any change to a LIVE bot (rename, strategy, timeframe, parameters, risk) needs mcp:live. The server enforces it (INSUFFICIENT_SCOPE).\n\n' +
    'Returns the resulting config (strategy, version and channel, timeframe, mode, parameter overrides, size, leverage, status) and any server warnings, e.g. that the exchange cannot supply enough candle history. A stopAfterClose-only call returns a one-line confirmation. Get bot IDs from list_bots; check current values with get_bot_status.',
    {
      id: z.string().describe('The bot ID to update, obtained from list_bots.'),
      name: z.string().trim().min(1).max(120).optional().describe('New bot name. Omit to keep it.'),
      strategyId: z.string().min(1).max(100).optional().describe('Switch to this strategy: its ID or slug (e.g. "trade-wind", "supertrend-momentum"). The bot must be flat (see above). Its parameter overrides and preset are cleared unless you pass parameterOverrides / presetId; size and leverage are kept. Omit to keep the strategy.'),
      presetId: z.string().min(1).max(100).optional().describe('Apply this bot preset: its ID or slug (e.g. "trade-wind-long-short"). Writes the preset\'s strategy, parameter overrides, timeframe, execution mode / interval and version; anything you pass explicitly wins. Never changes size or leverage.'),
      versionChannel: z.enum(VERSION_CHANNELS).optional().describe('Strategy version channel: "stable" (default for a switch), "beta", "latest", or "custom" (needs pinnedVersionId). Omit to keep it.'),
      pinnedVersionId: z.string().min(1).max(64).optional().describe('Pin this strategy version ID (sets versionChannel "custom"). Version IDs come from list_strategy_versions.'),
      timeframe: z.string().min(1).max(8).optional().describe('Candle timeframe the bot trades on, e.g. "15m", "1h", "4h". Changing it needs the bot to be flat. Omit to keep it.'),
      executionMode: z.enum(EXECUTION_MODES).optional().describe('"on_bar_close" runs the strategy once per closed candle (what backtests simulate); "continuous" runs it every interval. Omit to keep it.'),
      spinIntervalSeconds: z.number().int().min(5).max(86_400).optional().describe('Run interval in seconds. An on_bar_close bot still runs every closed bar; the server brings a longer interval down to the bar. Omit to keep it.'),
      parameterOverrides: z.record(z.string().regex(PARAM_KEY_RE), PARAM_VALUE).optional().describe('Strategy parameters to set, e.g. {"ENABLE_SHORTS": true, "VOL_SKIP_PCT": 80}. Merged into the bot\'s current overrides (or the preset\'s, with presetId); a null value removes that key so the strategy default runs. After a strategy switch these are the only overrides.'),
      resetParameterOverrides: z.boolean().optional().describe('true: drop all current parameter overrides first (the strategy defaults run), then apply parameterOverrides if given.'),
      leverage: z.number().min(1).max(125).optional().describe('New leverage. Omit to leave unchanged.'),
      positionSizePercent: z.number().min(0).max(100).optional().describe('New position size as a percentage of account balance per trade. Omit to leave unchanged.'),
      stopLoss: z.number().optional().describe('New stop loss %. Omit to leave unchanged.'),
      takeProfit: z.number().optional().describe('New take profit %. Omit to leave unchanged.'),
      notifyOnTrade: z.boolean().optional().describe('Whether to send a Telegram notification for each trade this bot executes. Omit to leave unchanged.'),
      stopAfterClose: z.boolean().optional().describe('true: keep managing the open position, open no new entries, pause automatically once flat (immediately if already flat); false: cancel. Only an active bot can be set. Changing the bot\'s status (start_bot/stop_bot) also cancels it. Use it to get a bot flat before a strategy or timeframe change. Omit to leave unchanged.'),
    },
    { title: 'Update Bot', readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    withErrorHandling(async (args) => {
      const {
        id, name, strategyId, presetId, versionChannel, pinnedVersionId, timeframe, executionMode, spinIntervalSeconds,
        parameterOverrides, resetParameterOverrides, leverage, positionSizePercent, stopLoss, takeProfit, notifyOnTrade, stopAfterClose,
      } = args
      const body: Record<string, unknown> = {}
      const parts: string[] = []

      const riskChanged = leverage !== undefined || positionSizePercent !== undefined || stopLoss !== undefined || takeProfit !== undefined
      const spinChanged = executionMode !== undefined || spinIntervalSeconds !== undefined
      const strategyFieldsChanged = strategyId !== undefined || presetId !== undefined || versionChannel !== undefined
        || pinnedVersionId !== undefined || timeframe !== undefined || spinChanged
        || parameterOverrides !== undefined || resetParameterOverrides === true
      const configChanged = name !== undefined || strategyFieldsChanged

      // Contradictions are refused before anything is read or written.
      if (pinnedVersionId !== undefined && versionChannel !== undefined && versionChannel !== 'custom') {
        throw new ApiError(400, 'INVALID_ARGUMENTS', `pinnedVersionId pins a version, which is versionChannel "custom", not "${versionChannel}". Pass one or the other.`, false)
      }
      if (versionChannel === 'custom' && pinnedVersionId === undefined && presetId === undefined) {
        throw new ApiError(400, 'INVALID_ARGUMENTS', 'versionChannel "custom" needs pinnedVersionId (a version ID from list_strategy_versions).', false)
      }

      // Only the grouped fields and config edits need the current bot (fetch-and-merge).
      let bot: any = {}
      if (riskChanged || notifyOnTrade !== undefined || configChanged) {
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

      let switchedTo: { id: string, name?: string } | null = null
      if (configChanged) {
        if (name !== undefined) {
          body.name = name
          parts.push(`name: "${name}"`)
        }
        if (strategyFieldsChanged && bot.triggerType && bot.triggerType !== 'strategy') {
          throw new ApiError(400, 'NOT_A_STRATEGY_BOT', `Bot ${id} is a ${bot.triggerType} bot: strategy, preset, timeframe, execution and parameter settings only apply to strategy bots.`, false)
        }

        const target = strategyId !== undefined ? await resolveStrategyRef(strategyId) : null
        const strategySwitch = !!target && target.id !== idOf(bot.strategy)
        const timeframeChange = timeframe !== undefined && timeframe !== bot.timeframe
        // The server refuses these too (under the bot's locks, counting working orders);
        // checked here first so an older server can never switch a holding bot.
        if ((strategySwitch || timeframeChange) && holdsPosition(bot)) {
          throw openPositionError(id, bot, strategySwitch ? 'strategy' : 'timeframe')
        }

        if (presetId !== undefined) {
          // Resolved and applied by the server (PATCH applyPreset): the preset's strategy,
          // parameters, timeframe, spin and version, with the explicit fields below on top.
          body.applyPreset = presetId
          if (target) body.strategy = target.id
        } else if (strategySwitch) {
          body.strategy = target!.id
          // A preset belongs to one strategy, and so does a pinned version.
          body.preset = null
          body.versionChannel = pinnedVersionId !== undefined ? 'custom' : (versionChannel ?? 'stable')
          body.pinnedVersion = pinnedVersionId ?? null
        }
        if (strategySwitch) {
          switchedTo = target
          parts.push(`strategy: ${target!.name ?? target!.id}`)
        }
        if (!strategySwitch || presetId !== undefined) {
          if (pinnedVersionId !== undefined) {
            body.versionChannel = 'custom'
            body.pinnedVersion = pinnedVersionId
          } else if (versionChannel !== undefined) {
            body.versionChannel = versionChannel
            if (versionChannel !== 'custom' && presetId === undefined) body.pinnedVersion = null
          }
        }
        if (body.versionChannel !== undefined && (versionChannel !== undefined || pinnedVersionId !== undefined)) {
          parts.push(`version: ${body.versionChannel}${pinnedVersionId ? ` ${pinnedVersionId}` : ''}`)
        }

        if (timeframe !== undefined) {
          body.timeframe = timeframe
          parts.push(`timeframe: ${timeframe}`)
        }

        if (spinChanged) {
          // spinConfig is a group: the bot's current mode and interval, with the change on
          // top. With a preset only the explicit keys go, so the preset's fill the rest.
          const current = presetId === undefined ? (bot.spinConfig || {}) : {}
          const spin: Record<string, unknown> = {}
          if (typeof current.interval === 'number') spin.interval = current.interval
          if ((EXECUTION_MODES as readonly string[]).includes(current.executionMode)) spin.executionMode = current.executionMode
          if (executionMode !== undefined) spin.executionMode = executionMode
          if (spinIntervalSeconds !== undefined) spin.interval = spinIntervalSeconds
          body.spinConfig = spin
          if (executionMode !== undefined) parts.push(`execution: ${executionMode}`)
          if (spinIntervalSeconds !== undefined) parts.push(`interval: ${spinIntervalSeconds}s`)
        }

        if (presetId !== undefined) {
          // On top of the preset's own overrides, server-side (a null removes one there).
          if (parameterOverrides !== undefined) body.parameterOverrides = parameterOverrides
        } else if (parameterOverrides !== undefined || resetParameterOverrides === true || strategySwitch) {
          // PATCH writes parameterOverrides whole: merge onto what the bot has. A new
          // strategy starts from none (the old strategy's keys mean nothing to it).
          const base = strategySwitch || resetParameterOverrides === true ? {} : currentOverrides(bot)
          const merged: Record<string, unknown> = { ...base, ...(parameterOverrides ?? {}) }
          for (const [k, v] of Object.entries(merged)) if (v === null) delete merged[k]
          body.parameterOverrides = merged
          parts.push(`parameter overrides: ${Object.keys(merged).length} set`)
        }
      }

      if (stopAfterClose !== undefined) body.stopAfterClose = stopAfterClose

      if (!Object.keys(body).length) {
        throw new ApiError(400, 'NO_CHANGES', 'No fields provided to update.', false)
      }

      let res: any
      try {
        res = await api<any>(`/api/bots/${id}`, { method: 'PATCH', body })
      } catch (err) {
        throw explainPatchError(err, id, bot)
      }

      if (presetId !== undefined) {
        const applied = res?.appliedPreset
        if (!applied || typeof applied !== 'object') {
          throw new ApiError(501, 'PRESET_UNSUPPORTED', `The TradeStaq server did not apply preset "${presetId}": this server version cannot apply presets yet. The preset was not applied${Object.keys(body).length > 1 ? '; the other fields in this call were saved' : ''}.`, false)
        }
        parts.push(`preset applied: ${capText(applied.name, 80) ?? capText(applied.slug, 80) ?? presetId}`)
      }

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

      const message = `Bot ${id} updated. ${parts.join(', ')}`
      // A stopAfterClose-only call keeps its one-line reply (no GET before or after).
      if (!riskChanged && notifyOnTrade === undefined && !configChanged) {
        return { content: [{ type: 'text' as const, text: message }] }
      }

      // The resulting config as the server now reports it (strategy name, the version it
      // runs). The write already landed, so a failed read falls back to the PATCH reply.
      let after: any = null
      try {
        const raw = await api<any>(`/api/bots/${id}`)
        after = raw?.doc || raw
      } catch {
        // Reported from the PATCH response below.
      }
      const resulting = after && typeof after === 'object'
        ? after
        : { ...bot, ...(res?.doc && typeof res.doc === 'object' ? res.doc : {}), ...(switchedTo?.name ? { strategyDetails: { name: switchedTo.name } } : {}) }
      const view = botConfigView(resulting)
      const warnings = serverWarnings(res)
      const notes: string[] = []
      if ((switchedTo || presetId !== undefined) && view.status && view.status !== 'active' && view.status !== 'debug_active') {
        notes.push(`The bot is ${view.status}: start it with start_bot when you are ready.`)
      }
      return jsonResult({
        message,
        bot: view,
        ...(warnings.length ? { warnings } : {}),
        ...(notes.length ? { notes } : {}),
      })
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
    // -- the reliable signal for "does this bot own an open trade right
    // now", counting every open lot rather than the one summarised leg
    // in `openPosition`.
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

  server.tool('close_position', 'Close an open trading position by placing a market order — fully or partially. This moves real money when the position is live, so confirm intent with the user before calling. Find the exchangeId, symbol, and side with get_positions. Set percentage below 100 for a partial close. A position one bot holds is closed as that bot\'s close (its lots, its exit record). Reports what actually closed (size, price, PnL) as the server confirmed it; when nothing closed, it returns the server\'s reason as an error, never "closed". Each call sends its close once. After CLOSE_OUTCOME_UNKNOWN, CLOSE_UNCONFIRMED or CLOSE_IN_PROGRESS the position may already be closed: never call close_position again for it without checking get_positions first.', {
    exchangeId: z.string().describe('The exchange account ID where the position is open, from get_positions or list_exchanges.'),
    symbol: z.string().describe('Trading pair of the position, e.g. "BTC/USDT".'),
    side: z.enum(['long', 'short']).describe('Position side, from get_positions.'),
    percentage: z.number().min(1).max(100).default(100).describe('Percentage of the position to close, 1-100. 100 = full close (default); e.g. 50 closes half.'),
    botId: z.string().optional().describe('Optional: the bot whose position this is (its id, from list_bots). Defaults to the position\'s own bot when exactly one bot holds it. With a position several bots share, only this bot\'s share closes (at most the percentage of the whole position).'),
  }, { title: 'Close Position', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }, withErrorHandling(async ({ exchangeId, symbol, side, percentage, botId }) => {
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
      throw new ApiError(404, 'POSITION_NOT_FOUND', `No open ${side} ${symbol} position on exchange ${exchangeId}. Use get_positions to see what's actually open.`, false)
    }
    const size = position.size * (percentage / 100)
    // The bot that holds it: named by the caller, else the position's own bot when exactly
    // one bot holds it (botCount 1). The server then closes it as that bot's close.
    const ownerBotId = botId || (Number(position.botCount) === 1 && position.botId ? String(position.botId) : undefined)

    // One idempotency key per tool call, sent as the Idempotency-Key header and body requestId:
    // a close that reaches the server twice gets the first close's result, not a second order.
    // Sent once (retry: false) with 120s for the server's venue rechecks: resending after a
    // timeout or a gateway 5xx while the first close still runs would close the position again.
    const requestId = randomUUID()
    let data: any
    try {
      data = await api<any>('/api/positions/close', {
        method: 'POST',
        body: { exchangeId, symbol, side, size, ...(ownerBotId ? { botId: ownerBotId } : {}), requestId },
        headers: { 'Idempotency-Key': requestId },
        timeout: 120_000,
        retry: false,
      })
    } catch (err) {
      const mayHaveRun = closeMayHaveRunResult(err, `${side} ${symbol}`)
      if (mayHaveRun) return mayHaveRun
      throw err
    }
    // A close is reported only when the server confirms what it closed: `closedSize` (booked)
    // or `filledSize` (what the exchange filled). A bare success closed nothing that it could
    // show (prod 2026-10-24: "Position closed." for three paper closes that sold nothing).
    const closedSize = Number(data?.closedSize) > 0 ? Number(data.closedSize) : Number(data?.filledSize) > 0 ? Number(data.filledSize) : 0
    if (data?.success !== true || !(closedSize > 0)) {
      // The server's reason when it gave one (a bare success's "closed" message is not one).
      const why = data?.success !== true && typeof data?.message === 'string' && data.message ? `: ${data.message}` : ''
      return errorResult('CLOSE_NOT_CONFIRMED', `The server did not confirm that anything closed for the ${side} ${symbol} position${why}. It is NOT reported as closed: check get_positions before trying again.`)
    }
    const price = Number(data.exitPrice) > 0 ? Number(data.exitPrice) : Number(data.order?.average) > 0 ? Number(data.order.average) : undefined
    const closedBot = data.botId || ownerBotId
    const lines = [
      `${data.partial ? 'Position partly closed' : 'Position closed'}${percentage < 100 ? ` (${percentage}% requested)` : ''}.`,
      `Symbol: ${symbol} (${side})`,
      `Closed: ${closedSize}${price != null ? ` @ ${price}` : ''}`,
      ...(data.pnl != null ? [`PnL: ${data.pnl}`] : []),
      ...(closedBot ? [`Bot: ${position.botName && String(position.botId) === String(closedBot) ? `${position.botName} (${closedBot})` : closedBot}`] : []),
      '',
      'Use get_positions to verify.',
    ]
    return { content: [{ type: 'text' as const, text: lines.join('\n') }] }
  }))
}
