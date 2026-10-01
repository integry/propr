# GitHub Authentication

The ProPR backend (daemon, workers, API) acts on GitHub as a **GitHub App** —
it reads labeled issues, pushes branches, and opens pull requests as the app's
bot identity. There are three ways to configure how the backend obtains a GitHub
**installation access token**. The mode is inferred from your environment
(precedence: demo → relay → app), or set explicitly with `GH_AUTH_MODE`, which
overrides inference except for `PROPR_DEMO_MODE=true`.

For the hosted bridge that provides relay auth, GitHub event routing, failed
delivery recovery, and optional hosted UI tunnels, see
[ProPR Connect](./propr-connect.md).

## Modes

### App mode (own GitHub App)

Create a private App for this stack, install it on your account or organization,
and let ProPR mint installation tokens locally.

```bash
propr github-app create --root /srv/propr --public-url https://propr.example.com
propr start --root /srv/propr --restart
```

The CLI and launcher mount the generated key using `HOST_GH_PRIVATE_KEY` and set
`GH_PRIVATE_KEY_PATH` inside containers. Do not set the container path yourself.
`propr check` verifies the key, installed permissions and event subscriptions, and
tries minting an installation token.

### Relay mode (shared GitHub App)

When you use a **shared** GitHub App provided by the vendor, you don't hold its
private key. Instead the stack fetches short-lived installation tokens from a
vendor-run **relay**, authenticated by a durable per-installation credential.

```bash
GH_AUTH_MODE=relay                                # optional but recommended; relay is also inferred from the token
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

## Create your own App

`propr github-app create --public-url https://propr.example.com` uses
[GitHub's manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest).
Click **Create GitHub App**, then **Install**, choosing the repositories ProPR may
access. Add `--org your-org` to register it under that organization; your GitHub
account must be allowed to create Apps there. The default name is
`ProPR (propr.example.com)`. Use `--name` to override it. If GitHub says the name
is taken, edit the name in GitHub's form and submit again.

The command writes an absolute `HOST_GH_PRIVATE_KEY` path under the stack root
and creates the PEM with mode `0600`. It saves `GH_APP_ID`, `GH_INSTALLATION_ID`,
`GH_WEBHOOK_SECRET`, `GH_OAUTH_CLIENT_ID`, `GH_OAUTH_CLIENT_SECRET`, and
`GH_OAUTH_CALLBACK_URL` in `.env`. The same App handles GitHub login at
`<public-url>/api/auth/github/callback`. It selects `GH_AUTH_MODE=app`, disables
demo mode, selects `GITHUB_EVENT_INTAKE_MODE=direct_webhook`, and removes active
relay/routing settings and stale `GH_PRIVATE_KEY_PATH` assignments.

Existing credentials require `--force`; before replacing `.env`, the command
creates `.env.bak-<timestamp>-<suffix>` with mode `0600`. Unrelated settings are
preserved. Back up the key and `.env` together. Process environment overrides
still take precedence: remove any exported relay or old App settings before
starting the stack.

The default webhook is `<public-url>/webhook`; override it with `--webhook-url`.
GitHub generates the signing secret. `--webhook-secret` overrides it in **both**
GitHub's webhook configuration and `.env`. Keep command-line secrets out of shell
history; the generated secret avoids that concern. `--json` prints only field
names and file paths to stdout, with progress on stderr.

### Permissions and events

The manifest and `propr check` share the following requirements with the webhook
handler:

| Repository permission | Access | Purpose |
|---|---|---|
| Contents | Write | Clone, branch, commit, push |
| Issues | Write | Labeled issues, labels, comments |
| Pull requests | Write | Open/update PRs and review comments |
| Metadata | Read | Required baseline |
| Checks | Read | Check runs, output, annotations, CI readiness |
| Commit statuses | Read | Commit status readiness |
| Actions | Write | Opt-in CI cancellation; read-only access leaves cancellation inert |
| Workflows | Write, optional | Allow pushes modifying `.github/workflows/*` |

Workflows permission is **not requested by default**. Add
`--allow-workflow-changes` if agents should modify CI definitions. Without it,
GitHub rejects pushes that create or modify `.github/workflows/*`. You can also
add the permission later in App settings and approve the installation's new
permissions. `propr check` warns when it is absent.

| Subscribed event | Purpose |
|---|---|
| `issues` | Issue intake and label changes |
| `issue_comment` | PR conversation follow-ups |
| `pull_request` | PR lifecycle and follow-ups |
| `pull_request_review_comment` | Inline review follow-ups |
| `check_run` | Check completion and failed-CI follow-ups |
| `push` | Branch changes |
| `status` | Commit status updates |

### SSH and callback handling

```bash
propr github-app create --root /srv/propr \
  --public-url https://propr.example.com --no-browser
```

The CLI writes a temporary HTML registration form and prints its path. Copy that
file to the machine with your browser (for example with `scp`) and open it. It
POSTs the manifest to GitHub; visiting the GitHub registration URL alone does
not submit a manifest. Alternatively, forward the printed loopback port through
SSH and open the printed local URL.

After creating the App, paste the **complete redirect URL**, including `code`
and `state`, into the terminal. The browser may show a connection error because
its loopback address is on a different machine; copy the URL from the address
bar anyway. Open the installation URL printed next, install the App, then paste
the installation redirect URL. You can instead press Enter after installation
to discover it through GitHub's API. The portable HTML file is deleted when the
command exits.

The listener binds only to `127.0.0.1` on a random port. It validates a one-time
state and exchanges the code within GitHub's one-hour limit. Installation IDs
are verified using the new App's JWT. After five minutes without an installation
callback, the CLI lists the new App's installations and accepts a single result,
then verifies it. Missing or ambiguous installations stop the flow.

GitHub's manifest documentation does not explicitly guarantee loopback HTTP
`redirect_url` and `setup_url` acceptance. Probot uses local registration
callbacks, but the authenticated GitHub registration round trip must still be
verified for your environment. Paste-back handles an unreachable callback; it
cannot bypass a URL GitHub refuses at registration time. If GitHub rejects these
URLs, use the manual manifest path with HTTPS callbacks you control.

### Manual registration and interrupted setup

For manual/offline preparation:

```bash
propr github-app manifest --root /srv/propr --public-url https://propr.example.com
```

This writes `github-app-manifest.json` and `github-app.env.example`, using the
same events, permissions, webhook and OAuth callback builder. It makes no GitHub
API calls and does not change `.env`. Submit the JSON in a `manifest` form field
to GitHub's [manifest registration endpoint](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest),
or use it as the settings checklist for manual registration. For an organization,
POST to `https://github.com/organizations/ORG/settings/apps/new`. A custom manifest
consumer must set its own redirect/setup URLs and exchange the one-time code.
Fill in the env template after registration, save the private key at an absolute
host path with mode `0600`, and set the same webhook secret in GitHub and `.env`.
The manifest cannot set the signing secret: `--webhook-secret` is applied only by
`create` after conversion, and never appears in the manual output.

If registration succeeds but installation or persistence fails, the CLI retains
`github-app-<id>-recovery.json` at mode `0600` and prints its path. This contains
**secrets**; do not share it. Finish installing the already-created App on GitHub.
Recover `id` → `GH_APP_ID`, `webhook_secret` → `GH_WEBHOOK_SECRET`, `client_id` →
`GH_OAUTH_CLIENT_ID`, and `client_secret` → `GH_OAUTH_CLIENT_SECRET` from that file
with a local editor. Save `pem` as a private key file at mode `0600` and set
`HOST_GH_PRIVATE_KEY` to its absolute path. Set `GH_INSTALLATION_ID` from the
installation's GitHub settings URL and use the remaining fields in the manual
env template. Remove relay/routing keys, then run `propr check`. If a secret
override request was interrupted, verify the signing secret matches on GitHub.
Delete the recovery file after successfully restoring the configuration.

Direct webhooks require a public endpoint GitHub can reach. Loopback/private URLs
produce a warning; for machines without inbound reachability, use
[ProPR Connect](./propr-connect.md). Configure your server's public URLs and proxy
as described in [Server Setup](../tutorials/setup-server.md).

## Auth Mode vs Event Intake Mode

`GH_AUTH_MODE` controls only how the backend *authenticates* to GitHub (how it
obtains an installation token). How ProPR *receives* GitHub events — routing
WebSocket, polling, or a direct webhook — is configured separately by
`GITHUB_EVENT_INTAKE_MODE` (default `routing_websocket`); see
[Issue Intake Modes](./deployment.md#issue-intake-modes) for event delivery.

The two are set independently, but some combinations are invalid:

- `routing_websocket` intake **requires relay auth mode** — the routing
  WebSocket shares the vendor's relay infrastructure.
- `polling` works with either relay or App auth.
- `direct_webhook` requires App auth.

`GH_WEBHOOK_SECRET` belongs to the intake configuration (it applies only to
`direct_webhook`) and is independent of auth mode.

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
