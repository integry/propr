/**
 * Reads the read-only demo viewer may not make. The API refuses each of them
 * for the demo (they probe the host, daemons, registries or stored
 * credentials), and a refused request still shows up as a 403 in the browser
 * console. While demo mode is on, apiFetch answers these locally with the
 * same refusal the API would send, so pages behave exactly as before without
 * touching the network.
 *
 * Keep this list in step with routes that stay closed to the demo viewer in
 * packages/api/demoViewerRoutes.ts. Only GET requests are gated: writes already
 * fail with the demo read-only error, and the UI disables them in demo mode.
 */
export const DEMO_UNAVAILABLE_READS: ReadonlySet<string> = new Set([
  '/api/config/agent-tank',
  '/api/config/agent-tank/status',
  '/api/config/agent-tank/history',
  '/api/config/agent-tank/detect',
  '/api/instance/extensions/v1',
  '/api/instance/extensions/v1/history',
  '/api/agent-runtime/packages',
  '/api/config/visual-preview-auth',
  '/api/config/preview-storage',
]);

const DEMO_LIVE_DATA_UNAVAILABLE = {
  error: 'Forbidden',
  code: 'DEMO_MODE_LIVE_DATA_UNAVAILABLE',
  message: 'This view reads live installation state, which the read-only demo does not expose.',
};

let demoModeActive = false;

/** Set by DemoModeProvider once /api/auth/demo-mode has answered. */
export const setDemoModeRequestGate = (active: boolean): void => { demoModeActive = active; };

const requestPath = (input: RequestInfo | URL): string | null => {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  try {
    return new URL(href, globalThis.location?.href ?? 'http://localhost/').pathname;
  } catch {
    return null;
  }
};

const requestMethod = (input: RequestInfo | URL, init: RequestInit | undefined): string =>
  (init?.method ?? (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET')).toUpperCase();

/** The API's demo refusal for a read the demo may not make, or null to send the request. */
export const demoModeUnavailableResponse = (input: RequestInfo | URL, init: RequestInit | undefined): Response | null => {
  if (!demoModeActive || requestMethod(input, init) !== 'GET') return null;
  const path = requestPath(input);
  // API_BASE_URL may carry a path prefix in front of /api.
  const apiPath = path?.slice(Math.max(0, path.indexOf('/api/')));
  if (!apiPath || !DEMO_UNAVAILABLE_READS.has(apiPath)) return null;
  return new Response(JSON.stringify(DEMO_LIVE_DATA_UNAVAILABLE), {
    status: 403,
    headers: { 'Content-Type': 'application/json' },
  });
};
