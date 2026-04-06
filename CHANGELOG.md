# Changelog

## [0.1.1] - 2026-04-06

### Added
- HTTP+SSE transport for remote access (`--http` flag, deployed at `mcp.tradestaq.com`)
- MCP resources: `tradestaq://portfolio`, `tradestaq://bots`, `tradestaq://strategies`
- `login` tool for email/password authentication (works in Claude Code and CLI)
- `check_auth` tool to verify authentication status
- `set_token` tool for manual JWT token entry
- `connect_exchange` tool to open exchange setup in browser
- `generate_strategy` tool for AI-powered strategy creation from natural language
- Token auto-refresh when expiring within 1 hour
- npm package published as `@the-staq/tradestaq-mcp`
- Official MCP Registry listing
- Version management with `npm run release:patch/minor/major`

### Fixed
- OAuth authorize endpoint returns JSON instead of redirect (was breaking auth flow)
- Token persistence: validate token exists before saving config
- `isAuthenticated` checks token is a real string, not just truthy
- `access_token` field correctly read from OAuth token response
- Strategy detail endpoints unwrap `doc` wrapper from API response
- Strategy parameters extracted from `latestVersion.parameterGroups`
- Backtest tool sends required fields: `name`, `exchangeId`, `timeframe`

### Changed
- Advisor tools (`suggest_strategies`, `get_market_context`) now call server-side API endpoints instead of computing locally
- `search_markets` requires `exchange` parameter (use `list_exchanges` to find IDs)
- Package renamed from `@tradestaq/mcp-server` to `@the-staq/tradestaq-mcp`
- Tool count: 27 to 31

## [0.1.0] - 2026-04-05

### Added
- MCP server scaffold with stdio transport
- OAuth PKCE authentication flow (browser-based, credentials never in chat)
- 27 tools across 9 categories: auth, market data, portfolio, strategies, backtesting, bot management, trade history, copy trading, advisor
- 3 prompt templates: trading-assistant, strategy-builder, portfolio-reviewer
- Structured error handling with retryable/non-retryable error contract
- In-memory config caching for performance during polling
- 33 tests (config, API client, helpers, tool registration, prompts)
- GitHub Actions CI (type check + test + build)
- README with setup instructions for Claude Desktop, Cursor, and Claude Code
