import { z } from 'zod'
import { api } from '../api.js'
import { jsonResult, withErrorHandling } from '../helpers.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

export function registerCopyTradingTools(server: McpServer) {

  server.tool(
    'list_top_traders',
    'Browse the leaderboard of top-performing traders you can copy.',
    {
      period: z.enum(['7d', '30d', '90d']).default('30d').describe('Leaderboard time period'),
      sortBy: z.enum(['roi', 'pnl', 'winRate']).default('roi').describe('Sort criteria'),
      limit: z.number().min(1).max(50).default(10).describe('Number of traders to return (max 50)'),
    },
    withErrorHandling(async ({ period, sortBy, limit }) => {
      // /api/masters is the actual copy-trading "traders you can subscribe to
      // follow" listing -- /api/leaderboard (used previously) is the general
      // bot-performance leaderboard, a different endpoint with a different
      // response shape (nested `metrics.<period>.*`, no owner/pricing/follower
      // data at all), so every field below except rank came back undefined.
      const params = new URLSearchParams({ period, sortBy, limit: String(limit) })
      const data = await api<any>(`/api/masters?${params}`)
      const traders = data.docs || []
      if (!traders.length) return { content: [{ type: 'text' as const, text: 'No traders found for the selected period.' }] }
      return jsonResult(traders.map((t: any, i: number) => {
        const periodData = t.performance?.periods?.[period]
        return {
          rank: i + 1,
          masterId: t.id,
          name: t.owner?.traderAlias,
          roi: periodData?.roi ?? t.performance?.roi,
          pnl: periodData?.pnl ?? t.performance?.pnl,
          winRate: periodData?.winRate ?? t.performance?.winRate,
          totalTrades: periodData?.trades ?? t.performance?.totalTrades,
          followers: t.followerCount,
          isPaid: t.pricing?.isFree === false,
          price: t.pricing?.monthlyPrice,
        }
      }))
    }),
  )

  server.tool(
    'follow_trader',
    'Subscribe to copy a top trader\'s trades. WARNING: This commits capital to copy trading.',
    {
      masterId: z.string().describe('ID of the trader to follow'),
      exchangeId: z.string().describe('Your exchange account to trade on'),
      multiplier: z.number().min(0.1).max(10).default(1).describe('Trade size multiplier relative to the master\'s trades'),
    },
    withErrorHandling(async ({ masterId, exchangeId, multiplier }) => {
      const data = await api<any>(`/api/masters/${masterId}/subscribe`, {
        method: 'POST',
        body: { exchangeId, multiplier },
      })
      return {
        content: [{
          type: 'text' as const,
          text: `Subscribed to copy trader.\nSubscription ID: ${data.id || data._id}\nMaster: ${data.masterAlias || masterId}\nExchange: ${data.exchangeName || exchangeId}\nMultiplier: ${multiplier}x\n\nYour account will now mirror this trader's positions.`,
        }],
      }
    }),
  )
}
