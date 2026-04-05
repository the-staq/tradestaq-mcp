import { loadConfig } from './config.js'

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

export async function api<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown; timeout?: number } = {},
): Promise<T> {
  const config = loadConfig()
  if (!config.token) {
    throw new ApiError(401, 'AUTH_EXPIRED', 'Not authenticated. Run the authenticate tool first.')
  }

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
