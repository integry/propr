# Hosted UI Tunnel

The hosted ProPR UI at `https://app.propr.dev` can drive a locally-running stack from your browser. An optional **Cloudflare Tunnel** — a managed sidecar running the official `cloudflare/cloudflared` image — publishes your local **API** at a per-instance hostname `https://t-<id>.propr.dev`. You keep everything running on your own machine and skip owning a public domain or operating an inbound proxy.

The tunnel is **off by default**. A normal localhost or reverse-proxy deployment is unaffected until you enable it. Start and stop it with [`propr tunnel on|off`](../features/propr-cli.md#hosted-ui-tunnel), or persist it via `.env` so `propr start` brings it up.

For the higher-level role of the hosted bridge — and how `connect.propr.dev`, `webhook.propr.dev`, `app.propr.dev`, and `t-<id>.propr.dev` divide the work — see [ProPR Connect](./propr-connect.md).

## Architecture

Three addresses are in play. Keeping them straight resolves almost every tunnel problem.

### `https://app.propr.dev` — the browser origin

The hosted UI is a single static bundle that serves every connected stack. It is the origin the browser is loaded from, so it is the origin the API must allow through CORS and the origin the API redirects back to after login.

Because one bundle serves many stacks, the API base URL cannot be baked in at build time. The browser reads it at runtime from `window.__PROPR_CONFIG__.apiBaseUrl`, and how that gets populated depends on who serves the bundle:

- **Self-hosted UI bundle** (the `propr/ui` container): the container entrypoint rewrites the static `config.js` from `PROPR_UI_PUBLIC_API_URL` at start, so one container targets one stack.
- **Vendor-hosted `app.propr.dev`**: the same bundle serves many stacks, so ProPR Connect opens the hosted UI with a validated `?tunnel=t-<id>.propr.dev` deep link, and the UI remembers that selected per-instance API origin through login/OAuth redirects.
- **No selection at all**: if the bundle loads on `app.propr.dev` with no tunnel deep link, no remembered tunnel, and no runtime config, the UI shows a "Connect a ProPR stack" state. Localhost and self-hosted same-origin deployments serve the API from the same origin, so they are exempt from that hosted-only guard.

### `https://t-<PROPR_INSTANCE_ID>.propr.dev` — the per-instance proxy host

This is the public front door to your stack's API, and the host the browser sends **API, Socket.IO, OAuth-callback, and session-cookie** traffic to. Each enabled stack is published under this hostname through its Cloudflare Tunnel; the hosted UI discovers and reaches your stack through the managed `t-*.propr.dev` host pattern.

The tunnel fronts the **API only** (the API container on port 4000). propr-routing forwards just `/api/*` and `/socket.io/*` on the proxy host — the two paths the browser uses — with WebSocket upgrades allowed on `/socket.io/`. The root URL returns 404 by design. `/webhook` is a server-to-server endpoint used only by `direct_webhook` intake behind your own reverse proxy; the browser never calls it and the tunnel never routes it. The UI itself is served by `app.propr.dev`, entirely outside the tunnel.

The `t-<id>.propr.dev` host addresses **your own stack** and only your stack. The central ProPR services live on separate hosts: the hosted UI at `app.propr.dev`, and the routing / GitHub-token relay at `webhook.propr.dev` (see [GitHub Authentication](./github-auth.md)). Those are vendor-run services shared by all installs.

### `http://api:4000` — internal only

This is the service-to-service address other stack containers use to reach the API inside the Docker network, and it is also where Cloudflare forwards the tunnel — the tunnel ingress points at the Docker-internal `http://api:4000`. Because that routing is internal to the Docker network, the published host port is irrelevant to the tunnel and the two can never conflict; host port 4000 can be busy and the tunnel still works.

### Why two different public hosts work together

The browser origin (`app.propr.dev`) and the API host (`t-<id>.propr.dev`) differ, and that is by design. Both sit under the shared `propr.dev` registrable domain, which makes them *same-site* even though they are cross-origin:

- The API allows the `app.propr.dev` origin via CORS (`FRONTEND_URL`).
- The host-only session cookie set on the proxy host is sent with the UI's same-site API calls.
- The OAuth callback lands on the proxy host.

The browser uses the **same API base** for both REST calls and the Socket.IO connection, so they always target one origin — the proxy host when the tunnel is on, or same-origin localhost otherwise.

### Compatibility check

Before the hosted UI starts its normal auth/session checks, it calls the public `/api/compatibility` endpoint on the selected API origin. The endpoint returns the local stack version plus the API/UI compatibility contract. If the hosted UI cannot support that contract, it stops at a clear version-mismatch screen instead of running against incompatible endpoints or Socket.IO events. `/api/status` includes the same metadata for authenticated diagnostics.

Only a **definitive** mismatch (the API reports a contract the UI knows it is too old or too new for) hard-blocks. A v1 rollout exception applies when the metadata is simply *absent* — an older API that predates `/api/compatibility` (returns 404) or returns no contract: the UI logs a console warning and continues, so an otherwise-working stack is never trapped mid-upgrade. This soft-warning fallback is temporary; once publishing the compatibility contract is a baseline expectation, missing metadata is intended to become a hard block like any other mismatch.

## Provisioning

ProPR Connect provisions the Cloudflare Tunnel and instance id for Plus installations: it creates the connector, shows a **one-time connector token and tunnel URL**, and generates the setup command. Run it in the stack directory:

```bash
propr tunnel setup --token <connector-token> --url https://t-abc123.propr.dev --start
```

This writes the tunnel `.env` values for you (`PROPR_UI_TUNNEL_TOKEN`, `PROPR_INSTANCE_ID`, `PROPR_UI_PUBLIC_API_URL`, `API_PUBLIC_URL`, `FRONTEND_URL`, `GH_OAUTH_CALLBACK_URL`), records the tunnel as enabled, and — with `--start` — starts a stopped stack or recreates a running one so the hosted URLs apply immediately. Prefer this command over hand-editing `.env`: it also overwrites stale localhost values left over from a previous local setup.

### Manual `.env` fallback

For older CLI versions or manual recovery, set the same values in the stack `.env`. Replace `abc123` with your instance id (a valid DNS label: letters, digits, hyphens; 1-63 chars):

```bash
# --- Hosted UI tunnel (v1, optional) ---
# PROPR_UI_TUNNEL_TOKEN is a LIVE Cloudflare credential — do not commit, log, or share it.
PROPR_UI_TUNNEL_TOKEN=your_cloudflare_tunnel_token   # required to start; setting it makes the tunnel start on the next `propr start`
PROPR_UI_TUNNEL_ENABLED=true                         # explicit enablement; the CLI also records this in its config
PROPR_INSTANCE_ID=abc123                             # derives https://t-abc123.propr.dev
PROPR_UI_PUBLIC_API_URL=https://t-abc123.propr.dev   # explicit public API URL the hosted UI talks to

# Optional override:
# PROPR_CLOUDFLARED_IMAGE=cloudflare/cloudflared:2024.12.2 # overrides the manifest-pinned default

# Browser vs API origins (see Architecture above):
FRONTEND_URL=https://app.propr.dev
API_PUBLIC_URL=https://t-abc123.propr.dev
GH_OAUTH_CALLBACK_URL=https://t-abc123.propr.dev/api/auth/github/callback

# COOKIE_DOMAIN: leave UNSET for v1 — keep the line commented out (an empty
# `COOKIE_DOMAIN=` may still count as set).
# COOKIE_DOMAIN=
```

`PROPR_INSTANCE_ID` derives the public URL `https://t-<id>.propr.dev` automatically, so `PROPR_UI_PUBLIC_API_URL` is only needed to override it.

## Configuration

The three URL variables map directly onto the architecture above. Get these right and the tunnel works; get one wrong and you see CORS errors, broken logins, or a UI that silently talks to localhost.

- **`FRONTEND_URL`** is the **browser origin** — the hosted UI at `https://app.propr.dev`. The API allows this origin through CORS and redirects to it after login. In tunnel mode it is derived to `https://app.propr.dev` when left unset; `propr tunnel setup` writes it explicitly so older localhost values never win.
- **`API_PUBLIC_URL`** is the **proxy host** (`https://t-<id>.propr.dev`) — where the browser actually reaches the API and Socket.IO, and what governs the secure session cookie. Derived from the instance id when left unset; `propr tunnel setup` writes it explicitly.
- **`GH_OAUTH_CALLBACK_URL`** must point at the API on the **proxy host**: `https://t-<id>.propr.dev/api/auth/github/callback`. The callback lives on the API host — a callback pointing at `app.propr.dev` will fail, because the OAuth flow completes on the API. Derived when left unset; `propr tunnel setup` writes it explicitly. **Register this exact URL in your GitHub OAuth App.**
- **`COOKIE_DOMAIN`** stays unset: the session cookie is host-only on the single `t-<id>.propr.dev` host, which is correct because that host and `app.propr.dev` are same-site under `propr.dev`. Scoping the cookie across shared ProPR-managed tunnel hostnames is unsupported in v1.

### Enablement semantics

Setting `PROPR_UI_TUNNEL_TOKEN` enables the tunnel by default, so the next `propr start` (or a restart) brings up the sidecar — you do not strictly need `propr tunnel on` first. `propr tunnel on|off` records an explicit choice that **overrides** the token-derived default and is honored by later starts; `propr tunnel on` additionally starts the sidecar immediately on an already-running stack, and `propr tunnel off` stops it while leaving the token in place. `PROPR_UI_TUNNEL_ENABLED=true` is an explicit alternative, but a token is still required — `propr check` fails if the tunnel is enabled without `PROPR_UI_TUNNEL_TOKEN`. See [ProPR CLI → Hosted UI Tunnel](../features/propr-cli.md#hosted-ui-tunnel) for the command reference.

:::caution Restart the stack after enabling on a running stack
`propr tunnel on` starts only the cloudflared sidecar; the already-running API/worker containers keep the `API_PUBLIC_URL` / `FRONTEND_URL` they were started with, so OAuth redirects, cookie security, and attachment links still point at their pre-tunnel localhost values until you run `propr start --restart`. `propr tunnel setup --start` avoids this by recreating the running stack after writing the tunnel settings.
:::

## Verify

```bash
propr tunnel on
propr tunnel verify
```

`propr tunnel verify` confirms the tunnel end to end:

- the cloudflared sidecar container is running;
- `GET <url>/api/status` returns an OK or auth-expected response;
- `GET <url>/` returns **404** — the root is intentionally unrouted, so 404 here is success;
- `GET <url>/socket.io/` is reachable.

It exits non-zero if any check fails. `propr status` probes `<url>/api/status` for tunnel reachability for the same reason — the root `/` and the legacy `/health` path are unrouted through the tunnel.

## Troubleshooting

The most common failures, in the order to check them:

1. **No token configured.** Starting the tunnel always requires `PROPR_UI_TUNNEL_TOKEN`; `propr tunnel on` fails clearly without one. Run the setup command shown in ProPR Connect.
2. **Core stack down.** `propr tunnel on` refuses to start the sidecar when the stack is down — cloudflared would point at an unavailable `api:4000` and look superficially healthy. Run `propr start` first, or pass `--force` deliberately.
3. **Tunnel enabled on an already-running stack.** OAuth and cookies still use localhost URLs until `propr start --restart` (see the caution above).
4. **OAuth callback mismatch.** The GitHub OAuth App must have `https://t-<id>.propr.dev/api/auth/github/callback` registered — the exact URL in `GH_OAUTH_CALLBACK_URL`.
5. **Root URL returns 404.** Expected behavior; test `/api/status` instead.
6. **Host port 4000 busy.** Irrelevant: Cloudflare forwards to the Docker-internal `http://api:4000` and bypasses the published host port entirely.

For symptom-by-symptom diagnosis, see [Troubleshooting → Hosted UI Tunnel Not Working](./troubleshooting.md#hosted-ui-tunnel-not-working).

## Security

`PROPR_UI_TUNNEL_TOKEN` is a live Cloudflare credential: anyone holding it can route traffic through your tunnel. Keep it in the stack `.env` only — never commit it, paste it into logs or issues, or share it. ProPR keeps it off the process command line (it is passed to the `cloudflared` sidecar as the `TUNNEL_TOKEN` environment variable and injected into no other container), but it remains readable from that container's environment via `docker inspect`. Treat Docker daemon access on the host as equivalent to access to this token, and rotate it in ProPR Connect if the host is compromised.
