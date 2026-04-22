import { loadConfig, saveConfig } from './config.js'

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retryable: boolean = false,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function refreshTokenIfNeeded(): Promise<void> {
  const config = loadConfig()
  if (!config.token || !config.tokenExpiresAt) return

  // Only refresh if expiring within 1 hour
  const oneHour = 60 * 60 * 1000
  if (config.tokenExpiresAt - Date.now() > oneHour) return

  try {
    // Use Payload's built-in refresh endpoint
    const res = await fetch(`${config.baseUrl}/api/users/refresh-token`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.token}`,
        'Content-Type': 'application/json',
      },
    })

    if (res.ok) {
      const data = (await res.json()) as any
      const newToken = data.refreshedToken || data.token || data.access_token
      if (newToken) {
        saveConfig({
          ...config,
          token: newToken,
          tokenExpiresAt: Date.now() + 7 * 24 * 3600 * 1000,
        })
      }
    }
    // If refresh fails, continue with existing token — it might still work
  } catch {
    // Silently continue — token refresh is best-effort
  }
}

export async function api<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown; timeout?: number } = {},
): Promise<T> {
  const config = loadConfig()
  if (!config.token) {
    throw new ApiError(401, 'AUTH_EXPIRED', 'Not authenticated. Run the authenticate tool first.')
  }

  await refreshTokenIfNeeded()

  const url = `${config.baseUrl}${path}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeout ?? 30_000)

  try {
    const res = await fetch(url, {
      method: options.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${config.token}`,
        'Content-Type': 'application/json',
        'X-MCP-Source': 'tradestaq-mcp',
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    })

    const data = (await res.json()) as any

    if (!res.ok) {
      // OAuth insufficient_scope (RFC 6749 §5.2). Surface a clear, actionable
      // message so the agent tells the user to re-authorize with a broader
      // scope instead of retrying and hitting the same wall.
      if (res.status === 403 && data?.error === 'insufficient_scope') {
        const required = data?.scope || 'higher'
        const desc = data?.error_description || 'This action requires a broader OAuth scope than the current token grants.'
        throw new ApiError(
          403,
          'INSUFFICIENT_SCOPE',
          `${desc} Required scope: ${required}. Ask the user to run \`logout\` then \`authenticate\` with scope: "${required}" to re-authorize.`,
          false,
        )
      }
      throw new ApiError(
        res.status,
        data?.error?.code ?? `HTTP_${res.status}`,
        data?.error?.message ?? data?.error ?? data?.message ?? `API returned ${res.status}`,
        res.status === 429 || res.status >= 500,
      )
    }

    return data as T
  } catch (err) {
    if (err instanceof ApiError) throw err
    if ((err as Error).name === 'AbortError') {
      throw new ApiError(408, 'TIMEOUT', 'Request timed out', true)
    }
    throw new ApiError(0, 'NETWORK_ERROR', `Failed to reach TradeStaq API: ${(err as Error).message}`, true)
  } finally {
    clearTimeout(timer)
  }
}
