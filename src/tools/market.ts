import { z } from 'zod'
import { api } from '../api.js'
import { jsonResult, withErrorHandling } from '../helpers.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

export function registerMarketTools(server: McpServer) {

  server.tool('get_price', 'Get the current price of a trading pair (e.g. BTC/USDT).', {
    symbol: z.string().describe('Trading pair (e.g. BTC/USDT)'),
    exchange: z.string().optional().describe('Exchange name (e.g. binance, bybit)'),
  }, withErrorHandling(async ({ symbol, exchange }) => {
    const params = new URLSearchParams({ symbol })
    if (exchange) params.set('exchange', exchange)
    const data = await api<any>(`/api/trading/price?${params}`)
    return jsonResult({ symbol: data.symbol, price: data.price, change24h: data.change24h, volume24h: data.volume24h })
  }))

  server.tool('get_candles', 'Get OHLCV candlestick data for a trading pair.', {
    symbol: z.string().describe('Trading pair (e.g. BTC/USDT)'),
    timeframe: z.enum(['1m', '5m', '15m', '1h', '4h', '1d']).default('1h'),
    limit: z.number().min(1).max(500).default(100),
    exchange: z.string().optional(),
  }, withErrorHandling(async ({ symbol, timeframe, limit, exchange }) => {
    const params = new URLSearchParams({ symbol, timeframe, limit: String(limit) })
    if (exchange) params.set('exchange', exchange)
    const data = await api<any>(`/api/charts/candles?${params}`)
    const candles = data.candles || []
    return jsonResult({
      symbol, timeframe, count: candles.length,
      latest: candles[candles.length - 1],
      range: candles.length ? {
        high: Math.max(...candles.map((c: any) => c.high)),
        low: Math.min(...candles.map((c: any) => c.low)),
      } : null,
    })
  }))

  server.tool('list_exchanges', 'List your connected exchange accounts with their IDs, platform names, and status.', {}, withErrorHandling(async () => {
    const data = await api<any>('/api/exchanges')
    const exchanges = data.exchanges || data.docs || []
    if (!exchanges.length) return { content: [{ type: 'text' as const, text: 'No exchanges connected. Connect one at https://tradestaq.com/dashboard/exchanges' }] }
    return jsonResult(exchanges.map((e: any) => ({
      id: e.id || e._id,
      name: e.name,
      platform: e.platform,
      status: e.status,
      isPaper: e.isPaper || e.paperTrading,
    })))
  }))

  server.tool('search_markets', 'Search for trading pairs on a specific exchange. Use list_exchanges to find your exchange IDs.', {
    query: z.string().describe('Search query (e.g. "BTC", "ETH/USDT")'),
    exchange: z.string().describe('Filter by exchange'),
  }, withErrorHandling(async ({ query, exchange }) => {
    const data = await api<any>(`/api/exchanges/${exchange}/markets`)
    const markets = (data.markets || [])
      .filter((m: any) => m.symbol?.toUpperCase().includes(query.toUpperCase()))
      .slice(0, 20)
    return {
      content: [{
        type: 'text' as const,
        text: markets.length
          ? JSON.stringify(markets.map((m: any) => ({ symbol: m.symbol, base: m.base, quote: m.quote, type: m.type })), null, 2)
          : `No markets found matching "${query}".`,
      }],
    }
  }))
}
