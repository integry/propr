import type { Page, Request } from '@playwright/test';

/**
 * A mock ProPR instance for site captures. Every capture installs the base
 * world plus the areas it needs; areas answer API calls for their screens.
 *
 * Responses must keep the API's real shapes: when the UI changes what it
 * reads, update the area module (the e2e specs next door are the best source
 * for current shapes). Unanswered calls are logged, never silently faked, so
 * a missing panel is easy to trace.
 */

export interface ApiRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  raw: Request;
}

/** Return a JSON body (or `{ status, json }`) to answer, or undefined to pass. */
export type Handler = (request: ApiRequest) => unknown | undefined;

export interface Area {
  name: string;
  handle: Handler;
}

export interface Reply {
  status: number;
  json: unknown;
}

export const reply = (status: number, json: unknown): Reply => ({ status, json });
const isReply = (value: unknown): value is Reply =>
  typeof value === 'object' && value !== null && 'status' in value && 'json' in value && Object.keys(value).length === 2;

/** Builds an area from exact paths (`GET /api/x`, or `/api/x` for any method) and regex routes. */
export function area(name: string, routes: Record<string, unknown | Handler>, patterns: Array<[RegExp, Handler]> = []): Area {
  return {
    name,
    handle(request) {
      const exact = routes[`${request.method} ${request.path}`] ?? routes[request.path];
      if (exact !== undefined) return typeof exact === 'function' ? (exact as Handler)(request) : exact;
      for (const [pattern, handler] of patterns) if (pattern.test(request.path)) return handler(request);
      return undefined;
    },
  };
}

export interface WorldLog {
  unmocked: string[];
}

/** Installs the areas (later areas win) and closes the live socket. */
export async function installWorld(page: Page, ...areas: Area[]): Promise<WorldLog> {
  const log: WorldLog = { unmocked: [] };
  const ordered = [...areas].reverse();
  await page.routeWebSocket('**/socket.io/**', socket => socket.close());
  await page.route('**/api/**', async route => {
    const raw = route.request();
    const url = new URL(raw.url());
    let body: unknown;
    try { body = raw.postDataJSON(); } catch { body = raw.postData(); }
    const request: ApiRequest = { method: raw.method(), path: url.pathname, query: url.searchParams, body, raw };
    for (const candidate of ordered) {
      const result = candidate.handle(request);
      if (result === undefined) continue;
      if (isReply(result)) return route.fulfill({ status: result.status, json: result.json });
      return route.fulfill({ json: result });
    }
    const key = `${request.method} ${request.path}${url.search}`;
    if (!log.unmocked.includes(key)) log.unmocked.push(key);
    return route.fulfill({ status: 503, json: { error: 'Not mocked in site-captures world' } });
  });
  return log;
}
