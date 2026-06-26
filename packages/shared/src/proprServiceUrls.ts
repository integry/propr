/**
 * Default URLs for the vendor-run propr-routing service.
 *
 * The routing relay and the GitHub token relay are not separate deployments —
 * they are the same Cloudflare Worker (propr-routing), served from a single
 * custom domain and exposing every endpoint under `/v1`:
 *   - `wss://webhook.propr.dev/v1/connect`     (routing WebSocket intake)
 *   - `https://webhook.propr.dev/v1/relay-tokens`, `/v1/installation-token` …
 *
 * These constants are the single source of truth for that host so the CLI
 * (`propr relay enroll`), the daemon dialer, and the boot/`propr check`
 * prerequisite validators all agree on the hosted default without anyone having
 * to set PROPR_ROUTING_URL / PROPR_GH_RELAY_URL by hand.
 */

/**
 * Default routing WebSocket origin (PROPR_ROUTING_URL). A bare origin without a
 * path — the routing service owns the `/v1/...` paths it appends (connect +
 * payload pull), so a path here would corrupt the derived URLs.
 */
export const DEFAULT_PROPR_ROUTING_URL = 'wss://webhook.propr.dev';

/**
 * Default GitHub token relay base URL (PROPR_GH_RELAY_URL). Includes the `/v1`
 * version prefix because the relay client appends paths like `/relay-tokens`
 * directly to this value.
 */
export const DEFAULT_PROPR_GH_RELAY_URL = 'https://webhook.propr.dev/v1';

/**
 * Origin of the hosted Propr UI (https://app.propr.dev). This is where the
 * managed control plane is served from; a local stack exposes its own UI on a
 * tunnel under {@link PROPR_UI_PROXY_SUFFIX} so the hosted UI can reach it.
 */
export const DEFAULT_PROPR_UI_ORIGIN = 'https://app.propr.dev';

/**
 * DNS suffix for per-instance UI/API tunnel hostnames. Each local stack with an
 * instance id is reachable at `https://<instanceId>.proxy.propr.dev`, so the
 * hosted UI at {@link DEFAULT_PROPR_UI_ORIGIN} can discover and address it.
 */
export const PROPR_UI_PROXY_SUFFIX = 'proxy.propr.dev';

/**
 * Default Cloudflare Tunnel image used to expose the local stack's UI/API to
 * the hosted control plane when a UI tunnel is enabled. This is only a fallback:
 * the launcher prefers the `cloudflared` entry pinned in the stack manifest
 * (docker/launcher/manifest.json). Keep this tag in sync with that manifest pin
 * so the effective default is the same regardless of which source supplies it.
 */
export const DEFAULT_CLOUDFLARED_IMAGE = 'cloudflare/cloudflared:2024.12.2';

/**
 * Whether an instance id is usable as a single DNS label in the per-instance
 * proxy hostname (`<id>.proxy.propr.dev`). Enforces the standard label rules:
 * 1–63 characters, ASCII letters/digits/hyphens only, and no leading or
 * trailing hyphen. This rejects spaces, slashes, dots, underscores, and other
 * characters that would produce an invalid or ambiguous hostname.
 */
export function isValidProprInstanceId(instanceId: string | undefined | null): boolean {
  const id = (instanceId ?? '').trim();
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i.test(id);
}

/**
 * Derive the public API/UI URL for a local stack from its instance id, using
 * the shared {@link PROPR_UI_PROXY_SUFFIX}. Returns `https://abc123.proxy.propr.dev`
 * for instance id `abc123`. Returns `undefined` for a missing/blank id — or an
 * id that is not a valid DNS label (see {@link isValidProprInstanceId}) — so
 * callers can fall back to an explicit URL or a local-development default
 * rather than emitting a malformed hostname. The id is lowercased so a
 * mixed-case instance id yields a canonical hostname (DNS is case-insensitive).
 */
export function proprInstanceProxyUrl(instanceId: string | undefined | null): string | undefined {
  const id = (instanceId ?? '').trim();
  if (!isValidProprInstanceId(id)) return undefined;
  return `https://${id.toLowerCase()}.${PROPR_UI_PROXY_SUFFIX}`;
}

/**
 * Whether a URL is a hosted per-instance proxy URL (`https://<id>.proxy.propr.dev`).
 * propr-routing only forwards `/api/*` and `/socket.io/*` on these hosts, so the
 * tunnel base URL must be one of them. Requires https and a hostname under the
 * shared {@link PROPR_UI_PROXY_SUFFIX}. Returns false for a malformed URL.
 */
export function isProprProxyUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && hostname.endsWith(`.${PROPR_UI_PROXY_SUFFIX}`);
  } catch {
    return false;
  }
}

/**
 * The concrete endpoints the hosted UI reaches through the tunnel base URL.
 * propr-routing only allows `/api/*` and `/socket.io/*`, so the base (root) URL
 * itself intentionally returns 404 — it is NOT a health target. Use `apiStatus`
 * to probe liveness. The base is normalized (trailing slashes trimmed) so the
 * derived paths never double up a slash.
 */
export function proprTunnelEndpoints(baseUrl: string): {
  apiStatus: string;
  socketIo: string;
  root: string;
} {
  const base = baseUrl.replace(/\/+$/, '');
  return {
    apiStatus: `${base}/api/status`,
    socketIo: `${base}/socket.io/`,
    root: `${base}/`,
  };
}
