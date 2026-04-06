# TradeStaq MCP Server

[![npm version](https://img.shields.io/npm/v/@the-staq/tradestaq-mcp)](https://www.npmjs.com/package/@the-staq/tradestaq-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

**31 AI-powered trading tools for Claude, Cursor, and any MCP client.**

Create strategies, backtest them, deploy trading bots, copy top traders, monitor positions, and manage your crypto portfolio, all from conversation. Supports Binance, Bybit, OKX, Bitget, Hyperliquid, dYdX, and more.

```
"Show me my portfolio" → get_portfolio
"Backtest GhostRider on BTC/USDT for 3 months" → what_if_backtest
"Deploy it on my Binance account" → deploy_bot
"Who are the top traders this month?" → list_top_traders
"Generate a momentum strategy for ETH" → generate_strategy
```

## Quick Start

### Option A: Remote server (no install needed)

For MCP clients that support HTTP transport:

```json
{
  "mcpServers": {
    "tradestaq": {
      "url": "https://mcp.tradestaq.com/mcp"
    }
  }
}
```

### Option B: npx (recommended for local)

No clone, no build. Just add to your MCP config:

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "tradestaq": {
      "command": "npx",
      "args": ["-y", "@the-staq/tradestaq-mcp"]
    }
  }
}
```

**Cursor** (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "tradestaq": {
      "command": "npx",
      "args": ["-y", "@the-staq/tradestaq-mcp"]
    }
  }
}
```

**Claude Code:**

```sh
claude mcp add tradestaq -- npx -y @the-staq/tradestaq-mcp
```

### Option C: Clone and build

```sh
git clone https://github.com/the-staq/tradestaq-mcp.git
cd tradestaq-mcp
npm install
npm run build
```

Then point your MCP client to `dist/index.js`.

## Authenticate

After adding the server, ask your AI assistant to log in:

- **"Log me in to TradeStaq"** — uses email/password directly
- **"Authenticate with TradeStaq"** — opens a browser window for secure OAuth login

Credentials never enter the chat when using the browser flow. Token is stored locally at `~/.tradestaq/mcp-config.json` with restricted permissions (0600).

## Tools

### Auth

| Tool | Description |
|------|-------------|
| `login` | Log in with email and password |
| `authenticate` | Log in via browser (OAuth + PKCE) |
| `check_auth` | Check authentication status |
| `set_token` | Manually set a JWT token |
| `connect_exchange` | Connect an exchange account via browser |
| `logout` | Remove stored credentials |

### Market Data

| Tool | Description |
|------|-------------|
| `get_price` | Current price, 24h change, volume |
| `get_candles` | OHLCV candlestick data (1m to 1d) |
| `list_exchanges` | List connected exchange accounts |
| `search_markets` | Find trading pairs on a specific exchange |

### Portfolio

| Tool | Description |
|------|-------------|
| `get_portfolio` | Total balance, exchanges, active bots |
| `get_positions` | Open positions with live PnL |

### Strategies

| Tool | Description |
|------|-------------|
| `list_strategies` | Browse marketplace or your own strategies |
| `get_strategy` | Full strategy details and performance |
| `explain_strategy` | Plain-English explanation with risk profile |
| `compare_strategies` | Side-by-side metrics comparison |
| `create_strategy` | Create a strategy from TradeDroid code |
| `generate_strategy` | Generate a strategy from natural language using AI |

### Backtesting

| Tool | Description |
|------|-------------|
| `what_if_backtest` | Run a historical backtest (async, 30-120s) |
| `get_backtest_results` | Check status of a running backtest |

### Bot Management

| Tool | Description |
|------|-------------|
| `list_bots` | All bots with status and performance |
| `get_bot_status` | Detailed bot metrics and config |
| `deploy_bot` | Deploy a strategy as a trading bot |
| `stop_bot` | Stop a running bot |
| `close_position` | Close an open position (full or partial) |

`deploy_bot` defaults to paper trading. Pass `live: true` for real money.

### Trade History

| Tool | Description |
|------|-------------|
| `get_trade_history` | Closed trades with PnL, entry/exit prices |
| `get_performance_metrics` | ROI, win rate, Sortino ratio, PnL breakdown |

### Copy Trading

| Tool | Description |
|------|-------------|
| `list_top_traders` | Browse the leaderboard of top traders |
| `follow_trader` | Subscribe to copy a trader's trades |

### Advisor

| Tool | Description |
|------|-------------|
| `suggest_strategies` | Match strategies to your risk profile |
| `get_market_context` | Trend, volatility, support/resistance for a symbol |

## Prompt Templates

**Trading Assistant** — Start a conversation about your portfolio and positions. The AI calls `get_portfolio` and `get_positions` to ground its responses in your actual data.

**Strategy Builder** — Walk through creating, backtesting, and deploying a strategy. Pass an optional `goal` like "momentum strategy for ETH" to get focused suggestions.

**Portfolio Reviewer** — Deep analysis of your portfolio, positions, trade history, and performance. Identifies what's working, what isn't, and suggests improvements.

## Resources

MCP resources provide browsable data that AI clients can read directly:

| Resource | URI | Description |
|----------|-----|-------------|
| Portfolio | `tradestaq://portfolio` | Balances, positions, and active bots |
| Bots | `tradestaq://bots` | All bots with status and PnL |
| Strategies | `tradestaq://strategies` | Strategy catalog with ratings |

## Architecture

```
                    stdio                                    HTTPS
┌──────────────┐◄──────────►┐                  ┌────────────────►┌──────────────┐
│Claude Desktop│             │                  │                 │              │
│Cursor / CLI  │             │  tradestaq-mcp   │   Bearer JWT    │  TradeStaq   │
└──────────────┘             │  31 tools        │◄────────────────│  API         │
                             │  3 prompts       │                 │              │
┌──────────────┐  HTTP+SSE  │  3 resources      │                 └──────────────┘
│ Any MCP      │◄──────────►│                  │
│ client (web) │             └──────────────────┘
└──────────────┘
```

- **Two transports:** stdio (local, default) and HTTP+SSE (remote, `--http` flag)
- Hosted at `https://mcp.tradestaq.com/mcp` for remote clients
- JWT auth via OAuth PKCE or email/password login
- All tools return structured JSON with error contract
- Token auto-refresh when expiring within 1 hour

## Development

```sh
npm run dev        # watch mode with tsx
npm run build      # compile TypeScript
npm run lint       # type check without emitting
npm test           # run tests
npm start          # run server (stdio)
npm run start:http # run server (HTTP+SSE on port 3100)
```

## Error Handling

All tool errors return structured responses:

```json
{
  "error": {
    "code": "INSUFFICIENT_BALANCE",
    "message": "Human-readable description",
    "retryable": true,
    "retryAfterMs": 5000
  }
}
```

Error codes: `AUTH_EXPIRED`, `TIMEOUT`, `RATE_LIMITED`, `NETWORK_ERROR`, `HTTP_4xx`, `HTTP_5xx`.

## Security

- Credentials never enter AI conversation history
- OAuth PKCE flow with browser-based authentication
- Token stored with 0600 file permissions
- Localhost-only OAuth callbacks
- `deploy_bot`, `stop_bot`, `close_position`, and `follow_trader` are destructive operations (AI confirms with user)

## License

MIT
