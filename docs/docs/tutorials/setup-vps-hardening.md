---
sidebar_position: 5
---

# Advanced VPS Hardening

This tutorial adds an optional **Cloudflare Zero Trust** layer on top of the
[Secure VPS Deployment](./setup-vps.md) tutorial. It removes all public inbound
traffic from the VPS and, optionally, puts an SSO identity gate in front of the
application.

Front ProPR with [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
and `cloudflared` makes an **outbound** connection to Cloudflare's edge, which
terminates TLS and forwards requests down the tunnel to nginx on localhost. You
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
    location / {
        proxy_pass http://127.0.0.1:5173;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # API, OAuth callback, and Socket.IO live on the API service
    location /api/ {
        proxy_pass http://127.0.0.1:4000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    location /socket.io/ {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }

    # GitHub webhook endpoint (only needed if you enable webhooks; see below)
    location /webhook {
        proxy_pass http://127.0.0.1:4000/webhook;
        proxy_set_header Host $host;
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

## 2. Install And Create The Tunnel

```bash
# Install cloudflared from Cloudflare's apt repository
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
  | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" \
  | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt update && sudo apt -y install cloudflared

# Authenticate (opens a browser link; pick your zone) and create the tunnel
cloudflared tunnel login
cloudflared tunnel create propr        # prints a tunnel UUID and writes a creds JSON
cloudflared tunnel route dns propr propr.example.com
```

Run as `you`, the credentials JSON and cert land under `~/.cloudflared/`. The
service installed below runs as **root**, so move both the credentials file and
the config into `/etc/cloudflared/` (root-owned, not world-readable) before
installing the service. Replace `<UUID>` with the value printed by
`tunnel create`:

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

Install it as a service so it survives reboots. With the config and credentials
already in `/etc/cloudflared/`, `service install` picks them up automatically;
run it after both files are in place:

```bash
sudo cloudflared service install
sudo systemctl enable --now cloudflared
sudo systemctl status cloudflared      # confirm it started and read the creds file
```

## 3. Close The Public Web Ports

With the tunnel up, nothing needs to reach the VPS directly. If you opened the
web rules in step 3 of the base tutorial, remove them now:

```bash
sudo ufw delete allow 80/tcp
sudo ufw delete allow 443/tcp
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

:::warning Webhooks cannot pass an SSO gate
GitHub delivers webhooks as server-to-server POSTs to `/webhook`; they cannot
complete a Cloudflare Access login and will be blocked. Either:

- **Use polling** (ProPR's default) and do not enable webhooks — with the tunnel
  this is the cleanest posture, since no endpoint needs to accept unauthenticated
  public traffic at all; or
- **Bypass `/webhook`** — add a second, **path-scoped** Access application whose
  application domain is exactly `propr.example.com/webhook` (the path matters —
  do **not** bypass the bare `propr.example.com` hostname, which would disable the
  Access gate for the entire app) with a single *Bypass* policy. Cloudflare
  evaluates the more specific path-scoped application first, so only `/webhook`
  skips SSO while everything else stays gated. The endpoint stays protected by the
  mandatory `GH_WEBHOOK_SECRET` HMAC signature that ProPR already verifies.

The GitHub OAuth callback (`/api/auth/github/callback`) is fine through Access —
it is the user's own browser, which has already authenticated.
:::

## Next Steps

**Resume at [Secure VPS Deployment](./setup-vps.md) step 10** (Restrict Who Can
Trigger ProPR) — do **not** go back to step 9, which provisions public TLS with
Certbot and nginx and would re-expose the public web ports this tunnel setup
deliberately avoids. Step 10 finishes configuring the application; then verify and
start the stack. For ongoing operations, see
[Deployment](../operations/deployment.md) and
[Maintenance](../operations/maintenance.md).
