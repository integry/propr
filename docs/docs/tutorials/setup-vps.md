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
`203.0.113.10` with your server IP throughout. Steps 1–4 are run as **root** (or
with `sudo`). From step 5 onward you must be logged in as the unprivileged `you`
user — the guide will remind you where to switch.
:::

## 1. Create An Admin User And Lock Down SSH

*Run as: **root**.*

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

Apply it. The SSH service is named `ssh` on most Debian/Ubuntu images but `sshd`
on some, so try both:

```bash
sudo systemctl restart ssh || sudo systemctl restart sshd
```

Keep your existing root session open and confirm a **new** session still
connects before relying on the change.

## 2. Patch The System And Enable Automatic Security Updates

*Run as: **root** (or `you` with `sudo`).*

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

*Run as: **root** (or `you` with `sudo`).*

:::tip Cloudflare Tunnel users — read this first
If you plan to front ProPR with Cloudflare Tunnel (see
[Advanced VPS Hardening](./setup-vps-hardening.md)), you do **not** need to open
ports 80/443 and can skip Certbot in step 9. The tunnel makes an outbound
connection to Cloudflare's edge, so no public inbound web ports are required. You
still need the firewall (allow SSH only) and nginx (it routes requests locally).
Decide now — complete steps 1–8 here, then follow the hardening tutorial instead
of step 9, which walks through the localhost-only nginx config and the tunnel
together.
:::

Allow SSH (and, for the public-TLS path, web traffic); deny everything else
inbound.

```bash
sudo apt -y install ufw
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH

# Public-TLS path only (step 9 with nginx + Certbot). SKIP these two lines if you
# are using Cloudflare Tunnel — the hardening tutorial needs no public web ports.
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

sudo ufw enable
sudo ufw status verbose
```

If you are taking the Cloudflare Tunnel path, run everything above **except** the
two `ufw allow 80/443` lines; the tunnel reaches nginx over localhost and needs no
inbound web ports.

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

*Run as: **root** (or `you` with `sudo`). This is the last root section — steps 5
onward run as `you`.*

Install Docker Engine from Docker's official apt repository. As with NodeSource
below, add the signing key and a `signed-by` apt source rather than piping
`get.docker.com` straight into a root shell — apt then verifies every Docker
package against the pinned GPG key on each `apt update`, keeping the posture
consistent with the rest of this guide:

```bash
# Add Docker's official GPG key and signed-by apt source. Derive the distro
# ("ubuntu" or "debian") from /etc/os-release so the same block works on either —
# do not hard-code one or the other.
sudo apt -y install ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
DISTRO=$(. /etc/os-release && echo "$ID")   # "ubuntu" or "debian"
curl -fsSL "https://download.docker.com/linux/$DISTRO/gpg" \
  | sudo gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/$DISTRO $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list
sudo apt update
sudo apt -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

sudo usermod -aG docker you      # run docker without sudo; log out/in to apply
sudo systemctl enable --now docker
```

The `DISTRO` variable resolves to `ubuntu` or `debian` from `/etc/os-release`, so
the key URL and apt source point at the right repository on either distribution
without manual editing. The convenience `curl -fsSL https://get.docker.com | sudo
sh` script does the same repository setup but executes a remote script as root;
the explicit steps above keep the security posture consistent with the rest of
this guide.

Adding `you` to the `docker` group is equivalent to granting root on the host
(the Docker socket can mount any path). Keep that group membership limited to
your admin user.

Install Node.js 22+ (required by the ProPR CLI) and the CLI itself. On a
hardening-focused box, add NodeSource as a signed apt repository (keyring +
`signed-by`) rather than piping their setup script straight into a root shell —
apt then verifies every package against the pinned GPG key on each `apt update`:

```bash
# Add NodeSource's signing key and a signed-by apt source for Node.js 22.x
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
  | sudo gpg --dearmor --yes -o /usr/share/keyrings/nodesource.gpg
echo "deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
  | sudo tee /etc/apt/sources.list.d/nodesource.list
sudo apt update && sudo apt -y install nodejs
sudo npm install -g @propr/cli
```

The one-line `curl … | sudo -E bash -` form from the
[official NodeSource instructions](https://github.com/nodesource/distributions#installation-instructions)
does the same repository setup but executes a remote script as root; the explicit
steps above keep the security posture consistent with the rest of this guide.
Confirm the CLI is on the expected `PATH` before continuing:

```bash
which propr && propr --version   # should resolve to the global npm prefix, e.g. /usr/bin/propr
```

## 5. Authenticate Agent CLIs On The Host

*Run as: **you** (the unprivileged user) for this and every following section.*

:::warning Switch to your unprivileged user now
All remaining steps must run as `you`, not root. If you are still in a root
session, switch now:

```bash
su - you
# or open a new SSH session: ssh you@203.0.113.10
```

Running `propr init stack` or agent logins as root places credentials and
files under `/root`, where the stack cannot find them.
:::

Each coding agent runs from credentials mounted off the host. **Install the CLI
for each agent you intend to use first** (only `@propr/cli`, Docker, and Node were
installed above — the agent CLIs are separate), then log in **as `you`** (not
root) so the credential directory lives under `/home/you` where the stack expects
it. For example:

```bash
claude login        # Claude Code  -> ~/.claude  (npm i -g @anthropic-ai/claude-code)
# or: agy login     # Antigravity  -> ~/.gemini  (curl -fsSL https://antigravity.google/cli/install.sh | bash)
```

These two are examples, not the full set. Install and log in to whichever agents
you plan to run; each writes its login state to a credential directory under
`/home/you` that the stack mounts into worker runs.

:::warning Prefer official install docs over `curl … | bash` on a hardened host
On a security-hardened box, follow each vendor's **official installation
documentation** as the primary path — verify checksums or use a signed package
repository where one is offered. The `curl -fsSL … | bash` one-liners in the
table below are convenience snippets only: they pipe a remote script straight
into a shell, can change upstream without notice, and bypass the package-pinning
posture used for Node.js and `cloudflared` elsewhere in this guide. Treat
[Agents and Models](../features/agents-and-models.md) as the canonical source for
each agent's current, vendor-recommended install command and verify there if a
command fails:

| Agent | Install | Credential directory |
|---|---|---|
| Claude Code | `npm i -g @anthropic-ai/claude-code` | `~/.claude` |
| Antigravity | `curl -fsSL https://antigravity.google/cli/install.sh \| bash` | `~/.gemini` |
| Codex | see [Agents and Models](../features/agents-and-models.md) | `~/.codex` |
| OpenCode | `curl -fsSL https://opencode.ai/install \| bash` | `~/.config/opencode` |
| Vibe | see [Agents and Models](../features/agents-and-models.md) | `~/.vibe` |

See [Agents and Models](../features/agents-and-models.md) for each agent's exact
install command, login step, and credential directory — including the OpenCode
`XDG_DATA_HOME` requirement for file-based auth, and the full Codex and Vibe
install/login steps not shown inline above.

:::warning Finish agent setup before continuing
This is a branch point: `propr check` in step 11 validates the credentials of
every agent you intend to run. Install **and** log in to each agent — completing
the linked agent-specific setup for any (such as Codex or Vibe) that are not
shown inline here — before moving on, or `propr check` will report missing agent
CLIs or credentials.
:::

## 6. Scaffold The Stack

*Run as: **you**.*

Create a runtime directory and scaffold it with the CLI. `/srv/propr` is a
conventional location; keep it owned by `you`.

```bash
sudo mkdir -p /srv/propr && sudo chown -R you:you /srv/propr
cd /srv/propr
propr init stack
```

`propr init stack` creates `data/`, `logs/`, and `repos/`, writes `.env` from the
bundled template, and records any agent credential directories it detects under
`/home/you`.

## 7. Configure GitHub Access

*Run as: **you**.*

Choose one auth mode (full detail in [GitHub Authentication](../operations/github-auth.md)):

- **Own GitHub App** — copy the App private key onto the server first, then lock
  down its permissions (readable only by `you`) and set the App identifiers in
  `.env`. From your laptop, upload the `.pem` you downloaded from GitHub:

  ```bash
  # On your laptop — copy the key to the runtime directory on the VPS:
  scp ./app-private-key.pem you@203.0.113.10:/srv/propr/app-private-key.pem
  ```

  ```bash
  # On the VPS — restrict the key now that the file exists:
  chmod 600 /srv/propr/app-private-key.pem
  ```

  ```bash
  # in /srv/propr/.env
  GH_AUTH_MODE=app                                # app mode is inferred from the keys below, but set it explicitly here
  GH_APP_ID=123456
  GH_INSTALLATION_ID=987654
  HOST_GH_PRIVATE_KEY=/srv/propr/app-private-key.pem
  ```

  App mode is the inferred default once `GH_APP_ID`/`GH_INSTALLATION_ID`/the
  private key are present (the resolution order is demo → relay → app), so
  `GH_AUTH_MODE=app` is optional — but set it explicitly to avoid surprises if a
  relay variable is ever left in the environment. See
  [GitHub Authentication](../operations/github-auth.md) for the mode precedence.

- **Shared App via relay** — no private key on the server. Enrollment opens the
  GitHub OAuth flow to prove your identity, then writes a relay token to `.env`;
  it contacts the vendor relay directly, so no prior `propr remote`/`propr login`
  state is required:

  ```bash
  cd /srv/propr         # run from the stack directory so the token lands in its .env
  propr relay enroll     # OAuth login, then writes a relay token to .env
  ```

## 8. Bind Service Ports To Localhost

*Run as: **you** (editing `/srv/propr/.env`).*

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

# Browser sign-in (GitHub OAuth App + signed session cookies). Without these the
# dashboard cannot complete a GitHub login after the stack starts in step 11.
GH_OAUTH_CLIENT_ID=your_github_oauth_client_id
GH_OAUTH_CLIENT_SECRET=your_github_oauth_client_secret
SESSION_SECRET=paste_the_generated_hex_string_here
```

:::caution Keep the port values in `host:port` form, not URL form
`API_PORT`/`UI_PORT` are Docker port bindings, so they take a bare
`127.0.0.1:4000` host-and-port value — **not** a URL. Do not prefix them with
`http://` or add a path: a value like `http://127.0.0.1:4000` is invalid here and
will break the published-port binding. The `http(s)://…` form belongs only on the
`FRONTEND_URL`/`API_PUBLIC_URL`/`GH_OAUTH_CALLBACK_URL` lines below.
:::

:::warning Generate the secret first — `.env` does not run shell commands
`.env` files are read literally; they do **not** evaluate `$(...)`. If you paste
`SESSION_SECRET=$(openssl rand -hex 32)` the app uses that literal text as the
secret. Run the command in your shell first, then paste the resulting hex string:

```bash
openssl rand -hex 32   # copy the output into SESSION_SECRET above
```
:::

Now that `.env` holds OAuth and session secrets, lock it down so only `you` can
read it:

```bash
chmod 600 /srv/propr/.env
```

Leave `REDIS_EXTERNAL_PORT` unset — Redis then stays on the internal Docker
network and is never published to the host at all.

:::note OAuth App vs. GitHub App
`GH_OAUTH_CLIENT_ID`/`GH_OAUTH_CLIENT_SECRET` come from a GitHub **OAuth App**
(used for the browser sign-in flow) — these are separate from the **GitHub App**
identifiers you set in step 7 (used to act on repositories). Register the OAuth
App with its **Authorization callback URL** set to the
`GH_OAUTH_CALLBACK_URL` above. See
[GitHub Authentication](../operations/github-auth.md) for the full setup.
:::

:::note Why explicit URLs are required here
The launcher derives `API_PUBLIC_URL`/`FRONTEND_URL` from the port value when you
don't set them (`http://localhost:<port>`). With a `127.0.0.1:4000` port form
that derivation would produce a malformed URL, so you must set the three public
URLs above yourself. On a TLS server you would set them regardless.
:::

## 9. Terminate TLS With A Reverse Proxy

*Run as: **you** with `sudo` (system service config); the `.env` stays owned by
`you`.*

:::tip Planning to use Cloudflare Tunnel?
If you intend to use Cloudflare Zero Trust, **skip this step entirely** and
follow [Advanced VPS Hardening](./setup-vps-hardening.md) instead. That tutorial
sets up nginx bound to localhost (Cloudflare provides edge TLS and the tunnel
reaches nginx over the loopback), so there is no Certbot and no public port to
open. Resume this tutorial at step 10 afterward.
:::

:::warning DNS first
Point your domain's DNS `A` record at the server (`propr.example.com →
203.0.113.10`) **before** running Certbot, and wait for it to resolve
(`dig +short propr.example.com` should return `203.0.113.10`). Certbot's HTTP-01
challenge fails if the name does not yet resolve to this host.
:::

Install nginx and Certbot, then obtain a certificate.

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
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

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
        proxy_set_header X-Forwarded-Proto $scheme;
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

*Run as: **you** (editing `/srv/propr/.env`).*

ProPR acts on GitHub as a bot identity; anyone who can comment a command on a
watched repository could otherwise drive it. Whitelist the GitHub usernames
allowed to use the system in `/srv/propr/.env`:

```bash
GITHUB_USER_WHITELIST=you,teammate-a,teammate-b
```

If you enable webhooks (optional — ProPR polls every 60s by default), a webhook
secret is mandatory and the API refuses to start without it (if you arrived here
from [Advanced VPS Hardening](./setup-vps-hardening.md) and put the app behind a
Cloudflare Access SSO gate, **stay on polling** — GitHub's webhook POSTs cannot
pass Access and will be silently dropped unless you added the explicit `/webhook`
Bypass policy described there):

```bash
ENABLE_GITHUB_WEBHOOKS=true
GH_WEBHOOK_SECRET=paste_the_generated_hex_string_here
```

As with `SESSION_SECRET`, `.env` does not evaluate `$(...)`. Generate the value in
your shell first, then paste the hex string above (and re-run `chmod 600
/srv/propr/.env` if you edit the file as a different user):

```bash
openssl rand -hex 32   # copy the output into GH_WEBHOOK_SECRET above
```

Set the same secret and the `https://propr.example.com/webhook` URL in your
GitHub App's webhook settings. See [Server Setup](./setup-server.md#configure-github-webhooks-optional)
for the full webhook walkthrough.

## 11. Verify And Start

*Run as: **you**.*

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

Open `https://propr.example.com`, sign in with GitHub, and confirm the dashboard
loads. Note that `GITHUB_USER_WHITELIST` (step 10) gates who can **trigger** work
from GitHub comments — it is an action/trigger gate, not a dashboard sign-in
control. To restrict who can authenticate to or view the Web UI itself, put it
behind an SSO gate such as the Cloudflare Access layer in
[Advanced VPS Hardening](./setup-vps-hardening.md). From a machine off the server,
verify the raw ports are **not** reachable — these should both fail/time out:

```bash
curl -m 5 http://203.0.113.10:4000/   # API port — must NOT respond
curl -m 5 http://203.0.113.10:5173/   # UI port  — must NOT respond
```

You can also confirm the bind locally on the VPS — the published ports should
show `127.0.0.1:4000`/`127.0.0.1:5173` (or `[::1]:...`), never `0.0.0.0:*` or
`*:*`, which would mean they are listening on every interface:

```bash
ss -ltnp | grep -E ':4000|:5173'   # both must be bound to 127.0.0.1, not 0.0.0.0
```

Only `https://propr.example.com` (443) and SSH (22) should answer.

## 12. Operate It

*Run as: **you**; the `sudo` in the update command matches the root-owned global
CLI install from step 4.*

- **Updates:** run `propr start --restart` from the stack directory so it acts on
  the right runtime root:

  ```bash
  sudo npm update -g @propr/cli
  cd /srv/propr && propr start --restart   # pulls matching images, recreates the stack
  ```

  `propr start --restart` resolves its stack relative to the current directory (or
  `--root`), so `cd /srv/propr` first to avoid restarting against the wrong path.
  Use the **same method you installed the CLI with** — `sudo` here matches the
  root-owned global install in step 4. If you instead installed under a
  user-managed npm prefix (so `npm -g` needs no `sudo`), drop the `sudo`; mixing
  the two can update a different copy or create root-owned files in a user-owned
  prefix. Unattended-upgrades keeps the OS patched.
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

## Go Further: Cloudflare Zero Trust

To remove **all** public inbound traffic from the VPS — closing ports 80 and 443
so only SSH remains — front ProPR with Cloudflare Tunnel, and optionally add a
Cloudflare Access SSO gate. That advanced hardening layer lives in its own
tutorial: [Advanced VPS Hardening](./setup-vps-hardening.md). Follow it instead
of step 9 if you decided up front to use Cloudflare (see the tips in steps 3
and 9).
