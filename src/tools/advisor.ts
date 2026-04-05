import { z } from 'zod'
import { api } from '../api.js'
import { jsonResult, withErrorHandling } from '../helpers.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

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
      const params = new URLSearchParams({ riskTolerance })
      if (maxDrawdown != null) params.set('maxDrawdown', String(maxDrawdown))
      if (preferredAssets?.length) params.set('preferredAssets', preferredAssets.join(','))
      if (minSharpe != null) params.set('minSharpe', String(minSharpe))

      const data = await api<any>(`/api/strategies/suggest?${params}`)
      return jsonResult(data)
    }),
  )

  server.tool(
    'get_market_context',
    'Get market context for a symbol: trend direction, volatility level, support/resistance levels.',
    {
      symbol: z.string().describe('Trading pair (e.g. BTC/USDT)'),
      timeframe: z.enum(['1h', '4h', '1d']).default('4h').describe('Candle timeframe'),
      exchangeId: z.string().describe('Exchange account ID (use list_exchanges to find)'),
    },
    withErrorHandling(async ({ symbol, timeframe, exchangeId }) => {
      const params = new URLSearchParams({ symbol, timeframe, exchangeId })
      const data = await api<any>(`/api/market-context?${params}`)
      return jsonResult(data)
    }),
  )
}
