# Changelog

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
