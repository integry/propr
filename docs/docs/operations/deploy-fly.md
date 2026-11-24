---
sidebar_label: "Deploy to Fly"
title: "Run the control plane on a Fly Machine with propr deploy fly"
description: "propr deploy fly runs the slim control plane and Redis on one small Fly Machine, keeps SQLite and Redis on a volume, sets secrets, enrolls Connect and the GitHub relay, and runs agents on Sprites or Fly Machines."
---
# Deploy to Fly

`propr deploy fly` runs the ProPR control plane on **one small Fly Machine**:

- the all-in-one app container (daemon, worker and API in one Node process, with the API serving the Web UI) — see [Slim Control Plane](./configuration-reference.md#slim-control-plane-all-in-one);
- Redis in the **same Machine**, bound to loopback;
- SQLite and the Redis append-only file on a Fly **volume**.

The published `propr/app` image from the CLI's launcher manifest is deployed as it is. There is no image build and no Docker-in-Docker. Agents are meant to run on **Sprites** by default, or on **Fly Machines**, neither of which needs Docker on the control-plane Machine.

:::warning Sprites and Fly Machines agents are not available yet
The worker in this release only runs Docker agents: it waits for the Docker agent image before it takes any task, and the Sprites and Fly Machines runtimes (#3764, #3767) have not landed. On a Machine without a Docker daemon it would never run a task, so the command refuses `--agent-runtime sprites` (the default) and `fly-machines` before creating anything on Fly, `--dry-run` included. Until then, deploy with [`--legacy-docker`](#legacy-mode-docker-in-the-machine).
:::

```bash
propr deploy fly --app my-propr --legacy-docker \
  --tunnel-token <connector-token> --tunnel-url https://t-<id>.propr.dev
```

The API is then at `https://my-propr.fly.dev`, and you sign in from the hosted UI at `https://app.propr.dev` through ProPR Connect (see [Browser sign-in](#browser-sign-in)). Run `propr remote https://my-propr.fly.dev` to point the CLI at it.

## Browser sign-in

The deployed API needs a way to sign browsers in, and the command stops before creating anything on Fly, `--dry-run` included, when it has none:

| Sign-in | What the deploy needs |
| --- | --- |
| ProPR Connect, from `https://app.propr.dev` | `--tunnel-token` and `--tunnel-url` (see [GitHub relay and Connect](#github-relay-and-connect)). The command enrolls the relay token Connect needs. |
| GitHub OAuth, on `https://<app>.fly.dev` | `GH_OAUTH_CLIENT_ID` and `GH_OAUTH_CLIENT_SECRET` in the stack `.env`, from a GitHub App or OAuth App whose callback URL is `https://<app>.fly.dev/api/auth/github/callback`. The deploy sets that callback itself and prints it. |
| None (read-only demo) | `PROPR_DEMO_MODE=true` in the stack `.env`. A later deploy that selects Connect or GitHub sign-in sets `PROPR_DEMO_MODE=false`, so the retained Fly secret cannot keep the API in demo mode. |

A relay token alone does not sign browsers in on Fly: the automatic Connect sign-in for relay-only stacks works only with a loopback callback, as on a local stack. Fly secret values cannot be read back, so an OAuth client left on the app by an earlier deploy does not count; keep it in the stack `.env`. The summary prints a `Sign-in:` line with the method the deploy chose.

```bash
# GitHub OAuth instead of Connect: GH_OAUTH_CLIENT_ID and GH_OAUTH_CLIENT_SECRET in the stack .env
propr deploy fly --app my-propr --legacy-docker
```

## How it reaches Fly

| Fly access | What the command does |
| --- | --- |
| `flyctl` (or `fly`) on `PATH` | Uses your `fly auth login` session. Writes `fly.toml` and `propr-machine.json` to `--out` (default `./propr-fly`), creates the app and volume, stages secrets with `fly secrets import --stage` (values go over stdin, never argv), then runs `fly deploy --image <manifest image> --ha=false` from the `--out` directory. `fly.toml` points at `propr-machine.json` by absolute path, because flyctl resolves `machine_config` against its working directory rather than the config file. |
| No flyctl | Uses the Machines API (`https://api.machines.dev/v1`) with `--token` or `FLY_API_TOKEN`, for example from `fly tokens create org`. It creates the app, allocates a shared IPv4 and an IPv6, creates the volume, sets secrets, then creates the Machine, or updates it in place on a later run, and waits until it starts. |

Use `--backend flyctl` or `--backend api` to choose explicitly. Before creating anything, a `--volume-size` over 5 GB is checked against the org's plan, which the command reads from Fly's GraphQL API (`organization.paidPlan`) with the same token or `fly auth` session. When the org is on the Free plan, the command stops with a message that the Free plan caps volumes at 5 GB (see [Fly Free plan](#fly-free-plan)). If the plan cannot be read, the deploy goes on and logs that. Every step can be rerun: an existing app, volume or Machine is reused and updated. A reused volume smaller than `--volume-size` is extended to that size before any secret is set, and the deploy stops if Fly does not then report the new size. With the Machines API the command refuses to run when two control-plane Machines exist, because one SQLite volume supports exactly one.

`--dry-run` writes `fly.toml` and `propr-machine.json`, prints the secret **names** it would set and the summary, and contacts nothing. With `--legacy-docker` the summary includes the persistent root filesystem size and its cost while stopped. A dry run does not read the org's plan; with a volume over 5 GB it prints a note that a real run will check it. It stops on the same configuration errors as a real run, such as missing [browser sign-in](#browser-sign-in).

## Machine layout

| Container | Image | Role |
| --- | --- | --- |
| `redis` | `redis:7-alpine` (manifest) | `--bind 127.0.0.1`, AOF and RDB in `/usr/src/app/data/redis`, `noeviction` so BullMQ keys are never evicted |
| `app` | `propr/app:<version>` (manifest) | `node dist/src/allInOne.js`, listening on `0.0.0.0:4000`; starts after Redis is healthy; health check `GET /health` |
| `tunnel` | `cloudflare/cloudflared` (manifest) | Only with Connect enrolled (see below) |
| `docker` | `docker:27-dind` | Only with `--legacy-docker` |

The volume (`propr_data`, 1 GB, encrypted) is mounted at `/usr/src/app/data`, the same path the local stack uses, and `DB_FILENAME=/usr/src/app/data/propr.sqlite`. The app container gets `PROPR_CONTAINERIZED=1`, `NODE_ENV=production`, `REDIS_HOST=127.0.0.1`, `PROPR_AGENT_RUNTIME`, and `API_PUBLIC_URL`, `FRONTEND_URL` and `GH_OAUTH_CALLBACK_URL` set to the public URL. `PROPR_TRUSTED_PROXY_PEERS=172.16.0.0/12` trusts the Fly proxy's forwarded client address and HTTPS scheme.

These values are plain Machine env. Everything secret is a Fly **app secret** and never appears in `fly.toml`, `propr-machine.json` or the output.

In a multi-container Machine, Fly passes app secrets only to the containers that list them by name. So the `app` container lists every secret the app has after the deploy, including ones an earlier deploy left (the command reads the app's secret names first), and the `tunnel` container lists `TUNNEL_TOKEN`. `propr-machine.json` contains these names, never the values.

## Secrets

| Secret | Source |
| --- | --- |
| Stack `.env` entries | `<stack root>/.env` when present, or `--env-file <path>`. Skipped: empty values, host paths (`HOST_*`), and every key the deploy sets itself (ports, Redis, database path, URLs, `NODE_ENV`, `PROPR_INDEXING`, the agent runtime and, with `--legacy-docker`, the clone, worktree and egress paths on the shared volume). Turn this off with `--no-env-file`. |
| `SESSION_SECRET` | Generated only when the app does not have one yet, so a redeploy does not sign everyone out. A `SESSION_SECRET` in the `.env` is uploaded as is. |
| `PROPR_GH_PRIVATE_KEY_B64` | The GitHub App key from `--github-app-key` or `HOST_GH_PRIVATE_KEY`, base64; a `PROPR_GH_PRIVATE_KEY_B64` already in the `.env` is uploaded as is. The Machine writes it to `/run/propr/github-app.pem` (mode 0400) and sets `GH_PRIVATE_KEY_PATH`. A redeploy without a key keeps the earlier one wired in the same way. |
| `GH_AUTH_MODE`, `PROPR_GH_RELAY_URL`, `PROPR_GH_RELAY_TOKEN`, `GH_INSTALLATION_ID` | The GitHub relay enrollment (below). |
| `GITHUB_EVENT_INTAKE_MODE` | Written on every run, see [GitHub event intake](#github-event-intake). |
| `SPRITES_TOKEN` | `--sprites-token` or `SPRITES_TOKEN`. Without it agent runs on Sprites fail, and the command says so. |
| `FLY_API_TOKEN` | `--agent-fly-token`, for the Fly Machines agent runtime. The deploy token is never reused for agents. |
| `PROPR_UI_TUNNEL_TOKEN`, `TUNNEL_TOKEN` | `--tunnel-token`. A tunnel token in the stack `.env` is **not** copied: two connectors on one tunnel would split traffic, so moving the tunnel to Fly is explicit. |

## GitHub relay and Connect

**GitHub relay.** When the stack brings neither its own GitHub App (`GH_APP_ID` plus a key) nor a relay token, and you are logged in with `propr login`, the command enrolls a new relay token labelled `fly:<app>@<host>`, just as `propr relay enroll` does. A read-only demo (`PROPR_DEMO_MODE=true`) without the tunnel flags is not enrolled, since it has no GitHub access. Connect sign-in (below) also needs a relay token, even with your own GitHub App: with the tunnel flags and no relay token, the command enrolls one. If it cannot enroll (not logged in, or `--no-relay`), it stops before creating anything on Fly. Your own GitHub App keeps GitHub API calls (`GH_AUTH_MODE=app`), with or without the tunnel flags and even next to a relay token, unless the `.env` sets `GH_AUTH_MODE` itself. The App's `GH_INSTALLATION_ID` must then be in the `.env`, or the command stops before creating anything. Relay credentials without an own App set `GH_AUTH_MODE=relay`. The deploy writes the mode on every run because Fly secrets are only added or replaced, never removed: a mode, relay token or installation id from an earlier deploy stays on the app, and an earlier `GH_AUTH_MODE` would otherwise outrank this run's credentials. A run without any GitHub credentials leaves the earlier ones in place. Fly cannot read back that earlier `GH_AUTH_MODE`, so when the app holds both a relay token and an own App, the run sets polling, which works with either mode, unless the `.env` sets `GH_AUTH_MODE`. The event intake an earlier deploy set cannot be read back either, and a demo deploy's intake may not start once demo mode is off, so it is not kept. `--relay` always enrolls and switches GitHub API calls to the relay, and `--no-relay` never enrolls. The installation id must belong to the shared ProPR App: an own App's `GH_INSTALLATION_ID` is never reused, so the id is discovered when you have exactly one; otherwise pass `--installation <id>`.

### GitHub event intake

Left unset, `GITHUB_EVENT_INTAKE_MODE` means `routing_websocket`, and without a relay token that mode stops the daemon and with it the whole all-in-one process. So every deploy writes a mode the Machine can run:

| GitHub credentials after the deploy | Intake |
| --- | --- |
| Demo mode (`PROPR_DEMO_MODE=true`) | `direct_webhook`. Nothing is ingested: demo mode makes no GitHub calls and the API turns `POST /webhook` off. |
| Relay auth and a relay token (this run's or an earlier deploy's) | `routing_websocket` |
| Your own GitHub App (`GH_AUTH_MODE=app`, including next to a Connect relay token) | `direct_webhook` when `GH_WEBHOOK_SECRET` is set, otherwise `polling` |

A `GITHUB_EVENT_INTAKE_MODE` in the stack `.env` is kept if the Machine can run it, under the same rules the daemon checks at boot. For example, `routing_websocket` with `--no-relay` and no relay token is refused. A deploy with no GitHub credentials at all, which happens with `--no-relay` and no own App outside demo mode, stops before any secret is set. The deploy log prints a `GitHub event intake:` line.

**ProPR Connect.** To drive the Fly instance from the hosted UI at `https://app.propr.dev`, pass the values that ProPR Connect shows for `propr tunnel setup`:

```bash
propr deploy fly --app my-propr --tunnel-token <connector-token> --tunnel-url https://t-<id>.propr.dev
```

This adds the `cloudflared` container, which reads `TUNNEL_TOKEN` so the token stays off argv, and maps `api` to loopback so Connect's `http://api:4000` ingress reaches the app. It also sets the same env as `propr tunnel setup`: `PROPR_INSTANCE_ID`, `PROPR_UI_PUBLIC_API_URL`, the hosted `FRONTEND_URL`, `PROPR_WEB_AUTH_MODE=connect`, and `loopback` as a trusted proxy peer. Stop the local stack's tunnel first if the same instance was running locally.

## Idle shutdown (not available yet)

The Machine runs continuously. The restart policy is `always`, Fly proxy autostop is off (it is traffic-based and would stop the Machine during an agent run with no HTTP traffic), and `min_machines_running = 1`.

:::warning Idle shutdown is not available yet
The app image in this release has no idle detector and no `/wake` endpoint (#3770), so nothing would ever stop an idle Machine. The command therefore refuses `--idle-shutdown` before creating anything on Fly, `--dry-run` included. Deploy without it.
:::

## Legacy mode: Docker in the Machine

`--legacy-docker` keeps the Docker agent runtime by running a Docker daemon in a `docker` container of the same Machine. The app container reaches it at `DOCKER_HOST=tcp://127.0.0.1:2375`, which is loopback only. Clones, worktrees and egress sockets move to a scratch directory, `/propr-shared`, that both containers mount at the same path, so agent bind mounts resolve inside the daemon. Every boot applies two fixes learned on Fly:

1. **ext4 loop mount for overlay2.** Without it, `dockerd` would fall back to the slow `vfs` driver on the Machine's overlay root filesystem. `/var/lib/docker` is an ext4 image (`/var/lib/propr-docker/docker.ext4`, the root filesystem size minus 4 GB for the Machine's own container images), checked with `e2fsck -p` and loop-mounted before `dockerd` starts, so the storage driver is `overlay2`. After a redeploy with a larger `--rootfs-size`, the next boot grows the existing image and its filesystem (`resize2fs`) in place and keeps its contents; it never shrinks it.
2. **Stale PID cleanup.** After an unclean stop, `/var/run/docker*` and `/run/containerd` PID files and sockets make `dockerd` refuse to start. They are removed first.

The image is on the Machine's **persistent root filesystem**, not on the Fly volume. The Machine is created with `rootfs.size_gb` (`--rootfs-size`, default 20 GB, at least 10) and `rootfs.persist: true`, so pulled images survive restarts. The volume stays at the 1 GB default and holds only SQLite and Redis. Fly's 5 GB volume cap on the Free plan does not apply to the root filesystem. A stopped Machine's persistent root filesystem is billed at $0.15/GB-month, which is $3.00/month for 20 GB, and the summary prints that cost. Deployments from earlier releases kept the image at `/usr/src/app/data/docker.ext4` on the volume. The first boot after a redeploy deletes that file, so the images are pulled again. Fly volumes never shrink, so the volume keeps its earlier size.

Legacy mode defaults to 2048 MB of memory and accepts `--memory 1024` or more. `dockerd` runs next to the app and Redis on a 1 GB Machine but not on 512 MB, and agent containers need room on top of that. The `docker` container must be allowed to create loop devices and mount filesystems. Prefer Sprites or Fly Machines agents where you can.

## Size, memory and cost

The default Machine is **shared-cpu-1x with 1 GB**.

| Measurement | Value | Source |
| --- | --- | --- |
| Multi-container (`full`) stack, idle on a 1 GB Fly Machine | ~450 MB (api ~170, worker ~115, indexing-worker ~90, ui ~35 MB, plus the daemon); ~366 MB free | [Setup → control-plane memory](../tutorials/setup.md) |
| All-in-one module-load baseline (what this deploy runs), x86_64, Node 22 | ~254 MB, versus ~800 MB summed over the four separate processes | same table |

The all-in-one process plus Redis fits comfortably in 1 GB. 512 MB is the stretch target and is not the default: steady-state usage grows with active tasks, open UI sessions and indexing. These numbers have not yet been re-measured on a live `propr deploy fly` Machine.

Fly prices for Ashburn (`iad`), from Fly's pricing page as of November 2026:

| Item | Price |
| --- | --- |
| shared-cpu-1x, 1 GB, running all month | $6.70/month |
| shared-cpu-1x, 512 MB, running all month | $3.69/month |
| Volume | $0.15/GB-month (1 GB default: $0.15/month) |
| Stopped Machine | $0.15/GB-month of root filesystem |
| Shared IPv4, IPv6, inbound transfer | free (a dedicated IPv4 is $2/month and is not allocated) |

Always on, the default deployment costs about **$6.85/month**. That is more than the Free plan's $5 of monthly usage, and the Machine cannot yet stop itself when idle (see [Idle shutdown](#idle-shutdown-not-available-yet)). The Free plan allows up to 3 Machines; this deployment uses one. With `--legacy-docker` the persistent root filesystem adds $0.15/GB-month while the Machine is stopped ($3.00/month for the default 20 GB).

### Fly Free plan

Fly rejects volumes over 5 GB on the Free plan (`Volumes larger than 5GB aren't included in the Free plan`). These choices fit:

| Item | Fits the Free plan |
| --- | --- |
| Machine | shared-cpu-1x, 1 GB (the default) |
| Volume | 1 GB (the default); anything up to 5 GB |
| Agents | Sprites (the default runtime), once the worker supports it (see the warning above) |
| Idle shutdown | opt-in with `--idle-shutdown`, once the app image supports it (see [Idle shutdown](#idle-shutdown-not-available-yet)) |
| Docker agents | `--legacy-docker` with the 1 GB volume. Docker images go on the persistent root filesystem (`--rootfs-size`), which the volume cap does not limit. A 20 GB persistent root filesystem with `dockerd` on overlay2 ran on a Free-plan shared-cpu-1x, 1 GB Machine (`--memory 1024`; the legacy default is 2048 MB); 512 MB was not enough. |

The command checks the cap before it creates anything: with a `--volume-size` over 5 GB on a Free-plan org, it stops and suggests the default.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `--app <name>` | required | Fly app name; URL `https://<name>.fly.dev` |
| `--org <slug>` | `personal` | Organization to create the app in |
| `--region <code>` | `iad` | Region for the Machine and volume |
| `--memory <mb>` / `--cpus <n>` | `1024` / `1` | Machine size (shared CPU) |
| `--volume <name>` / `--volume-size <gb>` | `propr_data` / `1` | Volume for SQLite and Redis; at most 5 GB on the Fly Free plan |
| `--image <ref>` | manifest `images.app` | Deploy a different app image |
| `--agent-runtime <runtime>` | `sprites` | `sprites`, `fly-machines`, or `docker` (with `--legacy-docker`). Only `docker` is accepted in this release, see the warning above |
| `--sprites-token`, `--agent-fly-token` | — | Agent runtime credentials, stored as secrets |
| `--root`, `--env-file`, `--no-env-file` | stack `.env` | Where secrets come from |
| `--github-app-key <path>` | `HOST_GH_PRIVATE_KEY` | Own GitHub App private key |
| `--relay`, `--no-relay`, `--relay-url`, `--installation` | auto | GitHub relay enrollment |
| `--tunnel-token`, `--tunnel-url`, `--instance-id` | — | ProPR Connect hosted UI tunnel |
| `--idle-shutdown [after]` | off | Refused in this release, see [Idle shutdown](#idle-shutdown-not-available-yet) |
| `--legacy-docker` | off | Docker daemon in the Machine |
| `--rootfs-size <gb>` | `20` | With `--legacy-docker`: persistent root filesystem for Docker images (at least 10) |
| `--token <token>`, `--backend auto\|flyctl\|api` | `auto` | How to reach Fly |
| `--out <dir>` | `./propr-fly` | Where generated files go |
| `--dry-run` | — | Write the files and print the plan only |

## Troubleshooting

- **First boot is slow.** The first start pulls the app image, which can take a few minutes; the Machines API backend waits up to 5 minutes. Watch it with `fly logs --app <app>`.
- **Agent runs fail at once.** Check the agent runtime credential: `SPRITES_TOKEN` for Sprites, `FLY_API_TOKEN` for Fly Machines.
- **Sign-in redirects to the wrong host.** The URLs follow the deploy: `https://<app>.fly.dev` without a tunnel, or `https://t-<id>.propr.dev` with Connect. Redeploy after you add or remove the tunnel flags.
