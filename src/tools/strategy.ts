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
    const data = await api<any>(`/api/tradedroid/strategies/${id}`)
    return jsonResult({
      id: data.id || data._id, name: data.name, description: data.description,
      market: data.market, timeframe: data.timeframe,
      indicators: data.indicators, performance: data.performance,
    })
  }))

  server.tool('explain_strategy', 'Get a plain-English explanation of a strategy: what it does, risk profile, best market conditions.', {
    id: z.string().describe('Strategy ID'),
  }, withErrorHandling(async ({ id }) => {
    const data = await api<any>(`/api/tradedroid/strategies/${id}`)
    const lines: string[] = [`## ${data.name}`]
    if (data.description) lines.push(`\n${data.description}`)
    if (data.market) lines.push(`\n**Market:** ${data.market}`)
    if (data.timeframe) lines.push(`**Timeframe:** ${data.timeframe}`)
    if (data.indicators?.length) lines.push(`**Indicators:** ${data.indicators.join(', ')}`)
    if (data.performance) {
      const p = data.performance
      lines.push('\n**Performance:**')
      if (p.roi != null) lines.push(`- ROI: ${p.roi}%`)
      if (p.maxDrawdown != null) lines.push(`- Max Drawdown: ${p.maxDrawdown}%`)
      if (p.winRate != null) lines.push(`- Win Rate: ${p.winRate}%`)
      if (p.sharpeRatio != null) lines.push(`- Sharpe Ratio: ${p.sharpeRatio}`)
    }
    return { content: [{ type: 'text' as const, text: lines.join('\n') }] }
  }))

  server.tool('compare_strategies', 'Compare multiple strategies side by side on key metrics.', {
    ids: z.array(z.string()).min(2).max(5).describe('Strategy IDs to compare'),
  }, withErrorHandling(async ({ ids }) => {
    const strategies = await Promise.all(ids.map((id: string) => api<any>(`/api/tradedroid/strategies/${id}`)))
    return jsonResult(strategies.map(s => ({
      name: s.name, id: s.id || s._id, market: s.market, timeframe: s.timeframe,
      roi: s.performance?.roi, maxDrawdown: s.performance?.maxDrawdown,
      winRate: s.performance?.winRate, sharpeRatio: s.performance?.sharpeRatio,
    })))
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
}
