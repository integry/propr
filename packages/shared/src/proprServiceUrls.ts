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
 * Origin of the hosted ProPR dashboard (https://app.propr.dev). The single
 * source of truth for where the hosted UI lives, so the launcher and UI agree
 * on the public app origin without hard-coding it in multiple places.
 */
export const DEFAULT_PROPR_UI_ORIGIN = 'https://app.propr.dev';

/**
 * DNS suffix for per-instance UI tunnel/proxy hostnames. A local stack exposed
 * through the hosted proxy is reachable at `https://<instance-id>.proxy.propr.dev`,
 * so a PROPR_INSTANCE_ID of `abc123` resolves to `https://abc123.proxy.propr.dev`.
 * The leading dot makes `${instanceId}${PROPR_UI_PROXY_SUFFIX}` a valid hostname.
 */
export const PROPR_UI_PROXY_SUFFIX = '.proxy.propr.dev';

/**
 * Default Cloudflare Tunnel (cloudflared) image used to expose the local UI
 * through the hosted proxy when the UI tunnel is enabled. Overridable via
 * PROPR_CLOUDFLARED_IMAGE for pinned/air-gapped deployments.
 */
export const DEFAULT_CLOUDFLARED_IMAGE = 'cloudflare/cloudflared:latest';
