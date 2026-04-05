import { describe, it, expect } from 'vitest'
import { filterStrategies, computeMarketContext } from '../src/tools/advisor.js'
import type { StrategyData, CandleData } from '../src/tools/advisor.js'

// ── Test data factories ─────────────────────────────────────────

function makeStrategy(overrides: Partial<StrategyData> = {}): StrategyData {
  return {
    _id: 'strat-1',
    name: 'BTC Momentum',
    description: 'Momentum strategy for Bitcoin',
    market: 'futures',
    timeframe: '1h',
    performance: {
      roi: 25,
      maxDrawdown: 8,
      winRate: 62,
      sharpeRatio: 1.5,
      profitFactor: 2.1,
    },
    ...overrides,
  }
}

function makeCandles(count: number, opts: { trend?: 'up' | 'down' | 'flat'; volatility?: 'high' | 'low' } = {}): CandleData[] {
  const { trend = 'flat', volatility = 'low' } = opts
  const basePrice = 50000
  const spread = volatility === 'high' ? 2000 : 200

  return Array.from({ length: count }, (_, i) => {
    let close = basePrice
    if (trend === 'up') close = basePrice + (i / count) * 5000
    else if (trend === 'down') close = basePrice - (i / count) * 5000

    return {
      open: close - spread * 0.1,
      high: close + spread * 0.5,
      low: close - spread * 0.5,
      close,
      volume: 100,
      timestamp: new Date(Date.now() - (count - i) * 3600000).toISOString(),
    }
  })
}

// ── filterStrategies tests ──────────────────────────────────────

describe('filterStrategies', () => {
  const strategies: StrategyData[] = [
    makeStrategy({ _id: 'a', name: 'BTC Conservative', performance: { roi: 10, maxDrawdown: 5, winRate: 70, sharpeRatio: 2.0 } }),
    makeStrategy({ _id: 'b', name: 'ETH Aggressive', performance: { roi: 80, maxDrawdown: 35, winRate: 48, sharpeRatio: 0.8 } }),
    makeStrategy({ _id: 'c', name: 'SOL Moderate', performance: { roi: 30, maxDrawdown: 15, winRate: 55, sharpeRatio: 1.2 } }),
    makeStrategy({ _id: 'd', name: 'BTC Scalper', performance: { roi: 50, maxDrawdown: 12, winRate: 58, sharpeRatio: 1.8 } }),
    makeStrategy({ _id: 'e', name: 'DOGE Yolo', performance: { roi: 120, maxDrawdown: 60, winRate: 40, sharpeRatio: 0.3 } }),
    makeStrategy({ _id: 'f', name: 'ADA Steady', performance: { roi: 8, maxDrawdown: 3, winRate: 75, sharpeRatio: 2.5 } }),
  ]

  it('conservative: filters by low drawdown and high win rate', () => {
    const result = filterStrategies(strategies, { riskTolerance: 'conservative' })
    // Default maxDrawdown 10, winRate > 55
    expect(result.every(s => (s.performance?.maxDrawdown ?? 0) < 10)).toBe(true)
    expect(result.every(s => (s.performance?.winRate ?? 0) > 55)).toBe(true)
  })

  it('moderate: allows higher drawdown and lower win rate', () => {
    const result = filterStrategies(strategies, { riskTolerance: 'moderate' })
    // Default maxDrawdown 20, winRate > 45
    expect(result.length).toBeGreaterThan(0)
    expect(result.every(s => (s.performance?.maxDrawdown ?? 0) < 20)).toBe(true)
  })

  it('aggressive: no drawdown filter, sorts by ROI', () => {
    const result = filterStrategies(strategies, { riskTolerance: 'aggressive' })
    expect(result.length).toBe(5) // capped at 5
    expect(result[0]._id).toBe('e') // highest ROI (120)
  })

  it('preferredAssets filters by name/description', () => {
    const result = filterStrategies(strategies, { riskTolerance: 'aggressive', preferredAssets: ['ETH'] })
    expect(result.length).toBe(1)
    expect(result[0]._id).toBe('b')
  })

  it('minSharpe filters by Sharpe ratio', () => {
    const result = filterStrategies(strategies, { riskTolerance: 'aggressive', minSharpe: 1.5 })
    expect(result.every(s => (s.performance?.sharpeRatio ?? 0) >= 1.5)).toBe(true)
  })

  it('relaxed mode widens drawdown by 1.5x and sharpe by 0.5x', () => {
    // Strict conservative with maxDrawdown=5 filters out most
    const strict = filterStrategies(strategies, { riskTolerance: 'conservative', maxDrawdown: 5 })
    // Relaxed: maxDrawdown becomes 5*1.5=7.5
    const relaxed = filterStrategies(strategies, { riskTolerance: 'conservative', maxDrawdown: 5 }, true)
    expect(relaxed.length).toBeGreaterThanOrEqual(strict.length)
  })

  it('returns max 5 sorted by ROI descending', () => {
    const result = filterStrategies(strategies, { riskTolerance: 'aggressive' })
    expect(result.length).toBeLessThanOrEqual(5)
    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1].performance?.roi).toBeGreaterThanOrEqual(result[i].performance?.roi ?? 0)
    }
  })

  it('returns empty array when nothing matches', () => {
    const result = filterStrategies(strategies, { riskTolerance: 'conservative', maxDrawdown: 1 })
    expect(result).toEqual([])
  })
})

// ── computeMarketContext tests ──────────────────────────────────

describe('computeMarketContext', () => {
  it('returns error when fewer than 30 candles', () => {
    const result = computeMarketContext('BTC/USDT', '4h', makeCandles(20))
    expect('error' in result && result.error).toBe('Not enough candle data')
    expect('candleCount' in result && result.candleCount).toBe(20)
  })

  it('detects bullish trend', () => {
    const result = computeMarketContext('BTC/USDT', '4h', makeCandles(50, { trend: 'up' }))
    expect('trend' in result && result.trend).toBe('bullish')
  })

  it('detects bearish trend', () => {
    const result = computeMarketContext('BTC/USDT', '4h', makeCandles(50, { trend: 'down' }))
    expect('trend' in result && result.trend).toBe('bearish')
  })

  it('detects sideways trend', () => {
    const result = computeMarketContext('BTC/USDT', '4h', makeCandles(50, { trend: 'flat' }))
    expect('trend' in result && result.trend).toBe('sideways')
  })

  it('classifies high volatility', () => {
    const result = computeMarketContext('BTC/USDT', '4h', makeCandles(50, { volatility: 'high' }))
    expect('volatility' in result && result.volatility).toBe('high')
  })

  it('classifies low volatility', () => {
    const result = computeMarketContext('BTC/USDT', '4h', makeCandles(50, { volatility: 'low' }))
    expect('volatility' in result && result.volatility).toBe('low')
  })

  it('computes support and resistance from last 20 candles', () => {
    const candles = makeCandles(50, { trend: 'up' })
    const result = computeMarketContext('BTC/USDT', '4h', candles)
    if ('error' in result) throw new Error('unexpected error')

    const last20 = candles.slice(-20)
    expect(result.support).toBe(Math.min(...last20.map(c => c.low)))
    expect(result.resistance).toBe(Math.max(...last20.map(c => c.high)))
  })

  it('returns valid ATR14 value', () => {
    const result = computeMarketContext('BTC/USDT', '4h', makeCandles(50))
    if ('error' in result) throw new Error('unexpected error')
    expect(result.atr14).toBeGreaterThan(0)
    expect(typeof result.atr14).toBe('number')
  })
})
