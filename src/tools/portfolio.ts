import { z } from 'zod'
import { api } from '../api.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

export function registerPortfolioTools(server: McpServer) {

  server.tool('get_portfolio', 'Get portfolio overview: total balance, exchanges, and active bots.', {}, async () => {
    const data = await api<any>('/api/v1/portfolio')
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          totalBalance: data.totalBalance,
          change24h: data.change24h,
          exchanges: data.exchanges?.map((e: any) => ({ name: e.name, platform: e.platform, balance: e.balance })),
          openPositions: data.positions?.length ?? 0,
          activeBots: data.activeBots ?? 0,
        }, null, 2),
      }],
    }
  })

  server.tool('get_positions', 'Get all open trading positions with current PnL.', {
    exchange: z.string().optional().describe('Filter by exchange name'),
  }, async ({ exchange }) => {
    const params = new URLSearchParams()
    if (exchange) params.set('exchange', exchange)
    const data = await api<any>(`/api/v1/portfolio?${params}`)
    const positions = data.positions || []
    if (!positions.length) return { content: [{ type: 'text' as const, text: 'No open positions.' }] }
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(positions.map((p: any) => ({
          symbol: p.symbol, side: p.side, size: p.size,
          entryPrice: p.entryPrice, currentPrice: p.currentPrice,
          pnl: p.pnl, pnlPercent: p.pnlPercent, exchange: p.exchange, leverage: p.leverage,
        })), null, 2),
      }],
    }
  })
}
