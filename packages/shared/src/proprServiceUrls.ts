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
 * Exact browser origin used by the packaged Electron renderer. The API uses
 * this value as a narrow CORS exception for desktop REST and Socket.IO calls.
 */
export const DESKTOP_RENDERER_ORIGIN = 'propr-app://renderer';

/** Opaque activation binding carried by packaged renderer REST requests. */
export const DESKTOP_TRANSPORT_SCOPE_HEADER = 'X-ProPR-Desktop-Transport-Scope';

/** Opaque activation binding carried by packaged renderer Socket.IO upgrades. */
export const DESKTOP_TRANSPORT_SCOPE_QUERY = 'proprDesktopTransportScope';

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
 * 1–61 characters (leaving room for the `t-` prefix), ASCII
 * letters/digits/hyphens only, and no leading or trailing hyphen. This rejects
 * values that would produce an invalid or ambiguous complete DNS label.
 */
export function isValidProprInstanceId(instanceId: string | undefined | null): boolean {
  const id = (instanceId ?? '').trim();
  return /^[a-z0-9]([a-z0-9-]{0,59}[a-z0-9])?$/i.test(id);
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
 * Normalize one scheme-less Connect tunnel selector. Connect deep links carry
 * only the DNS hostname (`t-<id>.propr.dev`), never a URL or a bare instance
 * id. Every spelling must already be exact, including lowercase DNS case:
 * no whitespace, percent encoding, userinfo, port, path, query, fragment,
 * trailing dot, extra label, or non-ASCII character is accepted.
 */
export function canonicalProprProxySelector(selector: string | undefined | null): string | undefined {
  if (!selector || selector !== selector.trim() || /[^\x20-\x7e]/.test(selector)) return undefined;
  const normalized = selector.toLowerCase();
  const suffix = `.${PROPR_UI_PROXY_SUFFIX}`;
  if (!normalized.startsWith(PROPR_UI_PROXY_LABEL_PREFIX) || !normalized.endsWith(suffix)) {
    return undefined;
  }
  const label = normalized.slice(0, -suffix.length);
  if (label.length > 63 || label.includes('.')) return undefined;
  const id = label.slice(PROPR_UI_PROXY_LABEL_PREFIX.length);
  return isValidProprInstanceId(id)
    && /^[a-z0-9.-]+$/.test(selector)
    && selector === normalized
    ? selector
    : undefined;
}

/**
 * Return the one canonical Connect proxy origin, or undefined for anything
 * else. The raw value must be ASCII and carry no userinfo, port, path, query,
 * fragment, IDNA spelling, or alternate DNS representation. This is the
 * authority parser used by setup, local discovery, and remote identity checks.
 */
export function canonicalProprProxyUrl(url: string | undefined | null): string | undefined {
  if (!url || url !== url.trim() || /[^\x20-\x7e]/.test(url)) return undefined;
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== 'https:'
      || parsed.username !== ''
      || parsed.password !== ''
      || parsed.port !== ''
      || parsed.pathname !== '/'
      || parsed.search !== ''
      || parsed.hash !== ''
    ) return undefined;

    const suffix = `.${PROPR_UI_PROXY_SUFFIX}`;
    if (!parsed.hostname.endsWith(suffix)) return undefined;
    const label = parsed.hostname.slice(0, -suffix.length);
    if (
      label.length > 63
      || label.includes('.')
      || !label.startsWith(PROPR_UI_PROXY_LABEL_PREFIX)
    ) return undefined;
    const id = label.slice(PROPR_UI_PROXY_LABEL_PREFIX.length);
    if (!isValidProprInstanceId(id)) return undefined;

    const canonical = `https://${PROPR_UI_PROXY_LABEL_PREFIX}${id.toLowerCase()}.${PROPR_UI_PROXY_SUFFIX}`;
    // Compare the raw spelling: URL parsing must not normalize case or any
    // number of trailing slashes into authority at this trust boundary.
    return url === canonical ? canonical : undefined;
  } catch {
    return undefined;
  }
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
  return canonicalProprProxyUrl(url) !== undefined;
}

function normalizeProprInstanceId(instanceId: string | undefined | null): string {
  const id = (instanceId ?? '').trim();
  return id.toLowerCase().startsWith(PROPR_UI_PROXY_LABEL_PREFIX)
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
  let end = baseUrl.length;
  while (end > 0 && baseUrl.charCodeAt(end - 1) === 47) end--;
  const base = baseUrl.slice(0, end);
  return {
    apiStatus: `${base}/api/status`,
    socketIo: `${base}/socket.io/`,
    root: `${base}/`,
  };
}
