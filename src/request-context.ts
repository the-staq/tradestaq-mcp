import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Per-request auth context for the hosted (HTTP) transport.
 *
 * The HTTP request handler runs each MCP request inside
 * `requestContext.run({ token })`, where `token` is the bearer extracted from
 * that request's `Authorization` header. `api()` and the auth tools resolve the
 * token from here so concurrent sessions in one hosted process never share a
 * single process-global (file) token — which would leak one user's session to
 * every other user.
 *
 * In stdio mode the store is NEVER set (`getStore()` returns `undefined`), so
 * behavior is byte-for-byte identical to the pre-existing file-based token. The
 * presence of a store is exactly what distinguishes "hosted, per-request auth"
 * from "local, file auth" — the http handler always establishes a store (even
 * for an unauthenticated request, with `token: undefined`), so a hosted request
 * never falls back to the shared file token.
 */
export interface RequestAuth {
  token?: string
}

export const requestContext = new AsyncLocalStorage<RequestAuth>()

/** The active request store, or `undefined` when running under stdio. */
export function getRequestStore(): RequestAuth | undefined {
  return requestContext.getStore()
}
