import { z } from 'zod'
import { api } from '../api.js'
import { jsonResult, withErrorHandling } from '../helpers.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

// A bot's public share links: https://www.tradestaq.com/chart/<token>, a live chart of the
// bot's positions and trades that anyone can open without an account. The server is
// /api/bots/[id]/share (GET lists, POST creates, DELETE ?shareId= revokes). It accepts MCP
// tokens from TradeStaq v0.22.6.0; before that it answered 401 to every MCP call.
//
// Scopes: listing needs any MCP scope. Creating or revoking needs the write scope of the
// bot's account: mcp:live for a bot on a live account, mcp:paper (or mcp:live) for paper.

const EXPIRES_IN = ['1h', '24h', '7d', '30d', 'never'] as const

function shareView(s: any) {
  const expiresAt = s?.expiresAt ? String(s.expiresAt) : undefined
  return {
    id: String(s?.id ?? s?._id ?? ''),
    url: s?.url,
    expiresAt: expiresAt ?? 'never',
    expired: expiresAt ? Date.parse(expiresAt) <= Date.now() : false,
    shows: s?.permissions
      ? {
          positions: !!s.permissions.showPositions,
          trades: !!s.permissions.showTrades,
          pnl: !!s.permissions.showPnL,
          balance: !!s.permissions.showBalance,
        }
      : undefined,
    views: typeof s?.accessCount === 'number' ? s.accessCount : undefined,
    createdAt: s?.createdAt ? String(s.createdAt) : undefined,
  }
}

export function registerShareTools(server: McpServer) {

  server.tool('list_bot_share_links', 'List a bot\'s active public share links: each link\'s URL (https://www.tradestaq.com/chart/...), when it expires, what it shows (positions, trades, PnL, balance) and how often it was opened. Use it to find a link to post or send instead of creating another. Read-only. Get bot IDs from list_bots.', {
    botId: z.string().describe('The bot ID, from list_bots.'),
  }, { title: 'List Bot Share Links', readOnlyHint: true }, withErrorHandling(async ({ botId }) => {
    const data = await api<any>(`/api/bots/${encodeURIComponent(botId)}/share`)
    const shares = Array.isArray(data?.shares) ? data.shares : []
    if (!shares.length) return { content: [{ type: 'text' as const, text: 'This bot has no active share links. create_bot_share_link makes one.' }] }
    return jsonResult(shares.map(shareView))
  }))

  server.tool('create_bot_share_link', 'Create a PUBLIC link to a bot\'s live chart (https://www.tradestaq.com/chart/...) that anyone with the link can open, no account needed. It shows the bot\'s open positions and its trades by default; PnL and balance only when you turn them on. This publishes the bot\'s trading: confirm with the user what the link will show, and for how long, before calling. Check list_bot_share_links first to reuse a link. Needs write access to the bot\'s account (mcp:live for a live account). Limited to 10 links an hour. Revoke with revoke_bot_share_link.', {
    botId: z.string().describe('The bot ID, from list_bots.'),
    expiresIn: z.enum(EXPIRES_IN).describe('How long the link works: "1h", "24h", "7d", "30d" or "never".'),
    showPositions: z.boolean().default(true).describe('Show the bot\'s open positions. Defaults to true.'),
    showTrades: z.boolean().default(true).describe('Show the bot\'s trades on the chart. Defaults to true.'),
    showPnL: z.boolean().default(false).describe('Show profit and loss. Defaults to false.'),
    showBalance: z.boolean().default(false).describe('Show the account balance. Defaults to false; leave it off unless the user asks.'),
  }, { title: 'Create Bot Share Link', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }, withErrorHandling(async ({ botId, expiresIn, showPositions, showTrades, showPnL, showBalance }) => {
    // Sent once: a resend after a timeout could leave a second public link behind.
    const data = await api<any>(`/api/bots/${encodeURIComponent(botId)}/share`, {
      method: 'POST',
      retry: false,
      body: { expiresIn, permissions: { showPositions, showTrades, showPnL, showBalance } },
    })
    return jsonResult(shareView(data?.share ?? data))
  }))

  server.tool('revoke_bot_share_link', 'Turn off one of a bot\'s public share links, so its URL stops working. The link cannot be turned back on (create a new one instead). Needs write access to the bot\'s account (mcp:live for a live account). Get link IDs from list_bot_share_links.', {
    botId: z.string().describe('The bot ID, from list_bots.'),
    shareId: z.string().describe('The link\'s id, from list_bot_share_links.'),
  }, { title: 'Revoke Bot Share Link', readOnlyHint: false, destructiveHint: true, idempotentHint: true }, withErrorHandling(async ({ botId, shareId }) => {
    await api<any>(`/api/bots/${encodeURIComponent(botId)}/share?shareId=${encodeURIComponent(shareId)}`, { method: 'DELETE' })
    return { content: [{ type: 'text' as const, text: `Share link ${shareId} revoked: its URL no longer works.` }] }
  }))
}
