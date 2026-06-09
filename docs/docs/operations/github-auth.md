# GitHub Authentication

The ProPR backend (daemon, workers, API) acts on GitHub as a **GitHub App** —
it reads labeled issues, pushes branches, and opens pull requests as the app's
bot identity. There are three ways to configure how the backend obtains a GitHub
**installation access token**. The mode is inferred from your environment
(precedence: demo → relay → app), or set explicitly with `GH_AUTH_MODE`.

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
PROPR_GH_RELAY_URL=https://relay.propr.dev   # https required (http only for localhost)
PROPR_GH_RELAY_TOKEN=your_relay_token        # durable credential issued for your installation
GH_INSTALLATION_ID=987654                    # optional; which installation
```

No private key is required. The relay token is issued during enrollment (you log
in via the existing GitHub OAuth flow, which proves your identity and that you
installed the shared app). Tokens are cached in memory and refreshed shortly
before they expire — every other GitHub call and `git push` goes **directly** to
GitHub, so the relay is only contacted ~hourly to mint a fresh token.

> Per-user access: a single stack can be shared by multiple whitelisted GitHub
> users. Each user's access is gated at request time by their own OAuth login and
> the ProPR whitelist; execution runs under the single stack-wide installation
> token (the bot).

### Demo mode

```bash
PROPR_DEMO_MODE=true
```

No GitHub access; the API serves read-only with a curated config. The daemon and
workers do not operate.

## Relay endpoint contract

The relay is a vendor-run service that holds the shared App's private key. A
self-hosted (own) relay must implement this contract:

- **Request:** `POST <PROPR_GH_RELAY_URL>/installation-token`
  - Header: `Authorization: Bearer <PROPR_GH_RELAY_TOKEN>`
  - Body: `{ "installationId": "<id>" }` (optional; the relay may infer the
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
