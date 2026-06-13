---
sidebar_position: 4
---

# Secure VPS Deployment

This tutorial provisions ProPR on a **brand-new Linux VPS** and hardens both the
host and the deployment. It assumes a fresh Ubuntu 22.04/24.04 (or Debian 12)
image with only root SSH access — the kind of box most cloud providers hand you.

The end state: ProPR runs from the prebuilt images, the application is reachable
only over HTTPS through a reverse proxy, every service port is bound to localhost,
the host firewall denies everything except SSH and web traffic, and access is
limited to the GitHub users you whitelist.

For the ProPR-specific configuration touched here (`.env`, GitHub auth,
webhooks), the [Server Setup](./setup-server.md), [GitHub Authentication](../operations/github-auth.md),
and [Deployment](../operations/deployment.md) pages go deeper; this page focuses
on the host and network hardening around them.

:::info Assumptions
Replace `propr.example.com` with your domain, `you` with your admin username, and
`203.0.113.10` with your server IP throughout. Commands are run as root unless a
`sudo` prefix is shown.
:::

## 1. Create An Admin User And Lock Down SSH

Working as root over password SSH is the most common way these boxes get
compromised. Create an unprivileged sudo user and switch to key-only login.

```bash
# As root on the VPS:
adduser you
usermod -aG sudo you

# Copy your SSH public key to the new user (from your laptop, or paste manually):
mkdir -p /home/you/.ssh
cp ~/.ssh/authorized_keys /home/you/.ssh/authorized_keys   # if root already has your key
chown -R you:you /home/you/.ssh
chmod 700 /home/you/.ssh && chmod 600 /home/you/.ssh/authorized_keys
```

Confirm you can open a **new** SSH session as `you` and run `sudo -v` before
continuing — do not close your root session until that works.

Then disable password and root login in `/etc/ssh/sshd_config` (or a drop-in
under `/etc/ssh/sshd_config.d/`):

```text
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
```

Apply it:

```bash
sudo systemctl restart ssh
```

## 2. Patch The System And Enable Automatic Security Updates

```bash
sudo apt update && sudo apt -y upgrade

sudo apt -y install unattended-upgrades fail2ban
sudo dpkg-reconfigure -plow unattended-upgrades   # enable the stable security channel
```

`fail2ban` ships with an SSH jail enabled by default, which throttles brute-force
attempts on port 22. Confirm it is running:

```bash
sudo systemctl enable --now fail2ban
sudo fail2ban-client status sshd
```

## 3. Configure The Host Firewall

Allow only SSH and web traffic; deny everything else inbound.

```bash
sudo apt -y install ufw
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status verbose
```

:::danger Docker bypasses UFW for published ports
Docker inserts its own `iptables` rules in the `DOCKER` chain when a container
**publishes a port to all interfaces** (the default `-p 4000:4000` form). Those
rules are evaluated before UFW's `INPUT` rules, so a published port is reachable
from the internet **even though `ufw status` shows it denied**.

This tutorial avoids the problem entirely by binding ProPR's service ports to
`127.0.0.1` (next step) so Docker never opens them on the public interface. Do
not rely on UFW alone to hide a container port — bind it to localhost, or do not
publish it.
:::

## 4. Install Docker And The ProPR CLI

Install Docker Engine from Docker's official repository:

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker you      # run docker without sudo; log out/in to apply
sudo systemctl enable --now docker
```

Adding `you` to the `docker` group is equivalent to granting root on the host
(the Docker socket can mount any path). Keep that group membership limited to
your admin user.

Install Node.js 22+ (required by the ProPR CLI) and the CLI itself:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt -y install nodejs
sudo npm install -g @propr/cli
```

## 5. Authenticate Agent CLIs On The Host

Each coding agent runs from credentials mounted off the host. Log in to at least
one agent CLI **as `you`** (not root), so the credential directory lives under
`/home/you` where the stack expects it. For example:

```bash
claude login        # Claude Code  -> ~/.claude
# or: agy login     # Antigravity  -> ~/.gemini
# codex / opencode / vibe similarly; see Agents and Models
```

See [Agents and Models](../features/agents-and-models.md) for each agent's login
and credential directory.

## 6. Scaffold The Stack

Create a runtime directory and scaffold it with the CLI. `/srv/propr` is a
conventional location; keep it owned by `you`.

```bash
sudo mkdir -p /srv/propr && sudo chown you:you /srv/propr
cd /srv/propr
propr init stack
```

`propr init stack` creates `data/`, `logs/`, and `repos/`, writes `.env` from the
bundled template, and records any agent credential directories it detects under
`/home/you`.

## 7. Configure GitHub Access

Choose one auth mode (full detail in [GitHub Authentication](../operations/github-auth.md)):

- **Own GitHub App** — place the App private key on the server (readable only by
  `you`) and set the App identifiers in `.env`:

  ```bash
  chmod 600 /srv/propr/app-private-key.pem
  ```

  ```bash
  # in /srv/propr/.env
  GH_APP_ID=123456
  GH_INSTALLATION_ID=987654
  HOST_GH_PRIVATE_KEY=/srv/propr/app-private-key.pem
  ```

- **Shared App via relay** — no private key on the server:

  ```bash
  propr login            # proves your GitHub identity
  propr relay enroll     # writes a relay token to .env
  ```

## 8. Bind Service Ports To Localhost

This is the step that makes the firewall meaningful. Set the API and UI ports to
bind to the loopback interface only, and set the public URLs explicitly (required
whenever you change the port form, because the auto-derived URLs assume a plain
port number).

In `/srv/propr/.env`:

```bash
# Bind published ports to localhost so they are never exposed on the public NIC.
API_PORT=127.0.0.1:4000
UI_PORT=127.0.0.1:5173

# Explicit public URLs (the reverse proxy serves these over HTTPS).
FRONTEND_URL=https://propr.example.com
API_PUBLIC_URL=https://propr.example.com
GH_OAUTH_CALLBACK_URL=https://propr.example.com/api/auth/github/callback
```

Leave `REDIS_EXTERNAL_PORT` unset — Redis then stays on the internal Docker
network and is never published to the host at all.

:::note Why explicit URLs are required here
The launcher derives `API_PUBLIC_URL`/`FRONTEND_URL` from the port value when you
don't set them (`http://localhost:<port>`). With a `127.0.0.1:4000` port form
that derivation would produce a malformed URL, so you must set the three public
URLs above yourself. On a TLS server you would set them regardless.
:::

## 9. Terminate TLS With A Reverse Proxy

Install nginx and Certbot, point your domain's DNS `A` record at the server
(`propr.example.com → 203.0.113.10`), then obtain a certificate.

```bash
sudo apt -y install nginx
```

Create `/etc/nginx/sites-available/propr.conf`:

```nginx
server {
    listen 80;
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

Enable the site and provision HTTPS:

```bash
sudo ln -s /etc/nginx/sites-available/propr.conf /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

sudo apt -y install certbot python3-certbot-nginx
sudo certbot --nginx -d propr.example.com
```

Certbot rewrites the server block to listen on `443` with the certificate and
adds an HTTP→HTTPS redirect; its systemd timer renews automatically. Confirm the
renewal timer is active:

```bash
sudo systemctl status certbot.timer
```

## 10. Restrict Who Can Trigger ProPR

ProPR acts on GitHub as a bot identity; anyone who can comment a command on a
watched repository could otherwise drive it. Whitelist the GitHub usernames
allowed to use the system in `/srv/propr/.env`:

```bash
GITHUB_USER_WHITELIST=you,teammate-a,teammate-b
```

If you enable webhooks (optional — ProPR polls every 60s by default), a webhook
secret is mandatory and the API refuses to start without it:

```bash
ENABLE_GITHUB_WEBHOOKS=true
GH_WEBHOOK_SECRET=$(openssl rand -hex 32)
```

Set the same secret and the `https://propr.example.com/webhook` URL in your
GitHub App's webhook settings. See [Server Setup](./setup-server.md#configure-github-webhooks-optional)
for the full webhook walkthrough.

## 11. Verify And Start

```bash
cd /srv/propr
propr check          # validates Docker, images, agent credentials, and GitHub auth mode
propr start --no-tui # pull images and start the stack without the interactive dashboard
```

The service containers run with `--restart unless-stopped`, so they come back
after a reboot as long as Docker starts on boot (`systemctl enable docker`, done
in step 4). Check status any time:

```bash
propr status         # local stack containers
propr remote-status  # backend health: daemon, workers, Redis, GitHub auth
```

Open `https://propr.example.com`, sign in with GitHub, and confirm only
whitelisted users can reach the dashboard. From a machine off the server, verify
the raw ports are **not** reachable — these should both fail/time out:

```bash
curl -m 5 http://203.0.113.10:4000/   # API port — must NOT respond
curl -m 5 http://203.0.113.10:5173/   # UI port  — must NOT respond
```

Only `https://propr.example.com` (443) and SSH (22) should answer.

## 12. Operate It

- **Updates:** `sudo npm update -g @propr/cli && propr start --restart` pulls the
  matching service images and recreates the stack. Unattended-upgrades keeps the
  OS patched.
- **Backups:** persist `/srv/propr/data` (SQLite, WAL-aware) and the
  `propr-redis-data` volume; `repos/` is re-creatable. See
  [Maintenance](../operations/maintenance.md).
- **Secrets hygiene:** keep `.env` and the App private key readable only by `you`
  (`chmod 600`), and never commit them. ProPR redacts relay and `ghs_` tokens
  from logs.
- **Docker socket:** the stack mounts `/var/run/docker.sock` to launch agent
  containers as siblings. Treat anyone with access to that socket, or to the
  `docker` group, as having root on the host.

For deeper operational guidance — image manifest, container names, metrics, and
recovery — see [Deployment](../operations/deployment.md) and
[Maintenance](../operations/maintenance.md).
