# GitHub Authentication

The ProPR backend (daemon, workers, API) acts on GitHub as a **GitHub App** —
it reads labeled issues, pushes branches, and opens pull requests as the app's
bot identity. There are three ways to configure how the backend obtains a GitHub
**installation access token**. The mode is inferred from your environment
(precedence: demo → relay → app), or set explicitly with `GH_AUTH_MODE`.

> **Auth mode and event intake mode are configured separately.** `GH_AUTH_MODE`
> controls only how the backend *authenticates* to GitHub (how it obtains an
> installation token). How ProPR *receives* GitHub events — routing WebSocket,
> polling, or a direct webhook — is configured by `GITHUB_EVENT_INTAKE_MODE`
> (default `routing_websocket`). They are set independently, but not every
> combination is valid: the routing WebSocket shares the vendor's relay
> infrastructure, so `routing_websocket` intake **requires relay auth mode**.
> Polling works with either relay or App auth, and `direct_webhook` requires App
> auth. See [Issue Intake Modes](./deployment.md#issue-intake-modes) for event
> delivery, and note that `GH_WEBHOOK_SECRET` belongs to the intake configuration
> (it applies only to `direct_webhook`) and is independent of auth mode.

For the hosted bridge that provides relay auth, GitHub event routing, failed
delivery recovery, and optional hosted UI tunnels, see
[ProPR Connect](./propr-connect.md).

## Modes

### App mode (own GitHub App)

You register your own GitHub App, install it on your account/org, and give the
stack the App's private key. The backend mints installation tokens locally.

```bash
GH_APP_ID=123456
GH_INSTALLATION_ID=987654
GH_PRIVATE_KEY_PATH=/usr/src/app/data/app-private-key.pem
# Recommended with the CLI/launcher: bind-mount the key from any host path:
HOST_GH_PRIVATE_KEY=/home/you/propr/app-private-key.pem
```

`propr check` verifies all three are set (not placeholders) and that the key file
is readable.

### Relay mode (shared GitHub App)

When you use a **shared** GitHub App provided by the vendor, you don't hold its
private key. Instead the stack fetches short-lived installation tokens from a
vendor-run **relay**, authenticated by a durable per-installation credential.

```bash
GH_AUTH_MODE=relay                                # optional but recommended; relay is also inferred from URL+token
PROPR_GH_RELAY_URL=https://webhook.propr.dev/v1   # optional; defaults to the hosted relay. https required (http only for localhost), include version prefix
PROPR_GH_RELAY_TOKEN=your_relay_token             # durable credential issued for your installation
GH_INSTALLATION_ID=987654                         # optional; which installation
```

No private key is required. The relay token is issued during enrollment (you log
in via the existing GitHub OAuth flow, which proves your identity and that you
installed the shared app). Tokens are cached in memory and refreshed shortly
before they expire — every other GitHub call and `git push` goes **directly** to
GitHub, so the relay is only contacted ~hourly to mint a fresh token.

The simplest way to set all four values above is to pick **Token relay** in
`propr setup`: it enrolls with your `propr login` identity, auto-discovers the
installation, mints the token, and writes the keys to `.env` for you. You can
also enroll standalone with `propr relay enroll` (see
[ProPR CLI](../features/propr-cli.md#github-relay-shared-app-auth)).

> Per-user access: a single stack can be shared by multiple whitelisted GitHub
> users. Each user's access is gated at request time by their own OAuth login and
> the ProPR whitelist; execution runs under the single stack-wide installation
> token (the bot). The whitelist gates dashboard and CLI login *and* GitHub-triggered work alike — see [Who Can Trigger Work](../concepts/security-overview.md#who-can-trigger-work).

### Demo mode

```bash
PROPR_DEMO_MODE=true
```

No GitHub access; the API serves read-only with a curated config. The daemon and
workers do not operate.

## Relay endpoint contract

The relay is a vendor-run service that holds the shared App's private key. A
self-hosted (own) relay must implement this contract:

- **Request:** `POST <PROPR_GH_RELAY_URL>/installation-token` (PROPR_GH_RELAY_URL includes the version prefix, e.g. `https://webhook.propr.dev/v1`)
  - Header: `Authorization: Bearer <PROPR_GH_RELAY_TOKEN>`
  - Body: `{ "installation_id": "<id>" }` (optional; the relay may infer the
    installation from the credential)
- **Behavior:** verify the relay token → map it to an installation → mint an
  installation access token via the shared App's key (optionally scoping
  repositories/permissions).
- **Response (2xx):** `{ "token": "ghs_...", "expires_at": "<ISO 8601>" }`
- **401/403:** the relay credential is invalid or expired.

The relay token is the long-lived secret binding your stack to your installation;
treat it like a password. ProPR redacts it (and `ghs_` tokens) from logs.

## Verifying

Run `propr check` — it reports the detected auth mode and flags missing/invalid
configuration before you start the stack:

```bash
propr check
```
