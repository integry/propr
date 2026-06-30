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
 * tunnel under a {@link PROPR_UI_PROXY_LABEL_PREFIX} host on
 * {@link PROPR_UI_PROXY_SUFFIX} so the hosted UI can reach it.
 */
export const DEFAULT_PROPR_UI_ORIGIN = 'https://app.propr.dev';

/**
 * DNS suffix and label prefix for per-instance UI/API tunnel hostnames. Each
 * local stack with an instance id is reachable at
 * `https://t-<instanceId>.propr.dev`, so the hosted UI at
 * {@link DEFAULT_PROPR_UI_ORIGIN} can discover and address it.
 */
export const PROPR_UI_PROXY_SUFFIX = 'propr.dev';
export const PROPR_UI_PROXY_LABEL_PREFIX = 't-';

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
 * proxy hostname (`t-<id>.propr.dev`). Enforces the standard label rules:
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
 * the shared public tunnel host pattern. Returns `https://t-abc123.propr.dev`
 * for instance id `abc123`. A caller may pass either the bare instance id or the
 * public DNS label (`t-abc123`); the returned URL is canonicalized. Returns
 * `undefined` for a missing/blank id — or an id that is not a valid DNS label
 * (see {@link isValidProprInstanceId}) — so callers can fall back to an explicit
 * URL or a local-development default rather than emitting a malformed hostname.
 * The id is lowercased so a mixed-case instance id yields a canonical hostname
 * (DNS is case-insensitive).
 */
export function proprInstanceProxyUrl(instanceId: string | undefined | null): string | undefined {
  const id = normalizeProprInstanceId(instanceId);
  if (!isValidProprInstanceId(id)) return undefined;
  return `https://${PROPR_UI_PROXY_LABEL_PREFIX}${id.toLowerCase()}.${PROPR_UI_PROXY_SUFFIX}`;
}

/**
 * Whether a URL is a hosted per-instance proxy URL (`https://t-<id>.propr.dev`).
 * propr-routing only forwards `/api/*` and `/socket.io/*` on these hosts, so the
 * tunnel base URL must be one of them. Requires https and *exactly one* valid
 * `t-<instance-id>` label in front of the shared {@link PROPR_UI_PROXY_SUFFIX}.
 * Other propr.dev hosts like `app.propr.dev` and nested hosts are rejected. It
 * must also be a bare origin: a non-root path, query, or fragment (e.g.
 * `https://t-abc.propr.dev/api`) is rejected because
 * {@link proprTunnelEndpoints} appends `/api/...` itself and a base path would
 * double it up (`.../api/api/status`). Returns false for a malformed URL.
 */
export function isProprProxyUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  try {
    const { protocol, hostname, pathname, search, hash } = new URL(url);
    if (protocol !== 'https:') return false;
    // Must be a bare origin — the tunnel endpoint helpers own the path suffix.
    // Trailing slashes (`/`, `//`) are tolerated (callers trim them); any real
    // path segment, query, or fragment is rejected so a base path can't double
    // up the appended `/api/...`.
    if (/[^/]/.test(pathname) || search || hash) return false;
    const suffix = `.${PROPR_UI_PROXY_SUFFIX}`;
    if (!hostname.endsWith(suffix)) return false;
    const label = hostname.slice(0, -suffix.length);
    if (label.includes('.') || !label.startsWith(PROPR_UI_PROXY_LABEL_PREFIX)) {
      return false;
    }
    return isValidProprInstanceId(label.slice(PROPR_UI_PROXY_LABEL_PREFIX.length));
  } catch {
    return false;
  }
}

function normalizeProprInstanceId(instanceId: string | undefined | null): string {
  const id = (instanceId ?? '').trim();
  return id.startsWith(PROPR_UI_PROXY_LABEL_PREFIX)
    ? id.slice(PROPR_UI_PROXY_LABEL_PREFIX.length)
    : id;
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
