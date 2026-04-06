import { api } from '../api.js'
import { isAuthenticated } from '../config.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

export function registerResources(server: McpServer) {

  // Portfolio overview — tradestaq://portfolio
  server.resource(
    'portfolio',
    'tradestaq://portfolio',
    { description: 'Current portfolio: balances, positions, and active bots across all exchanges.' },
    async () => {
      if (!isAuthenticated()) {
        return { contents: [{ uri: 'tradestaq://portfolio', mimeType: 'application/json', text: JSON.stringify({ error: 'Not authenticated' }) }] }
      }
      try {
        const data = await api<any>('/api/v1/portfolio')
        return {
          contents: [{
            uri: 'tradestaq://portfolio',
            mimeType: 'application/json',
            text: JSON.stringify({
              totalBalance: data.totalBalance,
              change24h: data.change24h,
              exchanges: data.exchanges?.map((e: any) => ({ name: e.name, platform: e.platform, balance: e.balance })),
              positions: data.positions?.map((p: any) => ({ symbol: p.symbol, side: p.side, pnl: p.pnl, size: p.size })),
              activeBots: data.activeBots,
            }, null, 2),
          }],
        }
      } catch (err) {
        return { contents: [{ uri: 'tradestaq://portfolio', mimeType: 'application/json', text: JSON.stringify({ error: (err as Error).message }) }] }
      }
    },
  )

  // Bot performance — tradestaq://bots
  server.resource(
    'bots',
    'tradestaq://bots',
    { description: 'All trading bots with current status, PnL, and strategy info.' },
    async () => {
      if (!isAuthenticated()) {
        return { contents: [{ uri: 'tradestaq://bots', mimeType: 'application/json', text: JSON.stringify({ error: 'Not authenticated' }) }] }
      }
      try {
        const data = await api<any>('/api/bots')
        const bots = data.bots || data.docs || []
        return {
          contents: [{
            uri: 'tradestaq://bots',
            mimeType: 'application/json',
            text: JSON.stringify(bots.map((b: any) => ({
              id: b.id || b._id, name: b.name, status: b.status,
              strategy: b.strategyName, symbol: b.symbol,
              exchange: b.exchangeName, isPaper: b.paperTrading, pnl: b.pnl,
            })), null, 2),
          }],
        }
      } catch (err) {
        return { contents: [{ uri: 'tradestaq://bots', mimeType: 'application/json', text: JSON.stringify({ error: (err as Error).message }) }] }
      }
    },
  )

  // Strategy catalog — tradestaq://strategies
  server.resource(
    'strategies',
    'tradestaq://strategies',
    { description: 'Available trading strategies with performance metrics.' },
    async () => {
      try {
        const data = await api<any>('/api/tradedroid/strategies')
        const strategies = data.strategies || data.docs || []
        return {
          contents: [{
            uri: 'tradestaq://strategies',
            mimeType: 'application/json',
            text: JSON.stringify(strategies.map((s: any) => ({
              id: s.id || s._id, name: s.name, market: s.market,
              description: s.description?.slice(0, 150),
              rating: s.rating, activeBots: s.activeBots,
            })), null, 2),
          }],
        }
      } catch (err) {
        return { contents: [{ uri: 'tradestaq://strategies', mimeType: 'application/json', text: JSON.stringify({ error: (err as Error).message }) }] }
      }
    },
  )
}
