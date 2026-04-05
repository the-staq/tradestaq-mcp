import { z } from 'zod'
import { api } from '../api.js'
import { jsonResult, withErrorHandling } from '../helpers.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

export function registerStrategyTools(server: McpServer) {

  server.tool('list_strategies', 'List available trading strategies.', {
    owned: z.boolean().default(false).describe('If true, only show your own strategies'),
  }, withErrorHandling(async ({ owned }) => {
    const endpoint = owned ? '/api/user-strategies' : '/api/tradedroid/strategies'
    const data = await api<any>(endpoint)
    const strategies = data.strategies || data.docs || []
    return jsonResult(strategies.map((s: any) => ({
      id: s.id || s._id, name: s.name, description: s.description?.slice(0, 200),
      market: s.market, timeframe: s.timeframe, price: s.price, rating: s.rating,
    })))
  }))

  server.tool('get_strategy', 'Get detailed info about a specific strategy.', {
    id: z.string().describe('Strategy ID'),
  }, withErrorHandling(async ({ id }) => {
    const raw = await api<any>(`/api/tradedroid/strategies/${id}`)
    const s = raw.doc || raw
    return jsonResult({
      id: s.id || s._id,
      name: s.name,
      description: s.description,
      market: s.market,
      category: s.category,
      tags: s.tags,
      strategyType: s.strategyType,
      stats: s.stats,
      backtest: s.backtest,
      latestVersion: s.latestVersion ? { timeframe: s.latestVersion.timeframe, indicators: s.latestVersion.indicators } : undefined,
      dcaConfig: s.dcaConfig,
      pricing: s.pricing,
      rating: s.rating,
      reviewCount: s.reviewCount,
      activeBots: s.activeBots,
    })
  }))

  server.tool('explain_strategy', 'Get a plain-English explanation of a strategy: what it does, risk profile, best market conditions.', {
    id: z.string().describe('Strategy ID'),
  }, withErrorHandling(async ({ id }) => {
    const raw = await api<any>(`/api/tradedroid/strategies/${id}`)
    const s = raw.doc || raw
    const lines: string[] = [`## ${s.name}`]
    if (s.description) lines.push(`\n${s.description}`)
    if (s.market) lines.push(`\n**Market:** ${s.market}`)
    if (s.category) lines.push(`**Category:** ${s.category}`)
    if (s.tags?.length) lines.push(`**Tags:** ${s.tags.join(', ')}`)
    if (s.latestVersion?.timeframe) lines.push(`**Timeframe:** ${s.latestVersion.timeframe}`)
    if (s.stats) {
      const st = s.stats
      lines.push('\n**Performance:**')
      if (st.roi != null) lines.push(`- ROI: ${st.roi}%`)
      if (st.maxDrawdown != null) lines.push(`- Max Drawdown: ${st.maxDrawdown}%`)
      if (st.winRate != null) lines.push(`- Win Rate: ${st.winRate}%`)
      if (st.sharpeRatio != null) lines.push(`- Sharpe Ratio: ${st.sharpeRatio}`)
      if (st.profitFactor != null) lines.push(`- Profit Factor: ${st.profitFactor}`)
    }
    if (s.rating) lines.push(`\n**Rating:** ${s.rating}/5 (${s.reviewCount || 0} reviews)`)
    if (s.activeBots) lines.push(`**Active Bots:** ${s.activeBots}`)
    return { content: [{ type: 'text' as const, text: lines.join('\n') }] }
  }))

  server.tool('compare_strategies', 'Compare multiple strategies side by side on key metrics.', {
    ids: z.array(z.string()).min(2).max(5).describe('Strategy IDs to compare'),
  }, withErrorHandling(async ({ ids }) => {
    const results = await Promise.all(ids.map((id: string) => api<any>(`/api/tradedroid/strategies/${id}`)))
    return jsonResult(results.map(raw => {
      const s = raw.doc || raw
      return {
        name: s.name, id: s.id || s._id, market: s.market,
        roi: s.stats?.roi, maxDrawdown: s.stats?.maxDrawdown,
        winRate: s.stats?.winRate, sharpeRatio: s.stats?.sharpeRatio,
        rating: s.rating, activeBots: s.activeBots,
      }
    }))
  }))

  server.tool('create_strategy', 'Create a new trading strategy from TradeDroid code.', {
    name: z.string().describe('Strategy name'),
    description: z.string().optional().describe('What the strategy does'),
    code: z.string().describe('TradeDroid strategy code'),
    market: z.enum(['spot', 'futures']).default('futures'),
    timeframe: z.string().default('1h'),
  }, withErrorHandling(async ({ name, description, code, market, timeframe }) => {
    const data = await api<any>('/api/user-strategies', { method: 'POST', body: { name, description, code, market, timeframe } })
    return { content: [{ type: 'text' as const, text: `Strategy "${name}" created.\nID: ${data.id || data._id}\n\nBacktest it with what_if_backtest or deploy with deploy_bot.` }] }
  }))

  server.tool('generate_strategy', 'Generate a trading strategy from a natural language description using AI. Describe what you want and AI creates the TradeDroid code.', {
    description: z.string().describe('Natural language description of the strategy you want (e.g. "momentum strategy for ETH that buys on RSI oversold and sells on RSI overbought")'),
    market: z.enum(['spot', 'futures']).default('futures'),
    timeframe: z.string().default('1h').describe('Primary timeframe (e.g. 1h, 4h, 1d)'),
  }, withErrorHandling(async ({ description, market, timeframe }) => {
    // The AI builder endpoint is a streaming endpoint, but for MCP we just need the final result
    // Call it as a regular POST and collect the response
    const data = await api<any>('/api/ai/strategy-builder', {
      method: 'POST',
      body: {
        messages: [{ role: 'user', content: description }],
        market,
        timeframe,
      },
      timeout: 120_000, // AI generation can take a while
    })

    // The response may be a stream or a JSON object depending on the endpoint
    // If it has a strategy object, return it
    if (data.strategy) {
      return jsonResult({
        name: data.strategy.name,
        code: data.strategy.code,
        description: data.strategy.description,
        market,
        timeframe,
        message: 'Strategy generated. Use create_strategy to save it, or what_if_backtest to test it first.',
      })
    }

    // If the response is just text/content, return it as-is
    return { content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] }
  }))
}
