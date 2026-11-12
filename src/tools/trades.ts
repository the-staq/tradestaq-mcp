import { z } from 'zod'
import { api, ApiError } from '../api.js'
import { closedTrades } from '../closed-trades.js'
import { jsonResult, withErrorHandling } from '../helpers.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

// An exchange account ID (a MongoDB ObjectId), as list_exchanges returns it.
const OBJECT_ID = /^[a-f0-9]{24}$/i

/**
 * The account ID to filter by. GET /api/trades/history filters only on `exchangeId` and
 * ignores `exchange`, so a platform or account name is resolved through list_exchanges'
 * source; a name more than one account matches is refused rather than guessed.
 */
async function resolveExchangeId(value: string): Promise<string> {
  if (OBJECT_ID.test(value)) return value
  const data = await api<any>('/api/exchanges')
  const accounts: any[] = data?.exchanges || data?.docs || []
  const wanted = value.trim().toLowerCase()
  const hits = accounts.filter((e) => [e?.platform, e?.name].some((x) => typeof x === 'string' && x.toLowerCase() === wanted))
  if (hits.length === 1) return String(hits[0].id || hits[0]._id)
  if (!hits.length) {
    throw new ApiError(400, 'EXCHANGE_NOT_FOUND', `No connected exchange account matches "${value}". Pass exchangeId: an account ID from list_exchanges.`, false)
  }
  const options = hits.map((e) => `${e.id || e._id} (${e.name || e.platform})`).join('; ')
  throw new ApiError(400, 'EXCHANGE_AMBIGUOUS', `${hits.length} exchange accounts match "${value}": ${options}. Pass one of them as exchangeId.`, false)
}

export function registerTradeTools(server: McpServer) {

  server.tool('get_trade_history', 'Get the user\'s closed trades, newest first: one row per close, with direction (long/short), entry and exit price, size, P&L (net of fees where booked), the return on position size, and when it opened and closed. Use it to review past trades or report on them. Read-only. Pages hold up to `limit` stored records, and a close is stored as an exit record plus the entry record(s) it closed, so a page usually lists about half that many trades: keep paging while hasMore is true. A trade with noExitRecord: true was closed by TradeStaq\'s reconcile after the exchange position was already gone; it is a real close, but get_performance_metrics leaves it out. For aggregate metrics (ROI, win rate, Sortino) use get_performance_metrics instead.', {
    exchangeId: z.string().optional().describe('Optional filter: one exchange account ID from list_exchanges. Omit for all accounts.'),
    exchange: z.string().optional().describe('Optional filter by account instead of exchangeId: an account ID, or a platform or account name as list_exchanges shows it (e.g. "bitget"). Refused when more than one account matches.'),
    symbol: z.string().optional().describe('Optional filter by trading pair, e.g. "BTC/USDT". Omit for all pairs.'),
    limit: z.number().default(50).describe('Number of stored records to read, max 200 (about half as many trades). Defaults to 50.'),
    page: z.number().default(1).describe('Page number for pagination (1-based). Defaults to 1.'),
  }, { title: 'Get Trade History', readOnlyHint: true }, withErrorHandling(async ({ exchangeId, exchange, symbol, limit, page }) => {
    const params = new URLSearchParams()
    const account = exchangeId || exchange
    if (account) params.set('exchangeId', await resolveExchangeId(account))
    if (symbol) params.set('symbol', symbol)
    params.set('limit', String(Math.min(limit, 200)))
    params.set('page', String(page))
    const data = await api<any>(`/api/trades/history?${params}`)
    const records = Array.isArray(data?.trades) ? data.trades : Array.isArray(data) ? data : []
    const hasMore = data?.pagination?.hasMore === true
    const trades = closedTrades(records)
    if (!trades.length) {
      const text = hasMore
        ? `No closed trades on page ${page}, but more records exist: try page ${page + 1}.`
        : 'No closed trades found.'
      return { content: [{ type: 'text' as const, text }] }
    }
    return jsonResult({ page, hasMore, trades })
  }))

  server.tool('get_performance_metrics', 'Get aggregate trading performance metrics over a time range: ROI, win rate, total P&L, and Sortino ratio. Use it to summarize how the user (or a subset of their trading) is performing. Read-only. For a list of individual trades use get_trade_history.', {
    timeRange: z.enum(['today', '7d', '30d', '90d']).default('30d').describe('Window for the metrics: today, 7d, 30d, or 90d. Defaults to 30d.'),
    tradeType: z.enum(['live', 'paper']).optional().describe('Optional filter: "live" or "paper" trades only. Omit to include both.'),
    exchangeId: z.string().optional().describe('Optional filter to a single exchange account ID (from list_exchanges). Omit for all.'),
  }, { title: 'Get Performance Metrics', readOnlyHint: true }, withErrorHandling(async ({ timeRange, tradeType, exchangeId }) => {
    const params = new URLSearchParams()
    params.set('timeRange', timeRange)
    if (tradeType) params.set('tradeType', tradeType)
    if (exchangeId) params.set('exchangeId', exchangeId)
    const data = await api<any>(`/api/trades/metrics?${params}`)
    return jsonResult(data)
  }))
}
