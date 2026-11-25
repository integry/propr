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

On the **personal Free plan**, adding a card gives $5 monthly usage, up to three Machines, three Sprites and 5 GB per volume. Count stopped Machines too when planning capacity, to be safe. One control plane leaves at most two Machine slots for agents. Set worker concurrency accordingly or set `PROPR_SPRITES_MAX=1` to start with one Sprite. Exhausting the $5 automatically switches the organization to Pay As You Go and bills the **whole month from the first cent**. A manual upgrade has the same billing effect. Check Billing for other workloads sharing that allowance. [Fly Free plan](https://docs.fly.io/about/free-plan)

## Deploy the Machine

Use a checkout containing both the remote runtime and its control-plane image. The `propr deploy fly` command doesn’t support remote runtimes yet. Use the source recipe below to generate the Machine configuration. From the checkout root, install Node 22 dependencies with `npm ci`, sign in with `fly auth login`, and choose an available app name.

```bash
export APP=my-propr ORG=personal REGION=iad RUNTIME=sprites
export REPO=your-org/your-repo
export IMAGE=registry.fly.io/$APP/control-plane:remote-runtime
export ENV_FILE=/absolute/private/path/fly.env OUT=$(mktemp -d)
fly apps create "$APP" --org "$ORG"
fly auth docker
docker build --platform linux/amd64 -f docker/Dockerfile.app.prod -t "$IMAGE" .
docker push "$IMAGE"
```

Create the private environment file (mode 0600), one literal `NAME=value` per line. Include a random `SESSION_SECRET` and `PROPR_ADMIN_USERS=<your-github-login>`. Replace the placeholder with your GitHub login, or a comma-separated list of logins. On first boot the API requires an instance administrator before it can pass its health check.

Choose how the instance receives GitHub events before rendering the configuration.

- **Your own GitHub App** (default). Add `GH_APP_ID`, `GH_INSTALLATION_ID`, `PROPR_GH_PRIVATE_KEY_B64` (base64 PEM) and `GH_WEBHOOK_SECRET` to the private file. For browser login add `GH_OAUTH_CLIENT_ID` and `GH_OAUTH_CLIENT_SECRET`, with callback `https://<app>.fly.dev/api/auth/github/callback`. Install the App on the target repository with [ProPR’s GitHub permissions](../operations/github-auth.md#create-your-own-app). Set its signed JSON webhook to `https://<app>.fly.dev/webhook` and subscribe to issue and pull request events.
- **ProPR Connect relay**. Install the shared ProPR App on the repository and enroll with `propr relay enroll`. Run `export GH_AUTH_MODE=relay` in the shell that renders the config. Add `PROPR_GH_RELAY_URL=https://webhook.propr.dev/v1`, your `PROPR_GH_RELAY_TOKEN` and the shared App’s `GH_INSTALLATION_ID` to the private file. The recipe selects `routing_websocket` for event delivery. This path needs neither a private App key nor a public webhook.

Supply the credentials for your chosen agent runtime.

- **Sprites** needs `SPRITES_TOKEN` for your organization.
- **Fly Machines** needs `RUNTIME=fly-machines`, a separate agent app in `PROPR_FLY_APP`, its app-scoped deploy token in `PROPR_FLY_API_TOKEN` and its published unified agent image digest in `PROPR_FLY_IMAGE`. See [image build and runtime capabilities](../architecture/agent-runtime.md#fly-machines).

Idle shutdown is **off by default**. To opt in, export `IDLE_AFTER=15m` and add an app-scoped token from `fly tokens create deploy --app "$APP" --name "$APP-stop"` to the private file as `PROPR_FLY_MACHINE_STOP_TOKEN`. Fly proxy autostart wakes the Machine on the next webhook. Polling intake keeps the instance awake. With Connect intake, the relay must acknowledge the wake hint, ping the public `/wake` endpoint on delivery and replay the event after reconnect. Until the relay supports this handshake, the instance stays up. [Idle shutdown and wake](../operations/idle-shutdown.md#the-wake-hint)

Generate the two Fly config files. Only secret names go into them. The optional headless setup maps a Fly secret to Claude Code’s settings file. Encode a settings JSON containing an `env` object with a dedicated `ANTHROPIC_API_KEY` as single-line base64.

```bash title="Render Machine configuration"
node --import tsx --input-type=module <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FLY_DEFAULTS, renderFlyToml, renderFlyMachineConfigJson } from './packages/cli/src/commands/deploy/flyMachineConfig.ts';
const { APP, ORG, REGION, IMAGE, REPO, RUNTIME, OUT, ENV_FILE, IDLE_AFTER } = process.env;
const relay = process.env.GH_AUTH_MODE === 'relay';
const names = readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)
  .map(line => /^([A-Z_][A-Z0-9_]*)=/.exec(line)?.[1]).filter(Boolean);
const plan = {
  ...FLY_DEFAULTS, app: APP, org: ORG, region: REGION, agentRuntime: RUNTIME,
  images: { app: IMAGE, redis: 'redis:7-alpine' }, githubAppKey: !relay,
  legacyDocker: false, idleShutdownAfter: IDLE_AFTER, secretNames: names,
  extraEnv: {
    GH_AUTH_MODE: relay ? 'relay' : 'app',
    GITHUB_EVENT_INTAKE_MODE: relay ? 'routing_websocket' : 'direct_webhook',
    GITHUB_REPOS_TO_MONITOR: REPO, PROPR_INSTANCE_ID: APP,
    WORKER_CONCURRENCY: '1', PROPR_SPRITES_MAX: '1',
    PROPR_MANAGED_CREDENTIALS_DIR: '/usr/src/app/data/agent-credentials',
  },
};
const config = JSON.parse(renderFlyMachineConfigJson(plan));
if (names.includes('CLAUDE_SETTINGS_B64')) {
  const app = config.containers.find(c => c.name === 'app');
  (app.files ??= []).push({
    guest_path: plan.extraEnv.PROPR_MANAGED_CREDENTIALS_DIR + '/claude/.claude/settings.json',
    secret_name: 'CLAUDE_SETTINGS_B64', mode: 0o600,
  });
}
const path = resolve(OUT, 'propr-machine.json');
writeFileSync(path, JSON.stringify(config, null, 2));
writeFileSync(resolve(OUT, 'fly.toml'), renderFlyToml(plan, path));
JS
```

```bash
fly secrets import --stage --app "$APP" < "$ENV_FILE"
fly ips allocate-v4 --shared --app "$APP"
fly ips allocate-v6 --app "$APP"
fly volumes create propr_data --size 1 --region "$REGION" --app "$APP" --yes
fly deploy --app "$APP" --config "$OUT/fly.toml" --image "$IMAGE" --ha=false
```

### Verify an issue run

1. Confirm that `https://<app>.fly.dev/health` returns HTTP 200.
2. Configure at least one agent. In **Settings → Agents**, add an agent, choose its alias and default model, sign in to the provider and enable the agent. For headless Claude setup with `CLAUDE_SETTINGS_B64`, use the MCP tool `create_agent_configuration` with agent ID `claude` so its managed credential directory matches the mounted settings file. Set an alias, supported models and a default model you can access. New MCP configurations start disabled, so call `update_agent_configuration` with `enabled: true`.
3. Apply `llm-<alias>` to a small issue to select that agent’s default model (for example, `llm-claude` for alias `claude`), then add the `AI` trigger label. Check that its PR contains the requested edit and that the task’s compute usage names the selected runtime.

To check idle wake, close the UI, wait until `fly machine list --app "$APP"` shows `stopped`, then apply the same labels to another issue. Use Fly’s Machine list to observe the transition to `started`. Visiting the instance yourself would also wake it.

When tearing down an installation with idle shutdown enabled, find the ID of `$APP-stop` with `fly tokens list --app "$APP"` and run `fly tokens revoke <id>` before destroying the app. The deploy token stays active after app deletion.

## Who can access the work

You control the Fly organization, volume, GitHub installation and model credentials. Fly hosts the repository contents and credentials needed during a run. A cloud agent receives a scoped workspace clone and per-run provider credentials. The worker retrieves the result, handles credential refresh and publishes the PR. Sprites restore a clean checkpoint between leases. Fly Machines are destroyed after result collection. Limit GitHub installation access to intended repositories, use separate agent and control-plane tokens, and treat users who can trigger tasks as able to run code on your account. ProPR Connect can relay events and wake requests. It does not supply the agent compute.

## Nightly smoke fixture

The **Fly end-to-end smoke** GitHub Actions workflow runs on manual dispatch by default. To enable the nightly run at 04:17 UTC, set the repository variable `FLY_E2E_NIGHTLY` to `true`. Each run consumes Fly and model usage and opens an issue and a PR in the fixture repository. On the Free plan, it shares the organization’s three Machine slots and three Sprite slots with other workloads. Use a dedicated Fly organization and a disposable, initialized GitHub repository with `AI` and `llm-claude` labels, no other ProPR worker and no unrelated traffic. Set repository variables `FLY_E2E_ORG` and `FLY_E2E_REPO` (owner/name). Configure these Actions secrets:

| Secret | Fixture access |
| --- | --- |
| `FLY_E2E_TOKEN` | Fly organization token from `fly tokens create org -o <test-org>`. The workflow derives a Machine stop token locally, scoped to the disposable app and valid for at most two hours. |
| `FLY_E2E_SPRITES_TOKEN` | Test Sprites org access to create, run and delete Sprites |
| `FLY_E2E_GITHUB_TOKEN` | Fixture repository access to manage webhooks, issues, PRs and test branches |
| `FLY_E2E_APP_ENV` | Private environment file containing `PROPR_ADMIN_USERS` (fixture administrator’s GitHub login), `GH_APP_ID`, `GH_INSTALLATION_ID`, `PROPR_GH_PRIVATE_KEY_B64` and `CLAUDE_SETTINGS_B64` containing the test account’s API-key settings described above |

The test creates a signed repository webhook for its temporary URL. The installed test GitHub App needs access to read the issue and write the branch and PR. The workflow waits for natural idle shutdown, labels a fresh issue, observes wake and checks the linked PR and recorded execution runtime. Teardown removes the test hook, closes the issue and PR, and deletes the temporary compute.
