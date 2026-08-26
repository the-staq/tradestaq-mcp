import { z } from 'zod'
import { api } from '../api.js'
import { jsonResult, withErrorHandling } from '../helpers.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

const SCORING_PROFILE_DESCRIPTIONS: Record<string, string> = {
  balanced: 'Performance-first: return drives the score, quality (Sharpe x profit factor) and win rate add, drawdown penalizes.',
  conservative: 'Low drawdown + consistent returns, scaled so a lucky handful of low-risk trades cannot win over a larger sample.',
  aggressive: 'Maximize total return -- return is the dominant factor, profit factor capped to prevent cherry-picking.',
  consistency: 'High win rate + Sortino ratio with a strict minimum trade count -- must trade frequently and win consistently.',
}

export function registerStrategyLabTools(server: McpServer) {

  server.tool('start_optimization_run', 'Start a Strategy Lab optimization run on one of your own strategies: an AI mutation loop that repeatedly tweaks the strategy code, backtests each variant, and keeps improvements (walk-forward validated: trains on trainSplit of the window, validates on the rest). This is different from generate_strategy -- that writes one strategy from a description; this iteratively improves an EXISTING strategy you already own. Does not create new strategies. Wallet-charging: call once WITHOUT acknowledgeCost to get a cost estimate (no charge, nothing queued), confirm the spend with the user, then call again with acknowledgeCost:true to actually start. Requires the mcp:live OAuth scope. Only one run can be active per user at a time. Improvements are saved to the strategy\'s latestVersion as they\'re found -- never auto-promoted to stable; use promote_strategy_version yourself once you like the result.', {
    strategyId: z.string().describe('ID of your own strategy to optimize, from list_strategies(owned:true) or get_strategy.'),
    exchangeId: z.string().describe('An exchange you own (paper or live), from list_exchanges. Used only to source historical candle data.'),
    symbol: z.string().default('BTC/USDT').describe('Trading pair to optimize against.'),
    timeframe: z.string().default('1h').describe('Candle timeframe, e.g. "1h", "4h", "1d".'),
    maxExperiments: z.number().int().min(1).max(30).default(20).describe('How many mutate-and-backtest experiments to run (1-30). Cost scales linearly with this -- fewer experiments for a quick/cheap check, more for a thorough search.'),
    scoringProfile: z.enum(['balanced', 'conservative', 'aggressive', 'consistency']).default('balanced').describe(
      Object.entries(SCORING_PROFILE_DESCRIPTIONS).map(([k, v]) => `${k}: ${v}`).join(' | ')
    ),
    startDate: z.string().optional().describe('ISO date for the start of the backtest window. Defaults to 6 months ago.'),
    endDate: z.string().optional().describe('ISO date for the end of the backtest window. Defaults to now.'),
    trainSplit: z.number().min(0.5).max(0.9).default(0.7).describe('Fraction of the window used for training vs. out-of-sample validation (0.5-0.9).'),
    aiProvider: z.string().optional().describe('Override the AI provider used for mutations. Omit to use the account default.'),
    aiModel: z.string().optional().describe('Override the AI model used for mutations. Omit to use the provider default.'),
    userGuidance: z.string().max(2000).optional().describe('Free-text steering for the AI mutations, e.g. "focus on reducing drawdown" (max 2000 chars).'),
    acknowledgeCost: z.boolean().default(false).describe('Set true only after showing the user the estimated cost (from a prior call without this flag, or from check_auth\'s wallet balance) and getting their approval. False (default) returns a cost preview and starts nothing.'),
  }, { title: 'Start Optimization Run', readOnlyHint: false, destructiveHint: true, idempotentHint: false }, withErrorHandling(async (args) => {
    const { strategyId, exchangeId, acknowledgeCost, ...rest } = args
    const raw = await api<any>('/api/strategy-lab', {
      method: 'POST',
      body: { strategyId, exchangeId, acknowledgeCost, ...rest },
    })

    if (raw.status === 'cost_estimate') {
      return jsonResult({
        status: 'cost_estimate',
        message: 'Not started. Show this estimate to the user and, if approved, call again with acknowledgeCost:true.',
        estimatedCost: raw.estimatedCost,
        creditsPerExperiment: raw.creditsPerExperiment,
        maxExperiments: raw.maxExperiments,
        walletBalance: raw.balance,
        sufficientBalance: raw.sufficient,
      })
    }

    return jsonResult({
      status: 'started',
      jobId: raw.jobId,
      estimatedCost: raw.estimatedCost,
      config: raw.config,
      message: 'Optimization queued. Poll get_optimization_status with this jobId to track progress -- a full run typically takes several minutes to over an hour depending on maxExperiments.',
    })
  }))

  server.tool('get_optimization_status', 'Check progress of a Strategy Lab optimization run started with start_optimization_run. Each experiment (AI mutation + backtest) typically takes 1-2+ minutes, so poll every 15-30 seconds rather than tightly looping. Once savedVersionId appears, that strategy version holds the best result found so far -- inspect it with list_strategy_versions and promote it yourself with promote_strategy_version if you like it; Strategy Lab never does this automatically. A completed or failed run stays queryable for 24 hours.', {
    jobId: z.string().describe('Job ID returned by start_optimization_run.'),
  }, { title: 'Get Optimization Status', readOnlyHint: true }, withErrorHandling(async ({ jobId }) => {
    const raw = await api<any>(`/api/strategy-lab?jobId=${encodeURIComponent(jobId)}`)
    return jsonResult(raw)
  }))

  server.tool('cancel_optimization_run', 'Cancel a Strategy Lab optimization run you started. Takes effect after the current experiment finishes, not instantly -- check get_optimization_status to confirm it actually stopped. Any improvement already saved before cancellation stays saved.', {
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
