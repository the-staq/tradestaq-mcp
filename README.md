# TradeStaq MCP Server

Trading intelligence for AI agents. Connect Claude, GPT, or any MCP-compatible AI to your TradeStaq account.

Create strategies, backtest them, deploy bots, monitor positions, and manage your portfolio, all from conversation.

## Install

```sh
git clone https://github.com/the-staq/tradestaq-mcp.git
cd tradestaq-mcp
npm install
npm run build
```

## Configure

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "tradestaq": {
      "command": "node",
      "args": ["/path/to/tradestaq-mcp/dist/index.js"]
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json` in your project:

```json
{
  "mcpServers": {
    "tradestaq": {
      "command": "node",
      "args": ["/path/to/tradestaq-mcp/dist/index.js"]
    }
  }
}
```

### Claude Code

```sh
claude mcp add tradestaq node /path/to/tradestaq-mcp/dist/index.js
```

Replace `/path/to/tradestaq-mcp` with the actual path where you cloned the repo.

## Authenticate

After configuring, ask your AI assistant to run the `authenticate` tool. A browser window opens where you log in to TradeStaq. Credentials never enter the chat.

Token is stored locally at `~/.tradestaq/mcp-config.json` with restricted permissions (0600).

## Tools

### Auth

| Tool | Description |
|------|-------------|
| `authenticate` | Log in via browser (OAuth + PKCE) |
| `logout` | Remove stored credentials |

### Market Data

| Tool | Description |
|------|-------------|
| `get_price` | Current price, 24h change, volume |
| `get_candles` | OHLCV candlestick data (1m to 1d) |
| `search_markets` | Find trading pairs on connected exchanges |

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

`deploy_bot` defaults to paper trading. Pass `live: true` for real money.

## Prompt Templates

**Trading Assistant** — Start a conversation about your portfolio and positions. The AI calls `get_portfolio` and `get_positions` to ground its responses in your actual data.

**Strategy Builder** — Walk through creating, backtesting, and deploying a strategy. Pass an optional `goal` like "momentum strategy for ETH" to get focused suggestions.

## Architecture

```
┌─────────────────┐     stdio      ┌──────────────────┐     HTTPS     ┌──────────────┐
│  Claude Desktop  │◄──────────────►│  tradestaq-mcp   │◄────────────►│  TradeStaq    │
│  Cursor / CLI    │                │  (this server)   │  Bearer JWT  │  API          │
└─────────────────┘                └──────────────────┘              └──────────────┘
```

- Standalone process, communicates with TradeStaq API over HTTPS
- stdio transport for local integrations
- JWT auth via OAuth PKCE flow (browser-based, no credentials in chat)
- All tools return structured JSON for agent consumption

## Development

```sh
npm run dev      # watch mode with tsx
npm run build    # compile TypeScript
npm run lint     # type check without emitting
npm test         # run tests
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
- `deploy_bot` and `stop_bot` marked as destructive (AI confirms with user before calling)

## License

MIT
