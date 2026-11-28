---
title: Run ProPR on Fly
description: Deploy one control-plane Machine, run agents on Sprites or Fly Machines, and budget for idle shutdown.
---

# Run ProPR on Fly

One shared-CPU Machine runs the API, UI, worker and Redis. A 1 GB volume keeps SQLite and the Redis queue across stops. Agents run in your Sprites organization or in a separate Fly app. **The default 1 GB control plane costs about $6.85 per 30 days always on.** To target $5 including agent runs, enable idle shutdown and measure how much of the month the Machine spends awake.

## Budget for a small installation

The full control plane measured about 450 MB idle on a 1 GB Fly Machine. The slim Node process measured about 254 MB at module load on x86-64. That second measurement excludes steady-state work and Redis. In live checks, HTTP requests woke the Machine and returned 200 in about 10–20 seconds (16 seconds in Amsterdam). These measurements inform the sizing below. The dollar amounts are estimates for Ashburn, USD per 30 days. [Memory measurements](./setup.md#control-plane-footprint) · [Wake measurement](../operations/deploy-fly.md#idle-shutdown) · [Fly rates](https://docs.fly.io/about/pricing)

| Control-plane scenario | Running compute | 1 GB volume | Stopped root filesystem | Subtotal |
| --- | ---: | ---: | ---: | ---: |
| 1 GB, always on (default) | $6.70 | $0.15 | $0 | $6.85 |
| 512 MB, always on (stretch target) | $3.69 | $0.15 | $0 | $3.84 |
| 1 GB, awake 4 h/day | $1.12 | $0.15 | $0.125 per GB | $1.52 with 2 GB rootfs |
| 1 GB, stopped all month | $0 | $0.15 | $0.15 per GB | $0.45 with 2 GB rootfs |

Four hours per day and a 2 GB root filesystem are example inputs. Substitute the billed rootfs size and running seconds from your organization. The four-hour example leaves **$3.48** for all agent compute, Sprite storage, snapshots, egress and other Fly usage. A shared-CPU 2x, 2 GB agent Machine adds about $0.019 per running hour in Ashburn. For Sprites, compare the organization’s usage before and after a representative batch, including cold provisioning and checkpoint storage. Model-provider charges are separate.

The live Sprite checks provide a baseline for interpreting the first run’s cost:

| Observed work | Measurement | Budget impact |
| --- | --- | --- |
| Create a bare Sprite | ~36 s | Allow additional time to install the agent CLIs. |
| Provision a Sprite with all pinned agent CLIs and complete two clone runs | 143–187 s total | Include the full setup and both runs in the first-run budget. |
| Run a warm CLI version check through the clone transport | 40–55 s per warm run | Wall time alone cannot price CPU and memory usage. |
| Run a small Claude Code edit on a Sprite | ~234 MB peak RSS, $0.031 model cost reported | Track the model charge separately from the Fly allowance. |

These are individual test runs. A real issue also spends time running the agent and its tests. [Sprite timing measurements](https://github.com/integry/propr/issues/3765) · [Small-edit measurements](https://github.com/integry/propr/issues/3764)

On the **personal Free plan**, adding a card gives $5 monthly usage, up to three Machines, three Sprites and 5 GB per volume. Count stopped Machines too when planning capacity, to be safe. One control plane leaves at most two Machine slots for agents. Set worker concurrency accordingly or set `PROPR_SPRITES_MAX=1` to start with one Sprite.

> **Fly Machines on the Free Plan.** An organization can have **3 Machines, stopped ones included**. With the Fly Machines runtime every agent run creates a Machine, so beside the control plane at most **2 agent runs** can run at once, fewer if other apps in the organization have Machines. When the limit is hit, Fly refuses the create with `HTTP 422: Your organization has reached its machine limit`: the run retries it for up to 5 minutes and then fails. On the Free Plan use Sprites (`RUNTIME=sprites`), or add `PROPR_FLY_MACHINES_MAX` to the environment file set to the free Machine slots: 3 minus the control plane and other apps' Machines, usually `PROPR_FLY_MACHINES_MAX=2`. Runs over that cap wait for a free slot instead of failing, a slot is freed only once the run's Machine is destroyed or Fly reports it gone, and a build Machine for the runtime packages image takes a slot too while it exists. The cap is counted per worker process: with several workers, the effective limit is `PROPR_FLY_MACHINES_MAX` × workers, so split the free slots between them. [Fly Machines capacity](../architecture/agent-runtime.md#fly-machines)

Exhausting the $5 automatically switches the organization to Pay As You Go and bills the **whole month from the first cent**. A manual upgrade has the same billing effect. Check Billing for other workloads sharing that allowance. [Fly Free plan](https://docs.fly.io/about/free-plan)

## Deploy from the Fly dashboard

You can launch ProPR from the [Fly dashboard](https://fly.io/dashboard) with **Launch an App → From GitHub**, without installing `flyctl` or the ProPR CLI. By default Fly pulls the released `propr/app` image, so there is no build, and ProPR's first-visit setup wizard does the rest in the browser.

1. **Fork** `integry/propr` into your GitHub account or organization.
2. In the Fly dashboard, choose **Launch an App → From GitHub**, pick the fork and the `main` branch (or a release tag), and choose the organization, app name and region. Leave **Config path** at the default. The fork's root `fly.toml` supplies the image (`propr/app:<version>`, pinned to that commit's release), the `propr_data` 1 GB volume, a shared-CPU 1x Machine with 512 MB and 512 MB of swap (see [Machine size](#machine-size)), the `/health` check and auto-start. Nothing is built: the deploy takes about a minute. Do not add secrets; the instance generates them.
3. When the deploy finishes, open the app's **Live Logs** (or run `fly logs`) and find the line `ProPR setup code: XXXX-XXXX-XXXX`.
4. Open `https://<app>.fly.dev/setup` and enter the code. The first browser to enter it claims the instance; anyone else, even with the code, is shut out. A restart before the claim prints a new code.
5. **Connect GitHub.** Choose one of two paths:
   - **Use the ProPR App (recommended, the default).** The same path `propr deploy fly` takes (see [GitHub relay and Connect](../operations/deploy-fly.md#github-relay-and-connect)): the shared ProPR App delivers GitHub events through ProPR Connect, so the instance needs no public webhook and no App of its own.
     1. Select **Install the ProPR App on GitHub** and install it on the repositories ProPR should work on.
     2. Connect has to know who you are before it issues this instance a relay token. `propr deploy fly` takes your token from `propr login`; the wizard uses GitHub's device flow with the shared App instead. Select **Sign in with GitHub**: the wizard shows a one-time code and a link to `github.com/login/device`. Enter the code there and authorize the ProPR App. The wizard page checks back on its own, at the interval GitHub sets, and continues once you've authorized. The code works only in the browser that claimed setup and expires after about 15 minutes; **Cancel and go back** drops it.
        - **Fallback: paste a token.** GitHub enables the device flow per App. While it is off for the ProPR App, GitHub answers `device_flow_disabled` and the wizard says *Device sign-in isn't enabled for the ProPR App yet* and offers the token field instead. The field is also always under **Paste a GitHub token instead**. Create a [fine-grained token](https://github.com/settings/personal-access-tokens/new) with the shortest expiry and **no** permissions (Connect only reads who you are), and paste it. A token from `gh auth token` works too.
        - With a relay of your own (`PROPR_GH_RELAY_URL`), the device flow needs the client ID of that relay's GitHub App in `PROPR_GH_DEVICE_CLIENT_ID`, with Device Flow enabled on that App. Without it, the wizard offers the pasted token only.
     3. The wizard asks Connect which installations that account can use. It takes the only one, or lists them for you to pick. After a device sign-in you just pick; the wizard holds that sign-in in memory for up to 10 minutes and uses it once. After a pasted token, paste it again with your pick: it was not kept. Connect then enrolls a relay token labelled `fly:<app>@<host>`, as the CLI labels it. The wizard checks the relay token by listing the installed repositories with it, and those become the monitored repository list.
     4. Only the relay token is kept. The GitHub sign-in (from the device flow or pasted) is used for this one enrollment and is never written to the volume or logged; you can delete a pasted token on GitHub right after. Enrolling needs the **owner** of the account the App is installed on (an organization owner, for an organization). Any other account gets `Only the owner … can connect an instance to it`, and nothing is stored.
   - **Advanced: Create your own GitHub App.** Use this when you want no ProPR-hosted service in the path. The wizard sends GitHub an App manifest with this instance's webhook (`/webhook`), sign-in callback and setup URLs filled in. Leave the organization empty for your personal account. GitHub returns the App's credentials to the instance, which stores them on the volume. Then **install the App** on the repositories ProPR should work on; the installed repositories become the monitored repository list.
6. **Register the sign-in app** (ProPR App path only; [#3867](https://github.com/integry/propr/issues/3867) replaces it with a device-flow sign-in that needs no OAuth App). ProPR Connect signs browsers in only through a hosted tunnel callback (`https://t-<id>.propr.dev`) or a loopback address, never through `https://<app>.fly.dev`. So the instance signs browsers in with GitHub OAuth, the same sign-in `propr deploy fly` uses without the tunnel flags. [Register a GitHub OAuth App](https://github.com/settings/applications/new) with homepage `https://<app>.fly.dev` and callback URL `https://<app>.fly.dev/api/auth/github/callback`, then paste its client ID and a new client secret. The OAuth App only identifies who signs in; it gets no repository access. With your own GitHub App, its own OAuth client does this, and there is no extra step.
7. **Sign in with GitHub.** That account becomes the first administrator (`PROPR_ADMIN_USERS`). The ProPR App path signs in through the OAuth App's one callback URL; the wizard forwards it while setup runs.
8. **Choose the agent runtime.** Only the chosen option's fields are shown. Each choice is checked before it is saved, and the next step shows what the check found, for example `Token works · organization personal · 3 of 3 Sprites free`:
   - **Sprites (the default):** select **Create Token** on Fly's [Sprites tokens page](https://fly.io/dashboard/personal/sprites/tokens). The link opens the personal organization; for another one, switch organization there. Scope the token as the wizard suggests:
     1. **Name prefix:** the prefix shown in the wizard, `propr-<16 hex>-`. ProPR names every Sprite of this instance with it. It is derived from the instance ID (the app name, unless a `PROPR_INSTANCE_ID` secret sets one), or read from the marker ProPR keeps on the volume once it has run.
     2. **Max Sprites:** 1 on the Free Plan. ProPR uses one Sprite at a time.
     3. **Expiry:** optional.

     The check lists Sprites under that prefix, so a token scoped to it passes.
   - **Fly Machines:** everything is prefilled:
     - The **agent app** is `<app>-agents`. The wizard shows one command that creates the app and its deploy token, `fly apps create <agent-app> && fly tokens create deploy --app <agent-app> --expiry 8760h`. In the dashboard, create a new app, then use its **Tokens** page → **Create deploy token**. Never paste an organization or personal token.
     - The **agent image** is the published `propr/agent:<version>` for this instance's version, pulled from Docker Hub, so nothing is built.
     - **Agent Machines at once** is 3 minus this app's Machines, so usually 2. The wizard counts them on the private network, or assumes the one a dashboard launch creates. Lower it if other apps in the organization have Machines too.

     Under **Advanced**, you can build your own image from `Dockerfile.agent` instead. Add a `FLY_API_TOKEN` Actions secret to the fork and run its **Build Fly agent image** workflow; the job summary shows the `registry.fly.io/<agent-app>@sha256:…` reference. An image in the agent app's own registry also lets ProPR [preinstall runtime packages](../architecture/agent-runtime.md#derived-fly-images) once. With the Docker Hub image, they install at each Machine start.
   - **Not yet:** the control plane starts without a runtime, and agent runs fail with a clear error until you add `SPRITES_TOKEN` or the `PROPR_FLY_*` settings as Fly secrets.
9. **Finish.** Idle shutdown stays off unless you tick it; on the ProPR App path, ticking it also registers the instance's `/wake` URL with Connect (see [Idle shutdown and wake](#idle-shutdown-and-wake)). The wizard closes for good and ProPR starts in the same Machine. Sign in, add a model provider in **Settings → Agents**, and label an issue `AI`.

> **Available from the release after v0.9.3.** The image pinned on `main` until then, `propr/app:0.9.3`, predates the dashboard launch. A Machine started from it does not crash-loop: it logs `fly-launch: this propr/app image has no scripts/fly-launch-entrypoint.sh, …` with the advice to set the Config path to `deploy/fly/source/fly.toml`, and stays stopped. Until the next release, use [Deploy your own changes](#deploy-your-own-changes) below.

### Deploy your own changes

To run a modified fork, a branch or a pull request, build the image from source instead. In **Launch an App → From GitHub** (or the app's GitHub deployment settings), pick the branch and set **Config path** to `deploy/fly/source/fly.toml`. That file is identical to the root `fly.toml` except that its `[build]` builds `docker/Dockerfile.app.prod` from the checkout: the Dockerfile path is written relative to the config's own directory, as `flyctl` resolves it, and the build context is the repository root. Expect a long first build on Fly's builder (more than 15 minutes); later builds reuse its cache when the builder still has it. Everything after the build, the setup code and the wizard, is the same.

The wizard uses ProPR's own look, with a small **on Fly.io** badge naming the instance's `<app>.fly.dev` host. The badge links to the app's Fly dashboard page. Like the ProPR Web UI, the wizard has a single light theme. The step bar shows done, current and upcoming steps. Every link that leaves the wizard opens in a new tab, and progress is kept on the volume. Each submit button is disabled at once and shows a spinner with what it is doing (**Checking…**, **Connecting…**, **Saving…**, **Starting…**), so a slow check cannot be sent twice. A failed check shows the same step again with the error. The wizard screens, in order:

![Setup code entry, the first step of the wizard](/img/screenshots/fly-launch/wizard-claim.png)

![The GitHub step: the ProPR App first and recommended, your own App as the advanced choice](/img/screenshots/fly-launch/wizard-github-choice.png)

![Advanced: creating your own GitHub App from a manifest with the instance's URLs](/img/screenshots/fly-launch/wizard-github-app.png)

![ProPR App path: registering the GitHub OAuth App browsers sign in with](/img/screenshots/fly-launch/wizard-signin-app.png)

![The agent runtime step: Sprites by default, with the token page and the scope to use](/img/screenshots/fly-launch/wizard-runtime.png)

![Fly Machines chosen: the agent app, its one-line create command, the published agent image and the computed Machines default](/img/screenshots/fly-launch/wizard-runtime-fly-machines.png)

![The last step: what the runtime check found, and optional idle shutdown](/img/screenshots/fly-launch/wizard-finish.png)

### What the instance keeps on the volume

Everything lives in `/usr/src/app/data/fly-launch/` (mode 0700; each file 0600). It survives restarts, deploys and idle stops.

| File | Contents |
| --- | --- |
| `secrets.json` | `SESSION_SECRET`, `SYSTEM_TASK_SECRET` and `MCP_ENCRYPTION_KEY`, generated once on first boot (the secrets `propr deploy fly` generates). Values are never logged. |
| `config.json` | What the wizard saved. ProPR App path: `GH_AUTH_MODE=relay`, the relay URL and token (`PROPR_GH_RELAY_URL`, `PROPR_GH_RELAY_TOKEN`), the installation (`GH_INSTALLATION_ID`), `GITHUB_EVENT_INTAKE_MODE=routing_websocket`, the relay token's label and id, and the sign-in OAuth App. Your own App: App ID, installation, webhook secret and OAuth client. Both: administrator, runtime tokens, idle shutdown. Never the GitHub sign-in used for enrollment (device flow or pasted). |
| `github-app.pem` | The GitHub App private key from the manifest flow (your own App only). |
| `setup.json` | The setup code hash and claim, until setup is done. |

A **Fly secret always wins** over a stored value, so you can override anything from the app's **Secrets** page in the dashboard, for example a rotated `SPRITES_TOKEN` or a relay token from `propr relay enroll`. An instance whose environment already has GitHub credentials (`GH_APP_ID`, a Connect relay token, or demo mode) never shows the wizard. Instances deployed with `propr deploy fly` are unaffected: they run the control plane directly and keep using their Fly secrets.

If you lose the browser session that claimed setup, run `fly ssh console -C "rm /usr/src/app/data/fly-launch/setup.json"`, restart the Machine and use the new code. Steps already completed stay done.

### Idle shutdown and wake

In a dashboard launch, ProPR and Redis share one container, so ProPR exiting stops the Machine: idle shutdown needs no Machine stop token. `fly.toml` restarts the Machine only on failure, keeps Fly's traffic-based autostop off and keeps `auto_start_machines` on, so a request (the UI, an MCP client or a GitHub webhook) starts a stopped Machine again. Idle shutdown is off unless you choose it in the last wizard step.

How events reach a stopped Machine depends on the GitHub path:

- **ProPR App path (Connect intake).** GitHub delivers to Connect, not to the Machine. Ticking idle shutdown registers `https://<app>.fly.dev/wake` as this relay token's Connect wake target (`PUT /v1/wake-target`); if Connect refuses it, Finish shows the error and you can retry or leave idle shutdown off. While the Machine is stopped, Connect keeps its deliveries (on the free tier the newest 25, for one hour; see [Idle shutdown](../operations/idle-shutdown.md)). When one arrives, Connect pings `/wake`, Fly's proxy starts the Machine, and the instance asks for the cached deliveries once it reconnects. Before stopping, the instance sends Connect the wake hint and stops only after Connect acknowledges it. A relay without idle wake support never acknowledges, so the Machine then stays up rather than miss events.
- **Your own App (direct webhooks).** A webhook starts the Machine through Fly's proxy. A cold start takes 15 to 20 seconds, and GitHub gives up on a webhook after 10 seconds without retrying it. The instance recovers the failed deliveries from the App's delivery history after it wakes. If you left it off, the idle shutdown control in Settings works as on any instance. If you turned it on in the wizard, that choice acts like environment configuration and wins over the Settings control; set the Fly secret `PROPR_IDLE_SHUTDOWN=off` to turn it off.

### Machine size

The launch configs start with a **512 MB** Machine and `swap_size_mb = 512`, so an always-on instance fits the Free Plan's $5 monthly credit: about $3.20 per month running 24/7, against about $5.70 at 1 GB. `propr deploy fly` keeps its 1 GB default.

Measured on the full stack (ProPR and Valkey in one container, MCP on, webhook intake), the container used about 380 MB at the boot peak, about 280 MB idle, and about 300 MB under heavy HTTP load (UI, API and MCP, about 1,000 concurrent requests) with the 512 MB cap, with no OOM kill or restart. Those measurements did not include repository clones, inline indexing or a live agent run. The swap absorbs short spikes from these, so they slow down rather than kill the Machine. Check **Metrics** in the app's dashboard after your first runs.

For large repositories, heavy indexing, or a Machine that keeps using swap, give it 1 GB:

```bash
fly scale memory 1024 --app <app>
```

Or open the app's **Scaling** page in the dashboard and pick 1 GB. The change restarts the Machine, and the volume keeps everything. A later deploy from the fork applies `fly.toml` again and goes back to 512 MB. To keep 1 GB, edit `memory` under `[[vm]]` in your fork's `fly.toml` (or in `deploy/fly/source/fly.toml`).

### Updates

Fly redeploys the app from the fork. Keep the fork current with GitHub's **Sync fork** button. If the app is connected with deploy-on-push (the dashboard's GitHub deployment settings), each sync deploys the new version; otherwise use **Deploy** in the dashboard. With the root `fly.toml`, a release changes only its pinned `propr/app:<version>` tag, so the deploy pulls the new image; with `deploy/fly/source/fly.toml` it rebuilds. The release's metadata pull request bumps the pinned tag on `main` before the release tag publishes that image, so if a deploy right after a release cannot pull the image, deploy again once the release's **Docker Images** run has finished. Database migrations run on boot, as on every other deploy. The wizard does not reappear and the volume keeps every secret and setting.

### Dashboard launch compared with `propr deploy fly`

| | Dashboard launch | `propr deploy fly` |
| --- | --- | --- |
| Needs | A browser, a GitHub fork | `flyctl`, the ProPR CLI, an environment file |
| Image | Released `propr/app:<version>` pinned in the root `fly.toml`; or built by Fly from the fork with `deploy/fly/source/fly.toml` | Released `propr/app` image, or `--image` |
| Machine layout | One container: ProPR plus Redis (Valkey) with the same persistence flags | Separate app and Redis containers in one Machine (plus optional tunnel or Docker) |
| Generated secrets | On first boot, stored on the volume | By the CLI, stored as Fly secrets |
| GitHub App | The shared ProPR App through ProPR Connect (default; relay token enrolled in the wizard), or your own App created with the manifest flow | ProPR Connect (relay token enrolled with your `propr login` token), or your own App from the env file |
| Browser sign-in | GitHub OAuth: the sign-in OAuth App you register (ProPR App path) or your own App's client | Connect through the hosted tunnel (`--tunnel-token`), or GitHub OAuth from the env file |
| Agent runtime | Sprites or Fly Machines, chosen and checked in the wizard | `--agent-runtime` and the env file; also legacy Docker |
| Idle shutdown | Off by default; wizard opt-in, no stop token needed; registers the Connect wake URL on the ProPR App path | Off by default; `--idle-shutdown` plus an app-scoped stop token |
| Machine memory | 512 MB plus 512 MB swap; `fly scale memory 1024` for more | 1 GB |
| Updates | Sync the fork; Fly redeploys | Rerun `propr deploy fly` |

Both use the same env, health check, volume, CPU and stop settings (the dashboard launch defaults to 512 MB plus swap, the CLI to 1 GB): the committed `fly.toml` and `deploy/fly/source/fly.toml` are generated from the CLI's builders (`npx tsx packages/cli/scripts/render-fly-launch-toml.ts`), and a test keeps them from drifting from the CLI and from each other (they differ only in `[build]`).

## Deploy the Machine

Install the ProPR CLI and sign in with `fly auth login`. Choose an available app name and a private environment file (mode 0600) with one literal `NAME=value` per line.

```bash
export APP=my-propr ORG=personal REGION=iad RUNTIME=sprites
export ENV_FILE=/absolute/private/path/fly.env
```

Set `PROPR_ADMIN_USERS` to your GitHub login or a comma-separated list of administrator logins, and `GITHUB_REPOS_TO_MONITOR` to the target owner/repository. For a small installation, use `WORKER_CONCURRENCY=1` and `PROPR_SPRITES_MAX=1`. The CLI generates a session secret and a system task secret on first deploy and keeps both on redeploys. On first start, the stored repository list is seeded once from `GITHUB_REPOS_TO_MONITOR`, so automations can use the repository straight away. Later changes in Settings, including removing every repository, are kept across restarts.

- **Your own GitHub App.** Add `GH_APP_ID`, `GH_INSTALLATION_ID`, `PROPR_GH_PRIVATE_KEY_B64` (single-line base64 PEM) and `GH_WEBHOOK_SECRET` to the file. For browser sign-in add `GH_OAUTH_CLIENT_ID` and `GH_OAUTH_CLIENT_SECRET`, with callback `https://<app>.fly.dev/api/auth/github/callback`. Install the App on the repository with [ProPR’s GitHub permissions](../operations/github-auth.md#create-your-own-app). Set its signed JSON webhook to `https://<app>.fly.dev/webhook` and subscribe to issue and pull request events. The CLI mounts the key at `/etc/propr/github-app.pem` and selects direct webhook intake.
- **ProPR Connect.** Install the shared ProPR App on the repository, sign in with `propr login` and pass the Connect tunnel flags when deploying. The CLI can enroll the relay token and configure browser sign-in and event delivery. [GitHub relay and Connect](../operations/deploy-fly.md#github-relay-and-connect)

For **Sprites**, set `SPRITES_TOKEN` for your organization. For **Fly Machines**, set `RUNTIME=fly-machines` in your shell and add the separate agent app name (`PROPR_FLY_APP`), its deploy token (`PROPR_FLY_API_TOKEN`) and the unified agent image digest (`PROPR_FLY_IMAGE`) to the file. On the Free Plan, also add `PROPR_FLY_MACHINES_MAX=2` (3 Machines minus the control plane; subtract other apps' Machines too). [Fly Machines runtime requirements](../architecture/agent-runtime.md#fly-machines)

Instance runtime packages (Settings → Agent runtime packages) are installed on each Sprite when it is provisioned, and changing the list replaces warm Sprites. On Fly Machines, the first run after the list changes builds a derived agent image with the packages installed: a short-lived `propr-build-*` Machine in the agent app runs `apt-get`, and the worker pushes the result to `registry.fly.io/<agent-app>:propr-packages-<hash>`. Every later run with the same list and agent image starts from that image's digest with nothing to install, on any worker; a changed list or a new `PROPR_FLY_IMAGE` builds a new one. `PROPR_FLY_API_TOKEN` therefore needs push access to the agent app's repository. If the image cannot be built, the run installs the packages at Machine start instead. Package names are checked against the agent image's Debian package index when the list is saved, and again before a derived image build, a fallback start-time install and a new Sprite, so a misspelled name is refused without starting a Machine or Sprite. A derived image or warm Sprite already built with the list keeps being used even if the archive later drops a name or pinned version. Old `propr-packages-*` tags are not deleted automatically. [Derived Fly images](../architecture/agent-runtime.md#derived-fly-images) For tools a single repository needs, install them in `.propr/setup.sh` instead, which runs before every run on both runtimes. [Runtime packages per runtime](../architecture/agent-runtime.md#runtime-packages)

For headless Claude, optionally add `CLAUDE_SETTINGS_B64` to the file. Use single-line base64 of a settings JSON containing an `env` object with a dedicated `ANTHROPIC_API_KEY`.

```bash
propr deploy fly --app "$APP" --org "$ORG" --region "$REGION" \
  --agent-runtime "$RUNTIME" --env-file "$ENV_FILE"
```

The CLI uses its launcher manifest’s app image. When testing an unreleased checkout, pass `--image` with a published control-plane image built from that checkout.

Idle shutdown is **off by default**. Add `--idle-shutdown 15m` to opt in. The flyctl backend creates an app-scoped stop token. With the Machines API backend, supply an app-scoped token using `--machine-stop-token`. Direct webhooks wake the Machine, and ProPR requests redelivery from the GitHub App’s delivery history after a cold start. Polling keeps the Machine awake. Connect idle shutdown requires a relay that acknowledges the wake hint and replays events after reconnect. [Idle shutdown and wake](../operations/idle-shutdown.md#how-it-wakes)

### Install headless Claude credentials

If you supplied `CLAUDE_SETTINGS_B64`, run this after deployment for the Claude agent with ID `claude`. It writes the settings to the managed credential directory on the mounted volume, where they survive idle stops and restarts. The SSH command prints the installed file’s byte count. Run it again after rotating the secret.

```bash title="Install headless Claude settings"
setup=$(base64 <<'JS' | tr -d '\n'
import { chmod, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { getManagedAgentConfigPath, getManagedAgentConfigRelativePath } from '@propr/shared';

const config = getManagedAgentConfigPath('claude', 'claude');
const dir = join(process.env.PROPR_MANAGED_CREDENTIALS_DIR, getManagedAgentConfigRelativePath(config));
const settings = Buffer.from(process.env.CLAUDE_SETTINGS_B64 || '', 'base64');
if (!settings.length) throw new Error('CLAUDE_SETTINGS_B64 decoded to empty settings');

await mkdir(dir, { recursive: true, mode: 0o700 });
await chmod(dir, 0o700);
const file = join(dir, 'settings.json');
const temp = join(dir, `.settings-${randomUUID()}`);
try {
  await writeFile(temp, settings, { flag: 'wx', mode: 0o600 });
  await rename(temp, file);
} finally {
  await rm(temp, { force: true });
}
const { size } = await stat(file);
if (!size) throw new Error('Installed Claude settings.json is empty');
console.log(size);
JS
)
flyctl ssh console --app "$APP" --container app -C "sh -c 'cd /usr/src/app && echo $setup | base64 -d | node --input-type=module'"
```

### Verify an issue run

1. Confirm that `https://<app>.fly.dev/health` returns HTTP 200.
2. Configure at least one agent. In **Settings → Agents**, add an agent, choose its alias and default model, sign in to the provider and enable the agent. For headless Claude setup with `CLAUDE_SETTINGS_B64`, use the MCP tool `create_agent_configuration` with agent ID `claude` to use the settings installed on the volume. Set an alias, supported models and a default model you can access. New MCP configurations start disabled, so call `update_agent_configuration` with `enabled: true`.
3. Apply `llm-<alias>` to a small issue to select that agent’s default model (for example, `llm-claude` for alias `claude`), then add the `AI` trigger label. Check that its PR contains the requested edit and that the task’s compute usage names the selected runtime.

To check idle wake, close the UI, wait until `fly machine list --app "$APP"` shows `stopped`, then apply the same labels to another issue. Use Fly’s Machine list to observe the transition to `started`. Visiting the instance yourself would also wake it.

When tearing down an installation with idle shutdown enabled, find the ID of the stop token (named `propr idle stop` when created by the CLI) with `fly tokens list --app "$APP"` and run `fly tokens revoke <id>` before destroying the app. The deploy token stays active after app deletion.

### Extensions on Fly runtimes

Agents on Sprites and Fly Machines get these extensions:

| What the agent gets | Sprites | Fly Machines |
| --- | --- | --- |
| Skills, commands, agents and instruction files in the provider config directory | Yes | Yes |
| Repository skills, `AGENTS.md` and `CLAUDE.md` | Yes | Yes |
| Library skill bundles | Yes | Yes |
| Library URL MCP servers | Yes, through the ProPR extension gateway (over the SSH reverse forward without a public URL) | Yes, through the ProPR extension gateway |
| Library package (stdio) MCP servers | Yes, installed while the Sprite is provisioned | Yes, installed at Machine start |
| Operator catalog stdio servers | No | No |
| ProPR MCP | Yes, at the reachable URL or over the SSH reverse forward | Yes, at the reachable URL |

Package servers are installed inside the Sprite or Machine from the worker's verified install, with `npm ci` and no lifecycle scripts, so the Sprite or Machine must reach the npm registry. A Sprite is provisioned with the run's package servers before its clean checkpoint. Warm Sprites are kept per package-server set: a run reuses one built for its set, and at `PROPR_SPRITES_MAX` the least recently used idle Sprite built for another set is deleted to make room. A Fly Machine installs them before the agent starts, within 10 minutes. A failed install fails the run with the end of npm's output. Runs report the install time as `packageServerInstallMs` in compute usage.

An auto-applied operator catalog stdio server is dropped from a Fly run. The task timeline and the issue or pull request comment name the dropped server. A run that adds one explicitly is refused with an error naming the server. To use them, run that agent on Docker. See [Extensions by runtime](../architecture/agent-runtime.md#extensions-by-runtime).

## Who can access the work

You control the Fly organization, volume, GitHub installation and model credentials. Fly hosts the repository contents and credentials needed during a run. A cloud agent receives a scoped workspace clone and per-run provider credentials. The worker retrieves the result, handles credential refresh and publishes the PR. Sprites restore a clean checkpoint between leases. Fly Machines are destroyed after result collection. Limit GitHub installation access to intended repositories, use separate agent and control-plane tokens, and treat users who can trigger tasks as able to run code on your account. ProPR Connect can relay events and wake requests. It does not supply the agent compute.

## Nightly smoke fixture

The **Fly end-to-end smoke** GitHub Actions workflow runs on manual dispatch by default. To enable the nightly run at 04:17 UTC, set the repository variable `FLY_E2E_NIGHTLY` to `true`. Each run consumes Fly and model usage and opens an issue and a PR in the fixture repository. On the Free plan, it shares the organization’s three Machine slots and three Sprite slots with other workloads. Use a dedicated Fly organization and a disposable, initialized GitHub repository with `AI` and `llm-claude` labels, no other ProPR worker and no unrelated traffic. Set repository variables `FLY_E2E_ORG` and `FLY_E2E_REPO` (owner/name). Configure these Actions secrets:

| Secret | Fixture access |
| --- | --- |
| `FLY_E2E_TOKEN` | Fly organization token from `fly tokens create org -o <test-org>`. The workflow derives a Machine stop token locally, scoped to the disposable app and valid for at most two hours. |
| `FLY_E2E_SPRITES_TOKEN` | Test Sprites org access to create, run and delete Sprites. Not needed for a `fly-machines` run without the extensions check; with it, that run hosts its OAuth fixture on a Sprite. |
| `FLY_E2E_GITHUB_TOKEN` | Fine-grained fixture repository PAT with read and write access to Issues and Pull requests. No Contents access is required. The fixture App reads the generated file and deletes test branches. |
| `FLY_E2E_APP_ENV` | Private environment file containing `PROPR_ADMIN_USERS` (fixture administrator’s GitHub login), `GH_APP_ID`, `GH_INSTALLATION_ID`, `PROPR_GH_PRIVATE_KEY_B64` and `CLAUDE_SETTINGS_B64` containing the test account’s API-key settings described above |
| `FLY_E2E_GH_OAUTH_CLIENT_ID` | The fixture GitHub App’s client ID. The workflow writes it to the env file as `GH_OAUTH_CLIENT_ID` so `propr deploy fly` has a browser sign-in method. |
| `FLY_E2E_GH_OAUTH_CLIENT_SECRET` | A client secret generated in the fixture App’s settings, written as `GH_OAUTH_CLIENT_SECRET`. CI never signs in through the browser, so the App’s callback URL can stay a placeholder. |

Install a dedicated fixture GitHub App with access to read the issue and write the branch and PR. In the App registration, select **Webhook → Active**, set the placeholder URL to `https://example.invalid/webhook` and save. Under **Permissions & events → Subscribe to events**, select **Issues** and **Pull request** and save. Complete this once before running the workflow. [GitHub App registration settings](https://docs.github.com/en/apps/maintaining-github-apps/modifying-a-github-app-registration)

The nightly run uses Sprites. A manual dispatch can set the `agent_runtime` input to `fly-machines` instead. That run also creates a disposable agent app, builds and pushes `Dockerfile.agent` to it, and gives the control plane a deploy token scoped to that app.

Each run points the App webhook at the disposable Machine and sets a fresh signing secret. Before idle shutdown, it configures the runtime package `figlet`, which the agent image lacks, the same way Settings applies a package list, and records the list’s digest. The fixture issue asks for a file whose first line is the app name and whose second line is the output of `figlet -v | head -1`. After confirming delivery of the new fixture issue, the workflow waits for idle shutdown and adds the `AI` label. It reports the wake record’s redelivery count and verifies the linked PR, the figlet banner on the file’s second line, and the install log after the stop with the same digest (`Installed agent runtime packages on Sprite`, or `… at Fly Machine start` for Fly Machines). It prints that log’s `packagesDigest`, `packageCount` and `installMs`, and checks for a successful execution on the selected `compute_runtime`. Teardown restores the placeholder URL, closes the fixture issue and PR, and deletes the temporary compute, including the agent app.

### Extension Library check

Dispatch the workflow with the **extensions** input checked to also verify Extension Library items on the remote runtime. For nightly runs, set the repository variable `FLY_E2E_NIGHTLY_EXTENSIONS` to `true`. The check runs on the selected `agent_runtime` (Sprites or Fly Machines).

Before the idle stop, the workflow adds the `FLY_E2E_GITHUB_TOKEN` user to `PROPR_ADMIN_USERS`, claims the administrator role and calls the same API as **Settings → Extensions**. It adds six items, each auto-applied to issue tasks in the fixture repository:

- a skill bundle with one `SKILL.md` that gives a token unique to the run;
- the package MCP server `@modelcontextprotocol/server-everything` 2.3.1, pinned in the workflow by version and integrity value. The run fails if the registry resolves another integrity value. The agent calls its `echo` tool;
- four URL MCP servers, called through the ProPR extension gateway (over the SSH reverse forward on Sprites):

| Server | Endpoint | Session | Authentication |
| --- | --- | --- | --- |
| `url-stateful` | `https://mcptest.io/fixtures/echo/mcp` (tool `echo`, argument `message`) | stateful | none |
| `url-stateless` | `https://mcp.deepwiki.com/mcp` (tool `read_wiki_structure`) | stateless | none |
| `url-bearer` | `https://mcptest.io/fixtures/auth-bearer/mcp` (tool `echo`) | stateful | Bearer: the fixture's published token |
| `url-oauth` | a disposable OAuth server on a Fly Machine (Sprites runs) or a Sprite (Fly Machines runs) (tool `echo`) | stateful | OAuth |

The OAuth server is `.github/fly-e2e/oauth-mcp-fixture.mjs`: a minimal OAuth 2.1 authorization server and MCP endpoint with protected resource metadata, dynamic registration, PKCE, an auto-approving consent, rotating refresh tokens, 90-second access tokens (so Core refreshes them during the run) and `Mcp-Session-Id` sessions. The Free plan allows three Sprites and three Machines per organization, so the fixture runs in the pool the run's agents don't use. On a Sprites run it is a single Fly Machine (`node:22-slim` with the fixture file) in its own disposable app `propr-e2e-oauth-<run>`, reached at `https://propr-e2e-oauth-<run>.fly.dev` through the Fly proxy; with the control plane that is two of the three Machines, and the app never auto-stops, so its OAuth state lasts the run. On a Fly Machines run it is a service on a Sprite of the same name with a public URL, leaving the Machines to the agents. Either way the workflow uses the same fixture and URL checks, the step summary names the host, and a teardown step destroys the app or deletes the Sprite whatever failed. Its `/stats` endpoint reports counters only.

The Bearer server is saved with a wrong token first, and **Test connections** must report it not reachable within a minute; the workflow then stores the published token. The workflow signs in to `url-oauth` without a browser through the Settings API: **Check sign-in** (`/oauth/check`), **Connect** (`/oauth/start`), the fixture's consent redirect and ProPR's callback, in one cookie session. A final **Test connections** must report each URL server reachable with the session mode and authentication in the table. A Sprites or Fly Machines run checks the same four.

In this mode the fixture issue asks for an eight-line file: the app name, the `figlet` banner, the skill token, the package server's `echo` output (`Echo: MCP-OK-<run>`), the stateful echo (`URL-STATEFUL-OK-<run>`), `URL-STATELESS-OK-<run>` when the DeepWiki call returned a non-empty result, the Bearer echo (`URL-BEARER-OK-<run>`) and the OAuth echo (`URL-OAUTH-OK-<run>`). The verify step checks all eight lines. It also finds the `Extension Library items applied to this run` log record with `skills` and `packageServers` of at least 1 and `urlServers=4`, and the matching `Installed package MCP servers on Sprite` record (`… at Fly Machine start` on Fly Machines). For the URL servers it requires an `Opened extension URL MCP upstream session` record per server with the expected session mode and authentication, a `Closed extension URL MCP upstream session` record per server with at least one tool call (and the `DELETE` sent for stateful sessions), and fixture statistics showing at least one token refresh, the OAuth echo and a deleted session. The step summary shows `extensionDigest`, `packageServersDigest`, the install time and a table of each URL server's session mode, authentication, tool calls and token refreshes.
