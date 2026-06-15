---
sidebar_position: 5
---

# Advanced VPS Hardening

This tutorial adds an optional **Cloudflare Zero Trust** layer on top of the
[Secure VPS Deployment](./setup-vps.md) tutorial. It removes all public inbound
traffic from the VPS and, optionally, puts an SSO identity gate in front of the
application.

[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
fronts ProPR: `cloudflared` makes an **outbound** connection to Cloudflare's edge,
which terminates TLS and forwards requests down the tunnel to nginx on localhost. You
then close ports 80 and 443 entirely — only SSH remains reachable from the
internet. This requires your domain to be on Cloudflare (the free plan includes
Tunnel and Access).

:::info Prerequisites
Complete the [Secure VPS Deployment](./setup-vps.md) tutorial **through step 8
(Bind Service Ports To Localhost)** first, but **stop before step 9**. This
tutorial replaces step 9's public TLS setup: instead of provisioning a public
certificate with Certbot and opening ports 80/443, you configure nginx for
localhost-only and let Cloudflare handle the certificate at the edge.

If you already followed step 3, you can leave ports 80/443 open for now and close
them at the end of this tutorial. Replace `propr.example.com` with your domain and
`203.0.113.10` with your server IP throughout, as in the base tutorial.
:::

:::tip Plan your issue-intake mode now
If you add the optional [Access identity gate](#4-add-an-access-identity-gate)
below, **polling** (ProPR's default) is the recommended mode — an SSO gate blocks
GitHub's server-to-server webhook POSTs to `/webhook`. Only enable webhooks
behind Access if you explicitly add a *Bypass* policy for the `/webhook` path, as
detailed at the end of this tutorial. Decide before configuring webhooks to avoid
silently dropped deliveries.
:::

## 1. Configure nginx For Localhost Only

Because Cloudflare terminates TLS at the edge and the tunnel reaches nginx over
the loopback interface, nginx never needs to listen on a public interface. Bind
it to `127.0.0.1` **from the start** so it is never reachable directly, even
before you close the firewall ports.

Install nginx (skip Certbot — Cloudflare provides the certificate):

```bash
sudo apt -y install nginx
```

Create `/etc/nginx/sites-available/propr.conf` with the listener bound to
localhost:

```nginx
server {
    listen 127.0.0.1:80;
    server_name propr.example.com;

    # Web UI
    #
    # The tunnel hands nginx plain HTTP over loopback, so $scheme is always
    # "http" here even though the browser-facing URL is HTTPS. Hardcode
    # X-Forwarded-Proto to https so the backend generates correct URLs and any
    # scheme-aware security logic (OAuth redirects, cookie flags) sees the real
    # browser scheme.
    location / {
        proxy_pass http://127.0.0.1:5173;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }

    # API, OAuth callback, and Socket.IO live on the API service
    location /api/ {
        proxy_pass http://127.0.0.1:4000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
    location /socket.io/ {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;

        # Live task updates ride a long-lived websocket; nginx's default 60s
        # read/send timeouts would drop idle connections and stall UI updates.
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    # GitHub webhook endpoint (only needed if you enable webhooks; see below).
    # ProPR serves a single POST /webhook route, so match it exactly with `= `:
    # a bare `location /webhook` is a prefix match that would also proxy siblings
    # like /webhookadmin or /webhook-test to the API.
    location = /webhook {
        proxy_pass http://127.0.0.1:4000/webhook;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

Enable the site and reload nginx:

```bash
sudo ln -s /etc/nginx/sites-available/propr.conf /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

There is no Certbot step and no `listen 443` block: Cloudflare's edge holds the
certificate, and the tunnel forwards plain HTTP to `127.0.0.1:80`.

:::note Traffic is still end-to-end HTTPS — the plain HTTP hop is local
The **browser → Cloudflare edge** hop is always HTTPS; the only cleartext hop is
**tunnel → local nginx**, which never leaves the loopback interface on your VPS.
This is *not* Cloudflare's "Flexible" SSL mode and you do not need to touch the
**SSL/TLS → Overview** encryption-mode setting — `cloudflared` brings its own
encrypted tunnel to the edge, so that mode does not apply to tunnel traffic.
Don't switch the zone to "Flexible" to accommodate this setup; leave it at its
default ("Full" or "Full (strict)"), which governs only any *non-tunnel* origins
on the same zone.
:::

## 2. Install And Create The Tunnel

```bash
# Install cloudflared from Cloudflare's apt repository. Dearmor the key into a
# binary keyring so apt's signed-by verification works even if the endpoint
# serves ASCII-armored output (same pattern as NodeSource in the base tutorial).
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
  | sudo gpg --dearmor --yes -o /usr/share/keyrings/cloudflare-main.gpg
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" \
  | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt update && sudo apt -y install cloudflared

# Authenticate (opens a browser link; pick your zone) and create the tunnel
cloudflared tunnel login
cloudflared tunnel create propr        # prints a tunnel UUID and writes a creds JSON
cloudflared tunnel route dns propr propr.example.com
```

Run as `you`, the credentials JSON and cert land under `~/.cloudflared/`. The
service installed below runs as **root**, so move the credentials file into
`/etc/cloudflared/` (root-owned, not world-readable) before installing the
service; you create the config there directly in the next step. Replace `<UUID>`
with the value printed by `tunnel create`:

```bash
sudo mkdir -p /etc/cloudflared
sudo mv ~/.cloudflared/<UUID>.json /etc/cloudflared/<UUID>.json
sudo chown root:root /etc/cloudflared/<UUID>.json
sudo chmod 600 /etc/cloudflared/<UUID>.json
```

Write `/etc/cloudflared/config.yml` (use `sudo`, since the directory is now
root-owned), pointing the tunnel at nginx on localhost and at the moved
credentials file:

```yaml
tunnel: <UUID>
credentials-file: /etc/cloudflared/<UUID>.json

ingress:
  - hostname: propr.example.com
    service: http://127.0.0.1:80
  - service: http_status:404
```

Install it as a service so it survives reboots. Pass `--config` explicitly so the
installer generates a config-based unit that reads `/etc/cloudflared/config.yml`
(and the moved credentials it references) rather than a token-based unit that
ignores your config file — a bare `sudo cloudflared service install` can pick up
the wrong settings depending on the `cloudflared` version. Run it after both
files are in place:

```bash
sudo cloudflared --config /etc/cloudflared/config.yml service install
sudo systemctl enable --now cloudflared
sudo systemctl status cloudflared      # confirm it started and read the creds file
```

Confirm the generated systemd unit actually runs the tunnel against
`/etc/cloudflared/config.yml` — depending on the `cloudflared` version, the
installer may write a token-based unit instead of one that reads your config
file. Inspect the unit and check the logs:

```bash
systemctl cat cloudflared              # ExecStart should reference the config-based tunnel run
sudo journalctl -u cloudflared -n 20   # look for the hostname and ingress rules from config.yml
```

If `ExecStart` does **not** reference `/etc/cloudflared/config.yml` (for example,
it runs `tunnel run --token …` instead), point the service at your config
explicitly with the documented config-based form and reinstall:

```bash
sudo cloudflared service uninstall
sudo cloudflared --config /etc/cloudflared/config.yml service install
sudo systemctl enable --now cloudflared
```

## 3. Close The Public Web Ports

With the tunnel up, nothing needs to reach the VPS directly. If you opened the
web rules in step 3 of the base tutorial, remove them now. If you followed the
"skip 80/443" advice and never opened them, these deletes will report
`Could not delete non-existent rule` — that is harmless, and you can skip them:

```bash
sudo ufw delete allow 80/tcp     # only if you opened it; ignore "non-existent rule"
sudo ufw delete allow 443/tcp    # only if you opened it; ignore "non-existent rule"
sudo ufw status verbose          # only OpenSSH should remain
```

Because nginx already listens on `127.0.0.1:80` (step 1), the site was never
exposed on the public interface — closing these ports simply removes the unused
firewall holes. The application is now reachable exclusively through
`https://propr.example.com` via Cloudflare.

## 4. Add An Access Identity Gate

Cloudflare Access can require SSO before any request reaches your origin. It is
**defense-in-depth on top of** ProPR's own GitHub login and user whitelist — not
a replacement — so expect users to authenticate twice unless you configure
Access to use GitHub as its identity provider.

In the Zero Trust dashboard, add a self-hosted Access application for
`propr.example.com` with an Allow policy scoped to your team's emails or GitHub
identities.

:::warning Webhooks cannot pass an SSO gate — use polling
GitHub delivers webhooks as server-to-server POSTs to `/webhook`; they cannot
complete a Cloudflare Access login and will be silently blocked.

**The recommended posture behind Access is to use polling** (ProPR's default) and
**not** enable webhooks at all. With the tunnel and an SSO gate, polling is the
cleanest and safest option: no endpoint needs to accept unauthenticated public
traffic, so there is nothing to carve an exception around. If you do not have a
specific reason to run webhooks, stop here — leave `ENABLE_GITHUB_WEBHOOKS` unset
and skip the advanced subsection below.

The GitHub OAuth callback (`/api/auth/github/callback`) is fine through Access —
it is the user's own browser, which has already authenticated.
:::

### 4a. (Advanced) Bypass Access For The Webhook Path

:::danger Advanced and security-sensitive — polling is strongly preferred
**Use polling. Treat this bypass as an exception, not a recommended path.** Skip
this entire subsection unless you have a concrete, standing reason to run webhooks
instead of polling — polling (above) is the default, needs no exception, and
carries none of the risk below.

A bypass carves a public, unauthenticated hole through your SSO gate, and its
safety depends entirely on Cloudflare's path-matching and route-precedence
behavior **and** on ProPR's current routes — both of which can change underneath
you. A wrong path or precedence assumption silently over-exposes the app. Because
the boundary is this fragile, the bypass is **not** a set-and-forget control: it
must be re-validated after every Cloudflare configuration change and after every
ProPR upgrade that could alter routes (see the re-audit note at the end of this
subsection). If you cannot commit to that revalidation discipline, do not enable
it — stay on polling.
:::

If you genuinely need webhook delivery behind Access, add a second,
**path-scoped** Access application with a single *Bypass* policy. Scope it to the
webhook path **and nothing else**. The path matters: do **not** bypass the bare
`propr.example.com` hostname, which would disable the Access gate for the entire
app.

:::tip Decision checkpoint — polling is recommended; only continue if all apply
Before adding the bypass below, confirm every one of these. If any is "no", stop
and stay on polling:

- [ ] You have a concrete, standing reason webhooks must be used instead of
      polling (latency-sensitive intake, deactivated polling, etc.).
- [ ] You will **re-validate** the bypass after every Cloudflare config change and
      every ProPR upgrade (the two-direction test below).
- [ ] `GH_WEBHOOK_SECRET` is set so the endpoint still verifies the HMAC signature
      even though Access no longer gates it.

Polling needs none of this — it is the default and carries none of the bypass risk.
:::

ProPR serves a single `POST /webhook` route, so scope the bypass to that **exact
path only** — matching the `location = /webhook` nginx block in the main
tutorial. Add one path to the application; do not add a broad `/webhook/*`
sub-path bypass unless a future release documents webhook subpaths you genuinely
need to exempt:

| Application domain | Intended to match |
|---|---|
| `propr.example.com/webhook` | the exact endpoint, including `?query` strings |

Cloudflare is expected to evaluate the more specific path-scoped application
before the hostname-wide Allow policy, so only this exact webhook path skips SSO
while everything else stays gated. **Path matching is security-sensitive and
Cloudflare's exact prefix/precedence behavior can change, so treat the above as a
starting point you must verify, not a guarantee** — confirm the current rules
against Cloudflare's
[Access application path matching](https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-public-app/)
and
[policy precedence](https://developers.cloudflare.com/cloudflare-one/policies/access/)
documentation. Then test both directions before relying on it:

- Send a test delivery from your GitHub App's **Recent Deliveries** tab and
  confirm `/webhook` returns `2xx` (not a Cloudflare Access login redirect).
- Load `https://propr.example.com/` in a fresh/incognito browser and confirm the
  app itself still forces SSO — proving the bypass did **not** widen beyond the
  webhook path.
- **Required:** from a fresh/incognito browser, load a *sibling* path that shares
  the `/webhook` prefix but is not the webhook endpoint — for example
  `https://propr.example.com/webhookadmin` and
  `https://propr.example.com/webhook-test` — and confirm each is **still forced
  through SSO** (an Access login redirect), not bypassed. If any sibling path
  skips SSO, your bypass is matching by bare prefix and is over-scoped: narrow the
  application path until only the exact `/webhook` endpoint is exempt before you
  rely on this setup.

The endpoint stays protected by the mandatory `GH_WEBHOOK_SECRET` HMAC signature
that ProPR already verifies.

Because these rules bypass Access by **path prefix**, treat the bypass as a
standing exception that requires revalidation — not a permanent control. Re-audit
it on **two triggers**: whenever you change Cloudflare configuration (Access
applications, policies, or their ordering — precedence is what keeps the bypass
scoped to `/webhook`) and whenever you upgrade ProPR or otherwise add routes.
Each time, re-run the test above and confirm the bypass still covers only the
exact `/webhook` endpoint. If a future release ever serves a different route that
shares the prefix — a sibling like `/webhookadmin`, or anything under
`/webhook/` — make sure it has **not** inherited the bypass and is left sitting
unauthenticated behind Access. Keep the application's paths as narrow as the
endpoints you actually expose.

## Next Steps

**Resume at [Secure VPS Deployment](./setup-vps.md#10-restrict-who-can-trigger-propr)
step 10** (Restrict Who Can Trigger ProPR) — do **not** go back to step 9, which
provisions public TLS with
Certbot and nginx and would re-expose the public web ports this tunnel setup
deliberately avoids. Step 10 finishes configuring the application; then verify and
start the stack. For ongoing operations, see
[Deployment](../operations/deployment.md) and
[Maintenance](../operations/maintenance.md).
