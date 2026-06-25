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
 * the hosted control plane when a UI tunnel is enabled.
 */
export const DEFAULT_CLOUDFLARED_IMAGE = 'cloudflare/cloudflared:latest';

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
 * rather than emitting a malformed hostname.
 */
export function proprInstanceProxyUrl(instanceId: string | undefined | null): string | undefined {
  const id = (instanceId ?? '').trim();
  if (!isValidProprInstanceId(id)) return undefined;
  return `https://${id}.${PROPR_UI_PROXY_SUFFIX}`;
}
