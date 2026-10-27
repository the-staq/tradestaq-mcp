import { api, hasUsableToken } from '../api.js'
import { fetchOpenPositions, fetchPortfolioSummary } from '../tools/portfolio.js'
import { botSummary } from '../tools/bot.js'
import { strategySummary } from '../tools/strategy.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

// Each resource returns exactly what its tool returns (get_portfolio + get_positions,
// list_bots, list_strategies), through the same functions. Their own copies read fields
// the API never sends (totalBalance, activeBots, strategyName, paperTrading, ...), so they
// came back mostly empty while the tools were right.

const json = (uri: string, body: unknown) => ({
  contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(body, null, 2) }],
})

export function registerResources(server: McpServer) {

  // Portfolio overview — tradestaq://portfolio
  server.resource(
    'portfolio',
    'tradestaq://portfolio',
    { description: 'Current portfolio: balances, positions, and active bots across all exchanges.' },
    async () => {
      const uri = 'tradestaq://portfolio'
      if (!(await hasUsableToken())) return json(uri, { error: 'Not authenticated' })
      try {
        // Positions are their own endpoint; one that fails leaves the summary standing.
        const [summary, positions] = await Promise.all([
          fetchPortfolioSummary(),
          fetchOpenPositions().catch((err: Error) => ({ error: err.message })),
        ])
        return json(uri, Array.isArray(positions) ? { ...summary, positions } : { ...summary, positions: [], positionsError: positions.error })
      } catch (err) {
        return json(uri, { error: (err as Error).message })
      }
    },
  )

  // Bot performance — tradestaq://bots
  server.resource(
    'bots',
    'tradestaq://bots',
    { description: 'All trading bots with current status, PnL, and strategy info.' },
    async () => {
      const uri = 'tradestaq://bots'
      if (!(await hasUsableToken())) return json(uri, { error: 'Not authenticated' })
      try {
        const data = await api<any>('/api/bots')
        return json(uri, (data.docs || data.bots || []).map(botSummary))
      } catch (err) {
        return json(uri, { error: (err as Error).message })
      }
    },
  )

  // Strategy catalog — tradestaq://strategies
  server.resource(
    'strategies',
    'tradestaq://strategies',
    { description: 'Available trading strategies with performance metrics.' },
    async () => {
      const uri = 'tradestaq://strategies'
      try {
        // The public marketplace catalog, as list_strategies returns it by default.
        const data = await api<any>('/api/tradedroid/strategies?limit=50&marketplace=true')
        return json(uri, (data.docs || []).map(strategySummary))
      } catch (err) {
        return json(uri, { error: (err as Error).message })
      }
    },
  )
}
