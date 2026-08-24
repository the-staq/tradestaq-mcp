import { z } from 'zod'
import { api, ApiError } from '../api.js'
import { jsonResult, withErrorHandling } from '../helpers.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

export function registerStrategyTools(server: McpServer) {

  server.tool('list_strategies', 'List available trading strategies — either the public marketplace or the user\'s own library. Supports filtering and sorting. Use it to discover strategies to backtest or deploy, or to find strategy IDs for get_strategy, compare_strategies, and deploy_bot. Read-only.', {
    owned: z.boolean().default(false).describe('If true, return only the user\'s own strategies; if false (default), return the public marketplace catalog.'),
    market: z.enum(['spot', 'futures', 'both']).optional().describe('Filter by market type.'),
    category: z.string().optional().describe('Filter by category, e.g. "official", "community", "custom".'),
    status: z.string().optional().describe('owned:true only. Filter by status, e.g. "live" or "listed" for published-only strategies. Comma-separate multiple values, e.g. "live,listed".'),
    pricing: z.enum(['free', 'paid']).optional().describe('owned:false only. Filter by pricing.'),
    search: z.string().optional().describe('Filter by a name/description substring match.'),
    sort: z.enum(['newest', 'oldest', 'name', 'downloads', 'popular', 'rating', 'roi', 'winRate', 'trending']).optional()
      .describe('Sort order. owned:true supports newest (default), oldest, name, downloads. owned:false (marketplace) additionally supports popular, rating, roi, winRate, trending.'),
    limit: z.number().min(1).max(100).default(50).describe('Max results to return, 1-100. Defaults to 50.'),
  }, { title: 'List Strategies', readOnlyHint: true }, withErrorHandling(async ({ owned, market, category, status, pricing, search, sort, limit }) => {
    const params = new URLSearchParams({ limit: String(limit) })
    if (market) params.set('market', market)
    if (category) params.set('category', category)
    if (search) params.set('search', search)
    if (sort) params.set('sort', sort)
    if (owned) {
      if (status) params.set('status', status)
    } else {
      params.set('marketplace', 'true')
      if (pricing) params.set('pricing', pricing)
    }
    const endpoint = `${owned ? '/api/user-strategies' : '/api/tradedroid/strategies'}?${params}`
    const data = await api<any>(endpoint)
    // /api/user-strategies wraps its list under `data`; /api/tradedroid/strategies
    // returns the raw Payload pagination object (`docs`). Neither ever uses
    // `strategies` — that key was a bug, always producing an empty list.
    const strategies = data.data || data.docs || []
    return jsonResult(strategies.map((s: any) => ({
      id: s.id || s._id, name: s.name, description: s.description?.slice(0, 200),
      market: s.market, timeframe: s.timeframe, price: s.price, rating: s.rating,
      ...(owned ? { status: s.status, category: s.category } : {}),
    })))
  }))

  server.tool('get_strategy', 'Get full details for a specific strategy by ID: description, market/timeframe, performance stats, rating, code, and parameters. Use it to inspect a strategy before backtesting, deploying, comparing, or editing with update_strategy. Read-only. Get IDs from list_strategies; use compare_strategies for side-by-side comparison and explain_strategy for a plain-English breakdown. `code` is included when you own the strategy (or it\'s a forkable community strategy you have access to); omitted otherwise.', {
    id: z.string().describe('The strategy ID to fetch, obtained from list_strategies.'),
  }, { title: 'Get Strategy', readOnlyHint: true }, withErrorHandling(async ({ id }) => {
    // /api/user-strategies/:id is the owner-authoritative endpoint: it
    // resolves `code`/parameterGroups/mtfConfig/dcaConfig/primaryTimeframe
    // against the real latest-or-stable version doc (healing an orphaned
    // latestVersion reference), and is the same endpoint update_strategy's
    // PATCH targets -- so what this returns is exactly what a PATCH would
    // be editing. The marketplace endpoint has no such version-resolution
    // fallback and strips `code` entirely for anyone who isn't the author,
    // so it's only used as a fallback for a strategy this caller doesn't
    // own (a 403/404 from the owner-only endpoint just means "not yours").
    let s: any
    let owned = true
    try {
      const raw = await api<any>(`/api/user-strategies/${id}`)
      s = raw.data || raw
    } catch (err: any) {
      if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
        owned = false
        const raw = await api<any>(`/api/tradedroid/strategies/${id}`)
        s = raw.doc || raw
      } else {
        throw err
      }
    }

    // Marketplace responses nest version fields under `latestVersion`; the
    // owner-authoritative response already resolves them onto the doc
    // itself (see comment above).
    const versionSource = owned ? s : (s.latestVersion || {})
    const parameterGroups = (versionSource.parameterGroups || []).map((g: any) => ({
      group: g.groupName || g.group,
      parameters: (g.parameters || []).map((p: any) => ({
        name: p.name,
        label: p.label,
        type: p.inputType,
        default: p.defaultValue,
        ...(p.tooltip ? { description: p.tooltip } : {}),
        ...(p.options ? { options: p.options } : {}),
        ...(p.rangeMin != null ? { min: p.rangeMin } : {}),
        ...(p.rangeMax != null ? { max: p.rangeMax } : {}),
      })),
    }))

    return jsonResult({
      id: s.id || s._id,
      name: s.name,
      description: s.description,
      market: s.market,
      category: s.category,
      tags: s.tags,
      strategyType: s.strategyType,
      status: s.status,
      // version/requiredIndicators live only on the version doc and aren't
      // surfaced by the owner-authoritative endpoint's response shape.
      version: owned ? undefined : (versionSource.semanticVersion || versionSource.version),
      timeframe: owned ? s.primaryTimeframe : versionSource.validationConfig?.timeframe,
      requiredIndicators: owned ? undefined : versionSource.requiredIndicators,
      parameterGroups,
      dcaConfig: s.dcaConfig,
      code: s.code,
      stats: s.stats,
      pricing: s.pricing,
      rating: s.rating,
      reviewCount: s.reviewCount,
      activeBots: s.activeBots,
    })
  }))

  server.tool('explain_strategy', 'Get a plain-English explanation of a strategy: what it does, risk profile, best market conditions.', {
    id: z.string().describe('Strategy ID'),
  }, withErrorHandling(async ({ id }) => {
    const raw = await api<any>(`/api/tradedroid/strategies/${id}`)
    const s = raw.doc || raw
    const lines: string[] = [`## ${s.name}`]
    if (s.description) lines.push(`\n${s.description}`)
    if (s.market) lines.push(`\n**Market:** ${s.market}`)
    if (s.category) lines.push(`**Category:** ${s.category}`)
    if (s.tags?.length) lines.push(`**Tags:** ${s.tags.join(', ')}`)
    if (s.latestVersion?.timeframe) lines.push(`**Timeframe:** ${s.latestVersion.timeframe}`)
    if (s.stats) {
      const st = s.stats
      lines.push('\n**Performance:**')
      if (st.roi != null) lines.push(`- ROI: ${st.roi}%`)
      if (st.maxDrawdown != null) lines.push(`- Max Drawdown: ${st.maxDrawdown}%`)
      if (st.winRate != null) lines.push(`- Win Rate: ${st.winRate}%`)
      if (st.sharpeRatio != null) lines.push(`- Sharpe Ratio: ${st.sharpeRatio}`)
      if (st.profitFactor != null) lines.push(`- Profit Factor: ${st.profitFactor}`)
    }
    if (s.rating) lines.push(`\n**Rating:** ${s.rating}/5 (${s.reviewCount || 0} reviews)`)
    if (s.activeBots) lines.push(`**Active Bots:** ${s.activeBots}`)
    return { content: [{ type: 'text' as const, text: lines.join('\n') }] }
  }))

  server.tool('compare_strategies', 'Compare 2-5 strategies side by side on their key performance metrics: ROI, max drawdown, win rate, Sharpe ratio, rating, and active bot count. Use this to help a user choose between strategies from the marketplace or their own library before backtesting or deploying one. Read-only. Get strategy IDs from list_strategies.', {
    ids: z.array(z.string()).min(2).max(5).describe('Array of 2-5 strategy IDs to compare, obtained from list_strategies or get_strategy.'),
  }, { title: 'Compare Strategies', readOnlyHint: true }, withErrorHandling(async ({ ids }) => {
    const results = await Promise.all(ids.map((id: string) => api<any>(`/api/tradedroid/strategies/${id}`)))
    return jsonResult(results.map(raw => {
      const s = raw.doc || raw
      return {
        name: s.name, id: s.id || s._id, market: s.market,
        roi: s.stats?.roi, maxDrawdown: s.stats?.maxDrawdown,
        winRate: s.stats?.winRate, sharpeRatio: s.stats?.sharpeRatio,
        rating: s.rating, activeBots: s.activeBots,
      }
    }))
  }))

  server.tool('create_strategy', 'Save a new trading strategy from existing TradeDroid strategy code to the user\'s library, so it can be backtested or deployed. Use this when you already have the code (hand-written or produced by generate_strategy). To create a strategy from a natural-language description instead of code, use generate_strategy. Returns the new strategy ID; validate it with what_if_backtest before deploying via deploy_bot.', {
    name: z.string().describe('Display name for the strategy, e.g. "ETH Momentum v2".'),
    description: z.string().optional().describe('Optional plain-English summary of what the strategy does and when it trades.'),
    code: z.string().describe('TradeDroid strategy code (JavaScript) — the executable logic. Get it from generate_strategy or write it directly.'),
    market: z.enum(['spot', 'futures']).default('futures').describe('"spot" for cash trading or "futures" for leveraged/perpetual contracts. Defaults to futures.'),
    timeframe: z.string().default('1h').describe('Primary candle timeframe the strategy runs on, e.g. "1h", "4h", "1d". Defaults to 1h.'),
  }, { title: 'Create Strategy', readOnlyHint: false, destructiveHint: false, idempotentHint: false }, withErrorHandling(async ({ name, description, code, market, timeframe }) => {
    const data = await api<any>('/api/user-strategies', { method: 'POST', body: { name, description, code, market, timeframe } })
    return { content: [{ type: 'text' as const, text: `Strategy "${name}" created.\nID: ${data.id || data._id}\n\nBacktest it with what_if_backtest or deploy with deploy_bot.` }] }
  }))

  server.tool(
    'update_strategy',
    'Update one of your own strategies: metadata (name, description, category, market, tags) and/or its code. Writing `code` creates or updates a DRAFT version — the currently stable/live version keeps running unaffected until you explicitly promote the draft with `status`. Use get_strategy first to see current values and status. Get the strategy ID from list_strategies(owned:true); non-admins cannot edit a suspended strategy.',
    {
      id: z.string().describe('Strategy ID to update, obtained from list_strategies(owned:true) or get_strategy.'),
      name: z.string().optional().describe('New display name. Omit to leave unchanged.'),
      description: z.string().optional().describe('New description. Omit to leave unchanged.'),
      category: z.string().optional().describe('New category. Omit to leave unchanged.'),
      market: z.enum(['spot', 'futures', 'both']).optional().describe('New market type. Omit to leave unchanged.'),
      tags: z.array(z.string()).optional().describe('Replace the strategy\'s tags. Omit to leave unchanged.'),
      code: z.string().optional().describe('New TradeDroid strategy code. This writes to a DRAFT version, never directly to the live/stable one. Validate with what_if_backtest before promoting.'),
      status: z.enum(['draft', 'testing', 'live', 'listed']).optional()
        .describe('Advance the strategy through its publish workflow. Valid transitions only: draft->testing, testing->draft|live, live->testing|listed, listed->live. An invalid transition is rejected with a 400.'),
    },
    { title: 'Update Strategy', readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    withErrorHandling(async ({ id, name, description, category, market, tags, code, status }) => {
      const body: Record<string, unknown> = {}
      if (name !== undefined) body.name = name
      if (description !== undefined) body.description = description
      if (category !== undefined) body.category = category
      if (market !== undefined) body.market = market
      if (tags !== undefined) body.tags = tags
      if (code !== undefined) body.code = code
      if (status !== undefined) body.status = status

      const raw = await api<any>(`/api/user-strategies/${id}`, { method: 'PATCH', body })
      const s = raw.data || raw
      return jsonResult({
        id: s.id || s._id, name: s.name, status: s.status,
        latestVersion: s.latestVersion, stableVersion: s.stableVersion,
        message: code !== undefined
          ? 'Strategy updated. Code changes are saved to a draft version -- run what_if_backtest against it, then set status to promote it.'
          : 'Strategy updated.',
      })
    }),
  )

  server.tool('generate_strategy', 'Generate a complete trading strategy from a natural-language description using AI (FORGE). Describe the idea and it writes runnable TradeDroid strategy code — no coding required — then saves it so you can validate with what_if_backtest and deploy with deploy_bot. The fastest path from idea to a deployable strategy. Note: AI generation is a paid, cost-bearing operation and can take up to ~2 minutes.', {
    description: z.string().describe('Natural-language description of the strategy, e.g. "momentum strategy for ETH that buys on RSI oversold and sells on RSI overbought with a 2% trailing stop".'),
    market: z.enum(['spot', 'futures']).default('futures').describe('"spot" for cash trading or "futures" for leveraged/perpetual contracts. Defaults to futures.'),
    timeframe: z.string().default('1h').describe('Primary candle timeframe the strategy runs on, e.g. "1h", "4h", "1d". Defaults to 1h.'),
  }, { title: 'Generate Strategy (AI)', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }, withErrorHandling(async ({ description, market, timeframe }) => {
    // The AI builder endpoint is a streaming endpoint, but for MCP we just need the final result
    // Call it as a regular POST and collect the response
    const data = await api<any>('/api/ai/strategy-builder', {
      method: 'POST',
      body: {
        messages: [{ role: 'user', content: description }],
        market,
        timeframe,
      },
      timeout: 120_000, // AI generation can take a while
    })

    // The response may be a stream or a JSON object depending on the endpoint
    // If it has a strategy object, return it
    if (data.strategy) {
      return jsonResult({
        name: data.strategy.name,
        code: data.strategy.code,
        description: data.strategy.description,
        market,
        timeframe,
        message: 'Strategy generated. Use create_strategy to save it, or what_if_backtest to test it first.',
      })
    }

    // If the response is just text/content, return it as-is
    return { content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] }
  }))
}
