import { z } from 'zod'
import { api } from '../api.js'
import { jsonResult, withErrorHandling } from '../helpers.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

/**
 * The portfolio overview get_portfolio and the tradestaq://portfolio resource both return.
 * /api/v1/portfolio returns { total, change24h, exchanges, topAssets, connected } -- never
 * totalBalance/positions/activeBots. The bot count comes from a separate call.
 */
export async function fetchPortfolioSummary() {
  const [portfolioData, botsData] = await Promise.all([
    api<any>('/api/v1/portfolio'),
    api<any>('/api/bots').catch(() => ({ docs: [] })),
  ])
  const bots = botsData.docs || botsData.bots || []
  return {
    totalBalance: portfolioData.total,
    change24h: portfolioData.change24h,
    exchanges: portfolioData.exchanges?.map((e: any) => ({ name: e.name, platform: e.platform, balance: e.balance })),
    activeBots: bots.filter((b: any) => b.status === 'active').length,
  }
}

/**
 * Open positions, from /api/v1/positions (/api/v1/portfolio is a balance summary with no
 * positions array), shaped as get_positions and the portfolio resource return them.
 */
export async function fetchOpenPositions() {
  const data = await api<any>('/api/v1/positions')
  return (data.positions || []).map((p: any) => ({
    symbol: p.symbol, side: p.side, size: p.size,
    entryPrice: p.entryPrice, currentPrice: p.markPrice,
    pnl: p.pnl, pnlPercent: p.percentage, exchange: p.exchange, exchangeId: p.exchangeId, leverage: p.leverage,
  }))
}

export function registerPortfolioTools(server: McpServer) {

  server.tool('get_portfolio', 'Get portfolio overview: total balance, exchanges, and active bots.', {}, withErrorHandling(async () => {
    // Open positions are get_positions' job (this tool's own description never promised them).
    return jsonResult(await fetchPortfolioSummary())
  }))

  server.tool('get_positions', 'Get all open trading positions with current PnL.', {
    exchange: z.string().optional().describe('Filter by exchange name'),
  }, withErrorHandling(async ({ exchange }) => {
    let positions = await fetchOpenPositions()
    // The backend has no exchange-name filter param for this endpoint, so
    // filter client-side rather than sending a query param it would ignore.
    if (exchange) positions = positions.filter((p: any) => p.exchange === exchange)
    if (!positions.length) return { content: [{ type: 'text' as const, text: 'No open positions.' }] }
    return jsonResult(positions)
  }))
}
