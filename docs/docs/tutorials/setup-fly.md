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

Install the ProPR CLI and sign in with `fly auth login`. Choose an available app name and a private environment file (mode 0600) with one literal `NAME=value` per line.

```bash
export APP=my-propr ORG=personal REGION=iad RUNTIME=sprites
export ENV_FILE=/absolute/private/path/fly.env
```

Set `PROPR_ADMIN_USERS` to your GitHub login or a comma-separated list of administrator logins, and `GITHUB_REPOS_TO_MONITOR` to the target owner/repository. For a small installation, use `WORKER_CONCURRENCY=1` and `PROPR_SPRITES_MAX=1`. The CLI generates a session secret on first deploy.

- **Your own GitHub App.** Add `GH_APP_ID`, `GH_INSTALLATION_ID`, `PROPR_GH_PRIVATE_KEY_B64` (single-line base64 PEM) and `GH_WEBHOOK_SECRET` to the file. For browser sign-in add `GH_OAUTH_CLIENT_ID` and `GH_OAUTH_CLIENT_SECRET`, with callback `https://<app>.fly.dev/api/auth/github/callback`. Install the App on the repository with [ProPR’s GitHub permissions](../operations/github-auth.md#create-your-own-app). Set its signed JSON webhook to `https://<app>.fly.dev/webhook` and subscribe to issue and pull request events. The CLI mounts the key at `/etc/propr/github-app.pem` and selects direct webhook intake.
- **ProPR Connect.** Install the shared ProPR App on the repository, sign in with `propr login` and pass the Connect tunnel flags when deploying. The CLI can enroll the relay token and configure browser sign-in and event delivery. [GitHub relay and Connect](../operations/deploy-fly.md#github-relay-and-connect)

For **Sprites**, set `SPRITES_TOKEN` for your organization. For **Fly Machines**, set `RUNTIME=fly-machines` in your shell and add the separate agent app name (`PROPR_FLY_APP`), its deploy token (`PROPR_FLY_API_TOKEN`) and the unified agent image digest (`PROPR_FLY_IMAGE`) to the file. [Fly Machines runtime requirements](../architecture/agent-runtime.md#fly-machines)

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
| Library URL MCP servers | Yes, through the ProPR extension gateway | Yes, through the ProPR extension gateway |
| Library package (stdio) MCP servers | Yes, installed while the Sprite is provisioned | Yes, installed at Machine start |
| Operator catalog stdio servers | No | No |
| ProPR MCP | Yes, at the reachable URL | Yes, at the reachable URL |

Package servers are installed inside the Sprite or Machine from the worker's verified install, with `npm ci` and no lifecycle scripts, so the Sprite or Machine must reach the npm registry. A Sprite is provisioned with the run's package servers before its clean checkpoint. Warm Sprites are kept per package-server set: a run reuses one built for its set, and at `PROPR_SPRITES_MAX` the least recently used idle Sprite built for another set is deleted to make room. A Fly Machine installs them before the agent starts, within 10 minutes. A failed install fails the run with the end of npm's output. Runs report the install time as `packageServerInstallMs` in compute usage.

An auto-applied operator catalog stdio server is dropped from a Fly run. The task timeline and the issue or pull request comment name the dropped server. A run that adds one explicitly is refused with an error naming the server. To use them, run that agent on Docker. See [Extensions by runtime](../architecture/agent-runtime.md#extensions-by-runtime).

## Who can access the work

You control the Fly organization, volume, GitHub installation and model credentials. Fly hosts the repository contents and credentials needed during a run. A cloud agent receives a scoped workspace clone and per-run provider credentials. The worker retrieves the result, handles credential refresh and publishes the PR. Sprites restore a clean checkpoint between leases. Fly Machines are destroyed after result collection. Limit GitHub installation access to intended repositories, use separate agent and control-plane tokens, and treat users who can trigger tasks as able to run code on your account. ProPR Connect can relay events and wake requests. It does not supply the agent compute.

## Nightly smoke fixture

The **Fly end-to-end smoke** GitHub Actions workflow runs on manual dispatch by default. To enable the nightly run at 04:17 UTC, set the repository variable `FLY_E2E_NIGHTLY` to `true`. Each run consumes Fly and model usage and opens an issue and a PR in the fixture repository. On the Free plan, it shares the organization’s three Machine slots and three Sprite slots with other workloads. Use a dedicated Fly organization and a disposable, initialized GitHub repository with `AI` and `llm-claude` labels, no other ProPR worker and no unrelated traffic. Set repository variables `FLY_E2E_ORG` and `FLY_E2E_REPO` (owner/name). Configure these Actions secrets:

| Secret | Fixture access |
| --- | --- |
| `FLY_E2E_TOKEN` | Fly organization token from `fly tokens create org -o <test-org>`. The workflow derives a Machine stop token locally, scoped to the disposable app and valid for at most two hours. |
| `FLY_E2E_SPRITES_TOKEN` | Test Sprites org access to create, run and delete Sprites |
| `FLY_E2E_GITHUB_TOKEN` | Fine-grained fixture repository PAT with read and write access to Issues and Pull requests. No Contents access is required. The fixture App reads the generated file and deletes test branches. |
| `FLY_E2E_APP_ENV` | Private environment file containing `PROPR_ADMIN_USERS` (fixture administrator’s GitHub login), `GH_APP_ID`, `GH_INSTALLATION_ID`, `PROPR_GH_PRIVATE_KEY_B64` and `CLAUDE_SETTINGS_B64` containing the test account’s API-key settings described above |
| `FLY_E2E_GH_OAUTH_CLIENT_ID` | The fixture GitHub App’s client ID. The workflow writes it to the env file as `GH_OAUTH_CLIENT_ID` so `propr deploy fly` has a browser sign-in method. |
| `FLY_E2E_GH_OAUTH_CLIENT_SECRET` | A client secret generated in the fixture App’s settings, written as `GH_OAUTH_CLIENT_SECRET`. CI never signs in through the browser, so the App’s callback URL can stay a placeholder. |

Install a dedicated fixture GitHub App with access to read the issue and write the branch and PR. In the App registration, select **Webhook → Active**, set the placeholder URL to `https://example.invalid/webhook` and save. Under **Permissions & events → Subscribe to events**, select **Issues** and **Pull request** and save. Complete this once before running the workflow. [GitHub App registration settings](https://docs.github.com/en/apps/maintaining-github-apps/modifying-a-github-app-registration)

Each run points the App webhook at the disposable Machine and sets a fresh signing secret. After confirming delivery of the new fixture issue, the workflow waits for idle shutdown and adds the `AI` label. It reports the wake record’s redelivery count and verifies the linked PR and its Sprites execution. Teardown restores the placeholder URL, closes the fixture issue and PR, and deletes the temporary compute.

### Extension Library check

Dispatch the workflow with the **extensions** input checked to also verify Extension Library items on the remote runtime. For nightly runs, set the repository variable `FLY_E2E_NIGHTLY_EXTENSIONS` to `true`. The check runs on Sprites only for now.

Before the idle stop, the workflow adds the `FLY_E2E_GITHUB_TOKEN` user to `PROPR_ADMIN_USERS`, claims the administrator role and calls the same API as **Settings → Extensions**. It adds two items, each auto-applied to issue tasks in the fixture repository:

- a skill bundle with one `SKILL.md` that gives a token unique to the run;
- the package MCP server `@modelcontextprotocol/server-everything` 2.3.1, pinned in the workflow by version and integrity value. The run fails if the registry resolves another integrity value. The agent calls its `echo` tool.

The fixture has no URL MCP server of its own, so none is added. The step summary says so.

The fixture issue asks for a three-line file: the app name, the skill token and the `echo` output (`Echo: MCP-OK-<run>`). The verify step checks all three lines. It also finds the `Extension Library items applied to this run` log record with `skills` and `packageServers` of at least 1, and the matching `Installed package MCP servers on Sprite` record. The step summary shows `extensionDigest`, `packageServersDigest` and the install time.
