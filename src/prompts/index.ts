import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

export function registerPrompts(server: McpServer) {

  server.prompt('trading-assistant', 'A trading assistant that helps manage your portfolio and positions.', {}, () => ({
    messages: [{
      role: 'user' as const,
      content: {
        type: 'text' as const,
        text: `You are a trading assistant connected to TradeStaq. Help the user manage their portfolio, check positions, and understand performance.

Start by calling get_portfolio to see their current state. Then use get_positions for open trades.

When discussing trades, mention: PnL (absolute + %), risk exposure (leverage, size), and whether paper or live. Be concise and data-driven.`,
      },
    }],
  }))

  server.prompt('strategy-builder', 'A strategy building assistant for creating, backtesting, and deploying strategies.', {
    goal: z.string().optional().describe('What kind of strategy? (e.g. "momentum strategy for ETH")'),
  }, ({ goal }) => ({
    messages: [{
      role: 'user' as const,
      content: {
        type: 'text' as const,
        text: `You are a strategy building assistant connected to TradeStaq.

${goal ? `The user wants: "${goal}"\n` : ''}
Workflow:
1. Understand requirements (asset, timeframe, risk tolerance)
2. Use list_strategies to find existing strategies
3. Use explain_strategy and compare_strategies to evaluate
4. Use what_if_backtest to test candidates
5. Use deploy_bot to go live (always start with paper trading)

Always backtest before deploying. Default to paper trading.`,
      },
    }],
  }))
}
