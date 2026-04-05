import { z } from 'zod'
import { api } from '../api.js'
import { jsonResult, withErrorHandling } from '../helpers.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

// ── Exported pure functions (testable without MCP) ──────────────

export interface StrategyData {
  id?: string
  _id?: string
  name?: string
  description?: string
  market?: string
  timeframe?: string
  performance?: {
    roi?: number
    maxDrawdown?: number
    winRate?: number
    sharpeRatio?: number
    profitFactor?: number
  }
}

export interface FilterParams {
  riskTolerance: 'conservative' | 'moderate' | 'aggressive'
  maxDrawdown?: number
  preferredAssets?: string[]
  minSharpe?: number
}

export function filterStrategies(
  strategies: StrategyData[],
  params: FilterParams,
  relaxed: boolean = false,
): StrategyData[] {
  const drawdownMultiplier = relaxed ? 1.5 : 1
  const sharpeMultiplier = relaxed ? 0.5 : 1

  let filtered = strategies.filter(s => {
    const perf = s.performance || {}
    const dd = perf.maxDrawdown ?? 0
    const wr = perf.winRate ?? 0

    if (params.riskTolerance === 'conservative') {
      const limit = (params.maxDrawdown || 10) * drawdownMultiplier
      if (dd >= limit || wr <= 55) return false
    } else if (params.riskTolerance === 'moderate') {
      const limit = (params.maxDrawdown || 20) * drawdownMultiplier
      if (dd >= limit || wr <= 45) return false
    }

    if (params.preferredAssets?.length) {
      const haystack = `${s.name || ''} ${s.description || ''}`.toUpperCase()
      if (!params.preferredAssets.some(a => haystack.includes(a.toUpperCase()))) return false
    }

    if (params.minSharpe != null) {
      const threshold = params.minSharpe * sharpeMultiplier
      if ((perf.sharpeRatio ?? 0) < threshold) return false
    }

    return true
  })

  filtered.sort((a, b) => ((b.performance?.roi ?? 0) - (a.performance?.roi ?? 0)))
  return filtered.slice(0, 5)
}

export interface CandleData {
  open: number
  high: number
  low: number
  close: number
  volume?: number
  timestamp?: string
}

export interface MarketContext {
  symbol: string
  timeframe: string
  trend: 'bullish' | 'bearish' | 'sideways'
  volatility: 'high' | 'medium' | 'low'
  atr14: number
  support: number
  resistance: number
  dataAsOf: string
}

export function computeMarketContext(
  symbol: string,
  timeframe: string,
  candles: CandleData[],
): MarketContext | { error: string; candleCount: number } {
  if (candles.length < 30) {
    return { error: 'Not enough candle data', candleCount: candles.length }
  }

  // Trend: compare first 20 avg close vs last 20 avg close
  const first20Avg = candles.slice(0, 20).reduce((sum, c) => sum + c.close, 0) / 20
  const last20Avg = candles.slice(-20).reduce((sum, c) => sum + c.close, 0) / 20

  let trend: 'bullish' | 'bearish' | 'sideways'
  if (last20Avg > first20Avg * 1.02) trend = 'bullish'
  else if (last20Avg < first20Avg * 0.98) trend = 'bearish'
  else trend = 'sideways'

  // ATR(14)
  let atrSum = 0
  for (let i = candles.length - 14; i < candles.length; i++) {
    const c = candles[i]
    const prev = candles[i - 1]
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prev.close),
      Math.abs(c.low - prev.close),
    )
    atrSum += tr
  }
  const atr14 = atrSum / 14

  const currentPrice = candles[candles.length - 1].close
  const atrRatio = atr14 / currentPrice

  let volatility: 'high' | 'medium' | 'low'
  if (atrRatio > 0.03) volatility = 'high'
  else if (atrRatio > 0.015) volatility = 'medium'
  else volatility = 'low'

  const last20 = candles.slice(-20)
  const support = Math.min(...last20.map(c => c.low))
  const resistance = Math.max(...last20.map(c => c.high))

  return {
    symbol,
    timeframe,
    trend,
    volatility,
    atr14,
    support,
    resistance,
    dataAsOf: new Date().toISOString(),
  }
}

// ── MCP tool registration ───────────────────────────────────────

export function registerAdvisorTools(server: McpServer) {

  server.tool(
    'suggest_strategies',
    'Suggest trading strategies matching your risk profile. Filters by risk tolerance, max drawdown, preferred assets, and minimum Sharpe ratio.',
    {
      riskTolerance: z.enum(['conservative', 'moderate', 'aggressive']).default('moderate').describe('Risk tolerance level'),
      maxDrawdown: z.number().optional().describe('Maximum acceptable drawdown % (e.g. 15)'),
      preferredAssets: z.array(z.string()).optional().describe("Preferred assets like ['BTC', 'ETH']"),
      minSharpe: z.number().optional().describe('Minimum Sharpe ratio'),
    },
    withErrorHandling(async ({ riskTolerance, maxDrawdown, preferredAssets, minSharpe }) => {
      const data = await api<any>('/api/tradedroid/strategies')
      const allStrategies = data.strategies || data.docs || []
      const params: FilterParams = { riskTolerance, maxDrawdown, preferredAssets, minSharpe }

      let strategies = filterStrategies(allStrategies, params, false)
      let filtersRelaxed = false

      if (strategies.length === 0) {
        strategies = filterStrategies(allStrategies, params, true)
        filtersRelaxed = strategies.length > 0
      }

      const mapped = strategies.map((s: any) => ({
        id: s.id || s._id,
        name: s.name,
        description: s.description?.slice(0, 200),
        market: s.market,
        timeframe: s.timeframe,
        roi: s.performance?.roi,
        maxDrawdown: s.performance?.maxDrawdown,
        winRate: s.performance?.winRate,
        sharpeRatio: s.performance?.sharpeRatio,
      }))

      return jsonResult({ strategies: mapped, ...(filtersRelaxed ? { filtersRelaxed: true } : {}) })
    }),
  )

  server.tool(
    'get_market_context',
    'Get market context for a symbol: trend direction, volatility level, support/resistance levels.',
    {
      symbol: z.string().describe('Trading pair (e.g. BTC/USDT)'),
      timeframe: z.enum(['1h', '4h', '1d']).default('4h').describe('Candle timeframe'),
      exchange: z.string().describe('Exchange name (e.g. binance, bybit)'),
    },
    withErrorHandling(async ({ symbol, timeframe, exchange }) => {
      const params = new URLSearchParams({ symbol, timeframe, limit: '100' })
      params.set('exchange', exchange)
      const data = await api<any>(`/api/charts/candles?${params}`)
      const candles: CandleData[] = data.candles || []

      const result = computeMarketContext(symbol, timeframe, candles)
      return jsonResult(result)
    }),
  )
}
