import { z } from 'zod'
import { api, ApiError } from '../api.js'
import { errorResult, jsonResult, withErrorHandling } from '../helpers.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

const SCORING_PROFILE_DESCRIPTIONS: Record<string, string> = {
  balanced: 'Performance-first: return drives the score, quality (Sharpe x profit factor) and win rate add, drawdown penalizes.',
  conservative: 'Low drawdown + consistent returns, scaled so a lucky handful of low-risk trades cannot win over a larger sample.',
  aggressive: 'Maximize total return -- return is the dominant factor, profit factor capped to prevent cherry-picking.',
  consistency: 'High win rate + Sortino ratio with a strict minimum trade count -- must trade frequently and win consistently.',
}

/**
 * The server's absolute cap on pairs per run (mfanya BASKET_HARD_MAX): its `symbols` intake
 * refuses longer lists, and the admin-set system cap and every tier cap are bounded by it.
 * The effective cap is lower (the user's plan, default system cap 5) and the server refuses
 * a request over it with too_many_assets, maxAssets and an upgrade hint.
 */
export const MAX_PAIRS_PER_RUN = 8

// A pair symbol as the server can return it: unified CCXT forms such as BTC/USDT,
// BTC/USDT:USDT, 1000PEPE/USDT, BTC/USD:BTC-250926. No whitespace, so no prose.
const SYMBOL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/
// The server mints quoteIds with crypto.randomUUID().
const QUOTE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// resolved dates are Date#toISOString() output (a date-only form is accepted too).
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/
const PROFILES = new Set(['balanced', 'conservative', 'aggressive', 'consistency'])

const QUOTE_CHANGED_REASONS = new Set(['params_changed', 'price_increased', 'quote_expired', 'foreign_quote'])

/**
 * Every `code` the server's POST /api/strategy-lab sends on a 400 (route.ts submitBasket,
 * refusalResponse and the symbols intake). Any other code reaches the agent as HTTP_400.
 */
const BASKET_ERROR_CODES = new Set([
  'invalid_symbols_param', 'baskets_unavailable', 'too_many_assets', 'preset_search_single_pair_only',
  'invalid_symbols', 'mixed_basket', 'invalid_run_window', 'basket_window_too_long', 'basket_too_slow',
  'basket_preset_search_unavailable',
])

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isSymbol = (v: unknown): v is string => typeof v === 'string' && SYMBOL_RE.test(v)

export type BasketSymbolsResult =
  | { ok: true; pairs: string[] | undefined }
  | { ok: false; code: 'no_symbols' | 'symbol_not_in_symbols'; message: string }

/**
 * Pairs to send, primary first: `symbols` trimmed, empty entries dropped, then deduped
 * case-insensitively keeping the first spelling. `symbol` only picks the primary: when it
 * matches a listed pair (any case) that pair leads, in `symbol`'s spelling, as the server
 * does. A `symbol` that is not one of `symbols` is refused rather than ignored (the server
 * would silently run the listed pairs with a different primary) or added (that would quote
 * and charge a pair the caller did not list). `pairs` is undefined when `symbols` was not
 * given, so the legacy scalar body is sent unchanged.
 */
export function basketSymbols(symbol: string | undefined, symbols: string[] | undefined): BasketSymbolsResult {
  if (!symbols) return { ok: true, pairs: undefined }
  const seen = new Set<string>()
  const deduped: string[] = []
  for (const raw of symbols) {
    const s = raw.trim()
    if (!s) continue
    const key = s.toUpperCase()
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(s)
  }
  if (deduped.length === 0) {
    return { ok: false, code: 'no_symbols', message: 'symbols has no pairs after removing empty entries. List at least one pair, or omit symbols for a single-pair run. Nothing was quoted or charged.' }
  }
  const primary = symbol?.trim()
  if (!primary) return { ok: true, pairs: deduped }
  if (!seen.has(primary.toUpperCase())) {
    return { ok: false, code: 'symbol_not_in_symbols', message: 'symbol is not one of symbols. With symbols, symbol only picks which listed pair is the primary; it never adds a pair. Add it to symbols, or omit symbol and list the primary pair first. Nothing was quoted or charged.' }
  }
  return { ok: true, pairs: [primary, ...deduped.filter((s) => s.toUpperCase() !== primary.toUpperCase())] }
}

function presetSearchOf(v: any): Record<string, unknown> | undefined {
  if (!v || typeof v !== 'object' || typeof v.requested !== 'boolean') return undefined
  const out: Record<string, unknown> = { requested: v.requested }
  if (isNum(v.cost)) out.cost = v.cost
  if (Array.isArray(v.profiles) && v.profiles.length <= PROFILES.size && v.profiles.every((p: unknown) => typeof p === 'string' && PROFILES.has(p))) {
    out.profiles = [...v.profiles]
  }
  return out
}

/**
 * The basket quote fields of the server's cost_estimate envelope (plan 3.9), each only in
 * its documented shape. An allowlist with type checks, not a spread: a field the server adds,
 * or one that does not have the expected shape (e.g. prose in quoteId or assets), stays out
 * of the agent's context.
 */
function quoteFieldsOf(raw: any): Record<string, unknown> {
  const quote: Record<string, unknown> = {}
  if (typeof raw?.quoteId === 'string' && QUOTE_ID_RE.test(raw.quoteId)) quote.quoteId = raw.quoteId
  const r = raw?.resolved
  if (r && typeof r === 'object' && typeof r.startDate === 'string' && typeof r.endDate === 'string'
    && ISO_DATE_RE.test(r.startDate) && ISO_DATE_RE.test(r.endDate)) {
    quote.resolved = { startDate: r.startDate, endDate: r.endDate }
  }
  if (Array.isArray(raw?.assets) && raw.assets.length >= 1 && raw.assets.length <= MAX_PAIRS_PER_RUN && raw.assets.every(isSymbol)) {
    quote.assets = [...raw.assets]
  }
  for (const k of ['assetCount', 'experimentsQuoted', 'clampedFrom', 'estimatedMinutes', 'expectedExperimentsWithinBudget'] as const) {
    if (isNum(raw?.[k])) quote[k] = raw[k]
  }
  const cb = raw?.costBreakdown
  if (cb && typeof cb === 'object') {
    const breakdown: Record<string, unknown> = {}
    for (const k of ['experiments', 'perExperiment', 'presetSearch'] as const) {
      if (isNum(cb[k])) breakdown[k] = cb[k]
    }
    if (isNum(cb.perExtraAsset) || cb.perExtraAsset === null) breakdown.perExtraAsset = cb.perExtraAsset
    if (Object.keys(breakdown).length > 0) quote.costBreakdown = breakdown
  }
  return quote
}

function costEstimateResult(raw: any, message: string) {
  return {
    status: 'cost_estimate',
    message,
    ...(isNum(raw?.estimatedCost) ? { estimatedCost: raw.estimatedCost } : {}),
    ...(isNum(raw?.creditsPerExperiment) ? { creditsPerExperiment: raw.creditsPerExperiment } : {}),
    ...(isNum(raw?.maxExperiments) ? { maxExperiments: raw.maxExperiments } : {}),
    // Broken out by the API so the user sees WHAT they are approving, not just a
    // total that silently grew because searchPresets was set. Dropping it here would
    // put the per-profile charge back out of sight.
    ...(presetSearchOf(raw?.presetSearch) ? { presetSearch: presetSearchOf(raw.presetSearch) } : {}),
    ...(isNum(raw?.balance) ? { walletBalance: raw.balance } : {}),
    ...(typeof raw?.sufficient === 'boolean' ? { sufficientBalance: raw.sufficient } : {}),
    ...quoteFieldsOf(raw),
  }
}

const SINGLE_PAIR_ESTIMATE_MESSAGE = 'Not started. Show this estimate to the user and, if approved, call again with acknowledgeCost:true.'
const BASKET_ESTIMATE_MESSAGE = 'Not started. Show the user the pairs (assets), the maximum cost (estimatedCost) and the time estimate (estimatedMinutes; clampedFrom means the time limit cut the experiments requested). If approved, call again with the same arguments plus acknowledgeCost:true and quoteId from this estimate. The bill is never above this quote: only experiments that actually run are paid for.'
const QUOTE_CHANGED_MESSAGE = 'Not started: the quote changed since the user confirmed it (see reason). Show the user this new estimate and, if approved, call again with the same arguments plus acknowledgeCost:true and this new quoteId.'

/**
 * A Strategy Lab 400, re-thrown for withErrorHandling: the code only when it is one the
 * server documents (otherwise HTTP_400), plus only the documented detail fields, each only
 * in its expected shape.
 */
function basketError(err: ApiError): ApiError {
  if (!BASKET_ERROR_CODES.has(err.code)) {
    return new ApiError(err.status, 'HTTP_400', err.message, false, undefined, err.details)
  }
  const details = err.details ?? {}
  const fields: Record<string, unknown> = {}
  for (const k of ['maxAssets', 'maxDaysAtTimeframe', 'maxAssetsThatFit', 'maxDaysThatFit', 'profilesThatFit'] as const) {
    if (isNum(details[k])) fields[k] = details[k]
  }
  const upgrade = details.upgrade as any
  if (upgrade && typeof upgrade.tierName === 'string' && upgrade.tierName.length <= 64 && isNum(upgrade.maxAssets)) {
    fields.upgrade = { tierName: upgrade.tierName, maxAssets: upgrade.maxAssets }
  }
  if (Array.isArray(details.invalidSymbols) && details.invalidSymbols.length <= MAX_PAIRS_PER_RUN && details.invalidSymbols.every(isSymbol)) {
    fields.invalidSymbols = [...details.invalidSymbols]
  }
  if (isSymbol(details.symbol)) fields.symbol = details.symbol
  return new ApiError(err.status, err.code, err.message, false, undefined, err.details, fields)
}

export function registerStrategyLabTools(server: McpServer) {

  server.tool('start_optimization_run', 'Start a Strategy Lab optimization run on one of your own strategies: an AI mutation loop that repeatedly tweaks the strategy code, backtests each variant, and keeps improvements (walk-forward validated: trains on trainSplit of the window, validates on the rest). This is different from generate_strategy -- that writes one strategy from a description; this iteratively improves an EXISTING strategy you already own. Does not create new strategies. Wallet-charging: call once WITHOUT acknowledgeCost to get a cost estimate (no charge, nothing queued), confirm the spend with the user, then call again with acknowledgeCost:true to actually start. Requires the mcp:live OAuth scope. Only one run can be active per user at a time. When the run finishes, its best version is checked out of sample (on the part of the window it was not trained on). The best version becomes the strategy\'s latestVersion ONLY if it passes that check (single-pair runs: also when the check is inconclusive, e.g. too few out-of-sample trades). Otherwise -- it failed the check, or the run was cancelled -- the version is HELD: latestVersion and the bots following it are not changed, and get_optimization_status shows progress.verdict, progress.heldBecause and progress.heldVersionId (savedVersionId is absent). The strategy author can still accept a held version in the TradeStaq web app ("Use this version anyway"). Promoted to stable automatically ONLY if autoPromote:true AND the result clears a strict bar (see autoPromote param); otherwise use promote_strategy_version yourself once you like the result. MULTI-PAIR (basket) RUNS: pass symbols (primary first) to test every candidate on several pairs of the same exchange account and market type, so the result is not tuned to one chart. Pricing is the base per experiment plus an extra charge per extra pair per experiment, billed per pair actually evaluated. A multi-pair request always returns a cost_estimate first with a quoteId, the pairs, the maximum cost and estimatedMinutes; the quote is a maximum, and a run time limit may cut experiments (clampedFrom, expectedExperimentsWithinBudget). Confirm by calling again with the same arguments plus acknowledgeCost:true and that quoteId (or acknowledgedCost). If the response has quoteChanged:true, show the new estimate and confirm again with its new quoteId. A multi-pair run passes only if the best version beats the original on most pairs, wrecks no pair, and loses money out of sample on no pair; otherwise it is held (an inconclusive check also holds a multi-pair run), and get_optimization_status shows the per-pair results.', {
    strategyId: z.string().describe('ID of your own strategy to optimize, from list_strategies(owned:true) or get_strategy.'),
    exchangeId: z.string().describe('An exchange you own (paper or live), from list_exchanges. Used only to source historical candle data.'),
    symbol: z.string().optional().describe('Trading pair to optimize against. Defaults to BTC/USDT when symbols is not given. With symbols, it only picks which listed pair is the primary and must be one of symbols (any case); a symbol that is not in symbols is refused with code symbol_not_in_symbols and nothing is quoted. Prefer omitting it and listing the primary first in symbols.'),
    symbols: z.array(z.string()).min(1).max(MAX_PAIRS_PER_RUN).optional().describe(`Pairs to test on, primary first, all on the same exchange account and market type, e.g. ["BTC/USDT","ETH/USDT","SOL/USDT"]. Entries are trimmed, empty ones dropped and duplicates (any case) removed; a list that comes down to one pair is a plain single-pair run. More than one pair tests every candidate on every pair (a multi-pair run, priced per extra pair per experiment and confirmed with quoteId). Capped by the user's plan (Free 1 / Pro 3 / Trader 4 / Whale 5) and by the system cap (5 by default, never above ${MAX_PAIRS_PER_RUN}), and only available when the server has multi-pair runs on; a request over the cap is refused with code too_many_assets, maxAssets and an upgrade hint. Combinable with searchPresets only once an admin has priced the multi-pair preset search (otherwise refused with code preset_search_single_pair_only): every preset candidate is then tested on every pair. Omit for a single-pair run.`),
    timeframe: z.string().default('1h').describe('Candle timeframe, e.g. "1h", "4h", "1d".'),
    maxExperiments: z.number().int().min(1).max(30).default(20).describe('How many mutate-and-backtest experiments to run (1-30). Cost scales linearly with this -- fewer experiments for a quick/cheap check, more for a thorough search.'),
    scoringProfile: z.enum(['balanced', 'conservative', 'aggressive', 'consistency']).default('balanced').describe(
      Object.entries(SCORING_PROFILE_DESCRIPTIONS).map(([k, v]) => `${k}: ${v}`).join(' | ')
    ),
    startDate: z.string().optional().describe('ISO date for the start of the backtest window. Defaults to 6 months ago.'),
    endDate: z.string().optional().describe('ISO date for the end of the backtest window. Defaults to now.'),
    trainSplit: z.number().min(0.5).max(0.9).default(0.7).describe('Fraction of the window used for training vs. out-of-sample validation (0.5-0.9).'),
    userGuidance: z.string().max(2000).optional().describe('Free-text steering for the AI mutations, e.g. "focus on reducing drawdown" (max 2000 chars).'),
    autoPromote: z.boolean().default(false).describe('If true, automatically promote the run\'s final saved version to the stable channel (what every bot on that strategy actually runs) when the run completes -- skipping the separate promote_strategy_version step. Only takes effect if the run found a real improvement AND the out-of-sample check returned a passing verdict (an inconclusive or failed check never auto-promotes) AND the result is profitable out of sample AND it is no worse out of sample than the current stable version; otherwise nothing is promoted (the version is handled exactly like a normal run: latestVersion on a pass, held otherwise), and get_optimization_status.progress.autoPromoteSkippedReason explains why. Confirm with the user before setting this true -- it changes what live bots run without a separate review step, the same way promote_strategy_version does. Default false preserves the old behavior (never auto-promotes).'),
    searchPresets: z.boolean().default(false).describe('Also search for per-risk-profile PARAMETER PRESETS once the code-mutation loop finishes -- tuning the strategy\'s own knobs separately for each risk profile, then walk-forward validating each winner and publishing the ones that clear the bar. Charged SEPARATELY and per profile on top of the experiment cost, so the estimate returned without acknowledgeCost breaks it out under presetSearch -- show that to the user before confirming. Only runs if the mutation loop actually found an improvement. Requires an admin to have priced it; the request is refused with a clear message if not. On a multi-pair run every candidate is tested on every pair, so each profile costs the per-profile price plus an extra charge per extra pair (shown under presetSearch and costBreakdown.presetSearch in the quoteId estimate), it adds to estimatedMinutes, and it is billed only if the search finishes; until an admin prices the multi-pair search it is refused with code preset_search_single_pair_only.'),
    presetProfiles: z.array(z.enum(['balanced', 'conservative', 'aggressive', 'consistency'])).optional().describe('Which risk profiles the preset search should cover. Omit for all four. Cost scales per profile, so naming one or two is the cheaper option when the user only cares about a particular risk shape. Ignored unless searchPresets is true.'),
    quoteId: z.string().optional().describe('Multi-pair runs only: the quoteId from the cost_estimate the user approved. Send it with acknowledgeCost:true and the same other arguments; the run then uses exactly that quote.'),
    acknowledgedCost: z.number().min(0).optional().describe('Multi-pair runs only: the estimatedCost the user approved. Used when the quote has expired: the run starts if the fresh price is not above it, otherwise a new estimate comes back (quoteChanged:true).'),
    acknowledgeCost: z.boolean().default(false).describe('Set true only after showing the user the estimated cost (from a prior call without this flag, or from check_auth\'s wallet balance) and getting their approval. False (default) returns a cost preview and starts nothing.'),
  }, { title: 'Start Optimization Run', readOnlyHint: false, destructiveHint: true, idempotentHint: false }, withErrorHandling(async (args) => {
    const { strategyId, exchangeId, acknowledgeCost, symbol, symbols, quoteId, acknowledgedCost, ...rest } = args
    const parsed = basketSymbols(symbol, symbols)
    if (!parsed.ok) return errorResult(parsed.code, parsed.message)
    const pairs = parsed.pairs
    // No `symbols`: exactly the 0.3.9 body (symbol defaulting to BTC/USDT). One pair after
    // cleanup is a plain single-pair run. More than one: `symbols` only, primary first, so
    // the server never sees a scalar it could disagree with.
    const pairFields = pairs === undefined
      ? { symbol: symbol ?? 'BTC/USDT' }
      : pairs.length === 1 ? { symbol: pairs[0] } : { symbols: pairs }
    const isBasket = pairs !== undefined && pairs.length > 1
    const body: Record<string, unknown> = { strategyId, exchangeId, acknowledgeCost, ...pairFields, ...rest }
    if (quoteId !== undefined) body.quoteId = quoteId
    if (acknowledgedCost !== undefined) body.acknowledgedCost = acknowledgedCost

    let raw: any
    try {
      raw = await api<any>('/api/strategy-lab', { method: 'POST', body })
    } catch (err) {
      if (err instanceof ApiError) {
        const d = err.details
        if (err.status === 409 && d && d.error === 'quote_changed' && d.status === 'cost_estimate') {
          return jsonResult({
            ...costEstimateResult(d, QUOTE_CHANGED_MESSAGE),
            quoteChanged: true,
            ...(typeof d.reason === 'string' && QUOTE_CHANGED_REASONS.has(d.reason) ? { reason: d.reason } : {}),
          })
        }
        if (err.status === 400) throw basketError(err)
      }
      throw err
    }

    if (raw.status === 'cost_estimate') {
      return jsonResult(costEstimateResult(raw, isBasket ? BASKET_ESTIMATE_MESSAGE : SINGLE_PAIR_ESTIMATE_MESSAGE))
    }

    return jsonResult({
      status: 'started',
      jobId: raw.jobId,
      estimatedCost: raw.estimatedCost,
      config: raw.config,
      ...(raw.queue !== undefined ? { queue: raw.queue } : {}),
      message: 'Optimization queued. Poll get_optimization_status with this jobId to track progress -- a full run typically takes several minutes to over an hour depending on maxExperiments (and the number of pairs).',
    })
  }))

  server.tool('get_optimization_status', 'Check progress of a Strategy Lab optimization run started with start_optimization_run. Each experiment (AI mutation + backtest) typically takes 1-2+ minutes, so poll every 15-30 seconds rather than tightly looping. While the run is going, savedVersionId (once it appears) is the strategy version holding the best result found so far -- it is not the strategy\'s latestVersion yet. When status is completed, progress.verdict gives the out-of-sample result: on a pass (single-pair runs: also when inconclusive) savedVersionId is now the strategy\'s latestVersion -- inspect it with list_strategy_versions. A held run (failed check, or cancelled) has no savedVersionId; instead progress.heldVersionId is the held version and progress.heldBecause says why, latestVersion is unchanged, and the author can accept it in the TradeStaq web app ("Use this version anyway"). progress.cancelled is true for a cancelled run, and progress.stopReason says why a run stopped early (cancelled, time_budget, balance or data_unavailable_on_resume). If the run was started with autoPromote:true, check progress.autoPromoted (true if it was actually promoted to stable) and progress.autoPromoteSkippedReason (present and explains why if it wasn\'t); otherwise promote it yourself with promote_strategy_version if you like it. A completed or failed run stays queryable for 24 hours. MULTI-PAIR runs: progress.basket lists the pairs; progress.baselinePerAsset and progress.bestPerAsset give each pair\'s result, with the best version marked W/T/L (won, tied, lost) or cured against the original on that pair; progress.validation.perAsset and progress.validation.breadth give the out-of-sample check per pair and how many pairs passed; experiments[].perAsset is kept only on the best and the latest experiment (this tool asks for the summary view). While a run waits to start, queue gives its position and etaMinutes (estimated minutes until it starts). After an auto-promote, progress.autoPromote.untestedPairs lists pairs that bots following the stable version trade but this run did not test (reported only; it never blocks the promote). verdict, heldVersionId and heldBecause work as for single-pair runs.', {
    jobId: z.string().describe('Job ID returned by start_optimization_run.'),
  }, { title: 'Get Optimization Status', readOnlyHint: true }, withErrorHandling(async ({ jobId }) => {
    const raw = await api<any>(`/api/strategy-lab?jobId=${encodeURIComponent(jobId)}&detail=summary`)
    return jsonResult(raw)
  }))

  server.tool('cancel_optimization_run', 'Cancel a Strategy Lab optimization run you started. Takes effect after the current experiment finishes, not instantly -- check get_optimization_status to confirm it actually stopped. Any best version found before cancellation is kept but HELD (latestVersion is not changed); get_optimization_status then shows progress.cancelled, progress.heldVersionId and progress.heldBecause, and the author can still accept it in the TradeStaq web app.', {
    jobId: z.string().describe('Job ID to cancel, from start_optimization_run.'),
  }, { title: 'Cancel Optimization Run', readOnlyHint: false, destructiveHint: true, idempotentHint: true }, withErrorHandling(async ({ jobId }) => {
    const raw = await api<any>('/api/strategy-lab', {
      method: 'PUT',
      body: { jobId, action: 'cancel' },
    })
    return jsonResult({
      message: raw.message || 'Cancel requested -- will stop after the current experiment.',
      jobId: raw.jobId || jobId,
    })
  }))

  server.tool('send_optimization_guidance', 'Inject live free-text steering into a running Strategy Lab optimization, e.g. "stop trying mean-reversion tweaks, focus on trend-following". Applies starting with the NEXT experiment, not the one currently in flight. Overwrites any previously-injected guidance for this run.', {
    jobId: z.string().describe('Job ID to steer, from start_optimization_run.'),
    guidance: z.string().min(1).max(2000).describe('Free-text guidance for the AI to apply on the next experiment (max 2000 chars).'),
  }, { title: 'Send Optimization Guidance', readOnlyHint: false, destructiveHint: false, idempotentHint: false }, withErrorHandling(async ({ jobId, guidance }) => {
    const raw = await api<any>('/api/strategy-lab', {
      method: 'PUT',
      body: { jobId, guidance },
    })
    return jsonResult({
      message: raw.message || 'Guidance injected -- will apply on the next experiment.',
      jobId: raw.jobId || jobId,
    })
  }))
}
