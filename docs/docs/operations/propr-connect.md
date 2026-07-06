# ProPR Connect

ProPR Connect is the hosted bridge between GitHub and self-hosted ProPR.

When you run ProPR yourself, your repositories, execution containers, credentials, logs, prompts, and agent state stay inside your own environment. ProPR Connect handles the parts that need a stable public edge: GitHub App webhooks, delivery recovery, relay authentication, and optional hosted UI access.

## Why It Exists

GitHub needs a public endpoint to deliver GitHub App webhooks. A self-hosted ProPR stack often runs on a laptop, workstation, private server, or internal network where exposing an inbound webhook endpoint is inconvenient or undesirable.

ProPR Connect avoids requiring inbound access to your ProPR instance. Your local stack opens outbound connections to the hosted relay. GitHub events arrive at ProPR Connect and are routed to the correct local instance.

This keeps self-hosting practical while still supporting the shared ProPR GitHub App.

## What It Does

ProPR Connect provides:

- GitHub App webhook intake for the shared ProPR GitHub App.
- Event routing to self-hosted ProPR instances over outbound connections.
- Failed GitHub delivery recovery when GitHub or the relay has a transient issue.
- Relay authentication for self-hosted instances using ProPR Connect tokens.
- Optional managed UI tunnel routing so the hosted ProPR UI can reach a local ProPR API.
- Health and compatibility checks for hosted UI tunnel setups.

## What Stays Local

ProPR Connect is not where coding work runs.

The following stay in your ProPR environment:

- repository checkouts;
- agent containers;
- execution logs;
- local credentials and secrets;
- ProPR API state;
- local database and cache;
- prompt execution context;
- generated patches and working directories.

ProPR Connect only handles the hosted coordination layer needed to connect GitHub, the shared GitHub App, and your self-hosted instance.

## Public Hostnames

ProPR uses several hostnames for different parts of the system:

| Hostname | Purpose |
|---|---|
| `connect.propr.dev` | ProPR Connect dashboard and setup flow |
| `webhook.propr.dev` | GitHub webhook intake, relay API, and routing WebSocket |
| `app.propr.dev` | Hosted ProPR UI |
| `t-<id>.propr.dev` | Optional per-instance API tunnel endpoint |

`connect.propr.dev` is the operator-facing setup surface. `webhook.propr.dev` is the event and token relay used by the running ProPR stack. `app.propr.dev` is the browser UI. A `t-<id>.propr.dev` hostname points at one self-hosted stack's API through an optional managed tunnel.

## Default Event Flow

In the default self-hosted setup, GitHub events flow through the shared ProPR GitHub App and reach your stack over an outbound routing WebSocket:

```text
GitHub App
  -> webhook.propr.dev
  -> outbound routing WebSocket
  -> local ProPR API
  -> local worker/runtime
  -> GitHub pull request
```

The local ProPR instance does not need to expose an inbound webhook URL.

Use this mode when you want the simplest self-hosted setup: no GitHub App private key of your own, no public webhook endpoint, and low-latency event delivery.

## Delivery Decisions And Acknowledgements

ProPR Connect forwards every eligible-looking GitHub delivery to your local instance and lets your instance make the authoritative decision. ProPR Connect does not consult or expose a user/repository whitelist; your self-hosted ProPR remains the only source of truth for repo and user policy.

When your instance finishes resolving a delivery, it acknowledges it over the routing connection with an explicit status:

- `accepted` — ProPR processed or started work on the delivery. This can consume a seat.
- `blocked` — ProPR would have processed the delivery but policy or capacity prevented it (for example, an organization over its seat limit). This is terminal and visible to admins.
- `ignored` — ProPR deliberately took no action (an unsupported event, a passive event, or a user not allowed to trigger). This is terminal and consumes no seat.

The acknowledgement may also carry a machine-readable `reason` (such as `unsupported_event`, `user_not_allowed`, or `limit_reached`) and optional billing metadata:

```json
{
  "type": "ack",
  "deliveryId": "…",
  "status": "ignored",
  "reason": "user_not_allowed",
  "billing": { "seatConsumed": false }
}
```

A delivery is redelivered only when no acknowledgement is sent at all (for example, a transient failure while pulling the payload or processing the event). All three statuses are terminal — once acknowledged, ProPR Connect records the result in the delivery history and does not redeliver. This lets admins see, for example, `ignored: user_not_allowed` instead of wondering why a forwarded delivery produced no work.

This contract keeps policy local, adds no preflight latency or new request path, and avoids exposing a queryable whitelist surface.

### Seats And Limits

A seat is a distinct developer whose GitHub activity starts ProPR work through the installation in a billing cycle — dashboard browsing costs nothing. `github-actions[bot]` and the ProPR bot are seat-exempt; other bot accounts consume a seat like any developer if you whitelist them to trigger work. The free Community tier includes 3 seats. When the limit is reached, developers already seated this cycle keep working; a *new* developer's triggers are acknowledged as `blocked` with `limit_reached`, a soft-block comment is posted on the originating issue or PR, and the delivery appears in the history — add Plus seats from the Connect dashboard to unblock them.

## Hosted UI Tunnel Flow

When the hosted UI tunnel is enabled, the browser can use the hosted ProPR UI while the API still runs locally:

```text
Browser
  -> app.propr.dev
  -> t-<id>.propr.dev
  -> local ProPR API container
```

The tunnel carries ProPR API traffic only: the proxy routes the browser-facing API and Socket.IO paths used by the UI, and the GitHub webhook endpoint stays off the tunnel. The hosted UI checks the selected local API's compatibility metadata before using it, so a hosted UI bundle never silently runs against an incompatible local API contract.

Architecture, provisioning, configuration, and troubleshooting for the tunnel live in [Hosted UI Tunnel](./hosted-ui-tunnel.md).

## Authentication And Tokens

With the shared GitHub App, your stack does not store the App private key. Instead, it uses a durable relay token to ask ProPR Connect for short-lived GitHub installation tokens.

The relay token identifies the ProPR installation that your stack is allowed to act for. Treat it like a password. ProPR redacts relay tokens and GitHub installation tokens from logs.

Normal GitHub API calls and `git push` operations still go directly from your ProPR stack to GitHub using short-lived installation tokens. ProPR Connect is contacted when the stack needs relay services, such as minting or refreshing those tokens and receiving routed GitHub events.

## Alternatives

You do not have to use the shared ProPR Connect relay.

Supported alternatives include:

- running your own GitHub App and private key;
- exposing your ProPR API behind your own reverse proxy and using direct webhooks;
- using polling-based issue intake where supported;
- running a fully private deployment with your own routing layer.

The hosted relay is the recommended default because it avoids inbound networking requirements and keeps GitHub App setup simpler.

## Current Limitations

Today, tunnel-based OAuth requires the local ProPR instance to use a callback URL that matches its per-instance proxy hostname, such as `https://t-<id>.propr.dev/api/auth/github/callback`; you must register the same URL in the GitHub OAuth App used by that stack. A centralized login flow is planned so the hosted UI can use one stable callback URL while still connecting users to the correct self-hosted instance.

Tunnel provisioning is managed by ProPR Connect for Plus installations: Connect creates the Cloudflare Tunnel, shows the one-time connector token and setup command, and opens `app.propr.dev` with a validated `?tunnel=t-<id>.propr.dev` deep link. The setup command, configuration, and the handling of the live connector token are documented in [Hosted UI Tunnel](./hosted-ui-tunnel.md).

## When To Use It

Use ProPR Connect if you want:

- the shared ProPR GitHub App;
- no inbound webhook endpoint into your network;
- event delivery over outbound connections;
- managed recovery of failed GitHub webhook deliveries;
- optional hosted UI access to a local ProPR API.

Use a custom deployment path if you need to own every public endpoint, GitHub App, webhook, and routing service yourself.

## Related Setup Guides

- [GitHub Authentication](./github-auth.md) explains relay mode and installation token handling.
- [Production Deployment](./deployment.md) documents issue intake modes and server deployment.
- [Hosted UI Tunnel](./hosted-ui-tunnel.md) covers tunnel architecture, provisioning, and configuration.
- [ProPR CLI](../features/propr-cli.md) documents the `propr relay` and `propr tunnel` commands.
