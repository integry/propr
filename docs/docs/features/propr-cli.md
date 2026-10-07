---
sidebar_position: 12
---

# ProPR CLI

The ProPR CLI (`propr`, npm package [`propr-cli`](https://www.npmjs.com/package/propr-cli)) is both the **control plane for a local ProPR stack** (scaffold, verify, start, stop — no hand-written `docker run`) and a **client for a running backend** (plans, issue implementation, goals, tasks, repositories, agents, to-dos, settings, logs). Backend commands talk to the same API as the Web UI, so everything shows up in the dashboard and follows the normal review path.

This page documents the end-user CLI. For developing or operating ProPR itself from a source checkout (compose stacks, image builds), see [CLI Workflows](./cli-workflows.md).

## Installation

```bash
npm install -g propr-cli
```

The host CLI is validated on **Node.js 22 and 24** (the Docker launcher image is separate and unaffected). The published package engine minimum remains Node.js `>=22`. The package is published at [npmjs.com/package/propr-cli](https://www.npmjs.com/package/propr-cli); the installed command is `propr`.

Linux `amd64` is the native, recommended production path. The CLI and launcher have also been exercised successfully on Apple Silicon macOS through Docker Desktop running the published Linux `amd64` images under emulation; native `arm64` images are not yet available. See [System Requirements](../tutorials/setup.md#system-requirements) for the full host contract.

## Local Stack Control Plane

Bring up a complete ProPR stack from the terminal:

```bash
propr setup              # guided one-time bootstrap: scaffold, verify, configure, start (re-runnable)
propr init stack         # scaffold .env + data/ logs/ repos/, detect agent credentials
propr check              # verify Docker, images, agents, and GitHub auth mode (--verify probes App access and smoke-tests agents)
propr images pull        # pull missing or stale images without starting the stack
propr start              # pull images and start the stack with a live dashboard
propr status             # local stack status (--json for scripts)
propr ui on|off          # start or stop the Web UI service (http://localhost:5173)
propr docs on|off        # start or stop the bundled docs service
propr stop               # stop the stack (--keep to stop without removing containers)
propr tunnel on          # expose the stack to the hosted UI through a Cloudflare Tunnel
propr tunnel off         # stop the tunnel (token and env values are kept)
```

`propr setup` is the recommended way to bring up a local stack — see the [Local Setup](../tutorials/setup-local.md) and [Server Setup](../tutorials/setup-server.md) tutorials. The `init stack` / `check` / `start` commands below are the individual steps it orchestrates, available for scripting, CI, and troubleshooting.

### `propr setup`

A guided, interactive wizard that performs a complete one-time bootstrap of the local stack. In one pass it runs environment checks, scaffolds the stack root, pulls images, records detected agent credentials, helps you choose a [GitHub auth mode](../operations/github-auth.md) and issue intake (App/relay events, polling, or direct webhooks), starts the services, configures the GitHub user whitelist, and optionally adds a first repository and opens the Web UI.

Setup is **safe to re-run at any time**: it re-discovers your environment and skips steps that are already satisfied, so running it again only fills in what is missing. It never overwrites `.env` wholesale (edits are applied per key and never blank an existing value), reuses a running stack instead of recreating it, and never deletes data.

| Option | Description |
|--------|-------------|
| `--root <dir>` | Stack root directory where `.env`, `data/`, `logs/`, and `repos/` live (default: current directory) |
| `--no-tui` | Skip the full-screen wizard and prompt line-by-line instead (use over SSH or in shells without raw-mode support) |
| `--install-skill <targets>` | Install the ProPR Operator Agent Skill for comma-separated explicit targets |
| `--no-skill` | Do not offer Agent Skill installation |
| `--skip-remote-image-check` | Skip the slow registry round-trip that checks whether stack images already exist |

The full-screen wizard requires an interactive terminal. Over SSH or in shells without raw-mode support, setup falls back to line-by-line prompts automatically (or pass `--no-tui`). When stdin is not a terminal at all (piped, redirected, CI), setup cannot prompt and exits with guidance — scaffold non-interactively with `propr init stack`, edit `<root>/.env`, then run `propr start`.

- `propr init stack [--root <dir>]` creates `data/`, `logs/`, `repos/`, writes `.env` from the bundled template, and auto-detects agent credential directories on the host (`~/.claude`, `~/.codex`, `~/.gemini`, `~/.config/opencode`, `~/.vibe`).
- `propr check` reports the detected [GitHub auth mode](../operations/github-auth.md) (own App, relay, or demo) and flags missing or placeholder configuration before anything starts. `--verify` additionally verifies GitHub App access (minting an installation token) and runs an image/CLI smoke test per agent. GitHub transport failures are warnings.
- `propr start --no-tui` starts without the interactive dashboard (for scripts/CI); `--no-pull` skips image pulls; `--restart` recreates running services.
- `propr tank [bundled|external|off] [--url <url>]` configures [Agent Tank](../operations/agent-tank.md) LLM usage tracking on a running stack (omit the mode to print the current one). `bundled` runs Agent Tank inside the agent image with nothing to install; `external` needs `--url` pointing at a daemon you run. `on` remains a deprecated alias for `external`.

### Agent Skill

The CLI bundles the portable ProPR Operator Agent Skill for Codex, Claude Code, Antigravity CLI, OpenCode, and Vibe. Installation and removal accept `codex`, `claude`, `antigravity`, `opencode`, `vibe`, or `all`; status defaults to all targets:

```bash
propr skill install codex claude  # install, adopt an exact copy, or update a managed copy
propr skill status                # inspect all target paths and content identities
propr skill remove codex          # remove an unmodified ProPR-managed copy
```

Interactive `propr setup` detects configured tools, shows their exact target paths, and offers installation once; declining the prompt or passing `--no-skill` leaves them unchanged. Setup never installs the skill without this opt-in. When stdin is non-interactive, it does not infer targets or write to agent homes unless `--install-skill <comma-separated-targets>` explicitly names them.

Skill operations refuse unsafe paths and, by default, refuse to overwrite or remove foreign or user-modified content. `propr skill install <targets> --force` first moves replaced content to a timestamped sibling backup. Removal without `--force` accepts only unmodified ProPR-managed copies and preserves the removed tree as a timestamped backup; forced removal also preserves foreign or modified content as a backup rather than deleting it.

The skill treats GitHub as the primary orchestration surface and the CLI as an optional aid for installation, host lifecycle, and observability. AI agents using it must not recursively delegate ProPR-orchestration work back into ProPR.

:::warning[Breaking changes in the control-plane CLI]
Running bare `propr` performs the same environment checks as `propr check` (including a Docker probe) and exits nonzero when prerequisites are missing — use `propr --help` for help text. `propr status` now reports the **local Docker stack**; use `propr remote-status` for the backend health/queue JSON that older scripts read from `propr status --json`.
:::

## GitHub Relay (shared-app auth)

If you use a vendor-provided shared GitHub App instead of registering your own, the stack fetches short-lived installation tokens from a relay. See [ProPR Connect](../operations/propr-connect.md) for the hosted bridge behind the shared App, routing WebSocket, relay tokens, and managed UI tunnels; see [GitHub Authentication](../operations/github-auth.md) for the token configuration details.

**The easiest path is `propr setup`:** accept **ProPR Connect (default ProPR GitHub App)** and setup logs in through the GitHub CLI when needed, offers to install the official App when none is available, discovers the installation, mints the relay token, and writes the relay, routing, and Connect browser-login settings to the stack `.env`. A fresh stack also uses the verified GitHub user as its initial administrator and trigger whitelist. No separate OAuth App or enroll command is needed.

To manage relay tokens directly — or to enroll outside the wizard — use `propr relay`. Run these from the initialized stack directory (the one holding `.env`), so the token is written to the right `.env`:

```bash
propr relay enroll       # mint a relay token and save it to the stack .env
propr relay list         # list relay tokens for the installation
propr relay revoke <id>  # revoke a token
```

`propr relay enroll` discovers the installation automatically from your `propr login` identity when you have exactly one; pass `--installation <id>` to choose among several, or `--url <url>` to target a self-hosted relay.

## Own GitHub App

```bash
propr github-app create --public-url https://propr.example.com --root /srv/propr
propr github-app create --public-url https://propr.example.com --org my-org --no-browser
propr github-app manifest --public-url https://propr.example.com --root /srv/propr
```

`create` registers a private GitHub App through GitHub's manifest flow, opens the
installation page, verifies the installation, writes a `0600` private key and
updates the stack `.env`. It configures direct webhooks and GitHub login through
the same App, removes relay settings, and checks permissions, events, and token
creation. Restart with `propr start --restart` afterward.

`manifest` writes `github-app-manifest.json` and `github-app.env.example` for
manual/offline preparation, without changing the stack `.env` or calling GitHub.
Both commands use the same manifest builder.

| Option | Meaning |
|---|---|
| `--public-url <url>` | Required public stack URL; webhook defaults to `/webhook` |
| `--root <dir>` | Stack root; otherwise uses `PROPR_ROOT`, saved root, or cwd |
| `--org <login>` | Register the App under this organization |
| `--name <name>` | Override the sanitized `ProPR-<host>` default (maximum 34 characters); choose another in GitHub's form if taken |
| `--webhook-url <url>` | Override the webhook endpoint |
| `--webhook-secret <secret>` | `create`: update GitHub and `.env` with this secret after conversion |
| `--allow-workflow-changes` | Request Workflows write; otherwise pushes editing `.github/workflows/*` fail |
| `--no-browser` | `create`: portable HTML form and pasted redirect URLs for SSH |
| `--force` | Replace existing credentials (with an env backup), or manual output files |
| `--json` | Output field names and file paths only; progress remains on stderr |

Over SSH, copy the printed HTML form to your browser's machine and open it, then
paste each GitHub redirect URL back into the terminal. An unreachable loopback
page is expected on a remote machine; GitHub redirects the browser there rather
than calling localhost from its servers, so copy the URL from the address bar.
Webhook POSTs use the public `--webhook-url` instead. See
[Create your own App](../operations/github-auth.md#create-your-own-app) for the
permission/event tables, callback constraints, and interrupted-setup recovery.

`propr setup` offers **Custom GitHub App → Create it for me** or **I already have
one**. ProPR Connect remains the default. `propr check` verifies installed
permissions and events and explicitly warns about Actions read-only and absent
Workflows write access.

## Hosted UI Tunnel

The hosted ProPR UI at `https://app.propr.dev` can drive a locally-running stack: an optional managed `cloudflared` sidecar publishes the local **API** at a per-instance `https://t-<id>.propr.dev` hostname. It is **off by default**; local development on `http://localhost:5173` is unaffected.

| Command | Description |
|---|---|
| `propr tunnel setup --token <connector-token> --url https://t-<id>.propr.dev --start` | Write the tunnel `.env` values (`PROPR_UI_TUNNEL_TOKEN`, `PROPR_INSTANCE_ID`, `PROPR_UI_PUBLIC_API_URL`, `API_PUBLIC_URL`, `FRONTEND_URL`, `GH_OAUTH_CALLBACK_URL`) from the one-time token and URL shown in ProPR Connect, record the tunnel as enabled, and — with `--start` — start or recreate the stack with the hosted URLs applied |
| `propr tunnel on` | Start the cloudflared sidecar; requires a configured token and a running stack (`--force` starts it ahead of the stack) |
| `propr tunnel off` | Stop the sidecar; the token and env values are left untouched |
| `propr tunnel verify` | Check the sidecar plus the public `/api/status` (expects OK/auth), `/` (expects 404), and `/socket.io/` (expects reachable) |
| `propr connect status --json --root <explicit-root>` | Emit the bounded secret-free desktop discovery contract and verify that the remote API origin and public stack identity match |

Architecture, the full configuration, enablement semantics, verification, and troubleshooting live on the dedicated [Hosted UI Tunnel](../operations/hosted-ui-tunnel.md) page — including the two facts that catch operators most often: `PROPR_UI_TUNNEL_TOKEN` is a live Cloudflare credential to keep out of source control and logs, and enabling the tunnel on an already-running stack requires `propr start --restart` (or `propr tunnel setup --start`) before OAuth redirects and cookies use the hosted URLs.

## Connect and Authenticate

```bash
# 1. Point the CLI at your ProPR backend
propr remote https://api.propr.example.com

# 2. Authenticate with GitHub
propr login                 # interactive, via the gh CLI
propr login ghp_xxxxxxxx    # or pass a Personal Access Token directly

# 3. Set a default project so commands stay short
propr use owner/repo
```

Configuration is stored in `~/.propr/config.json`.

- Interactive `propr login` reuses an existing `gh` session, or launches `gh auth login` if none exists.
- For a Personal Access Token, create a classic token at `https://github.com/settings/tokens` with the `repo` and `read:org` scopes.
- `propr logout` clears the stored token.

## Global Options

| Option | Description |
|--------|-------------|
| `-p, --project <owner/repo>` | Target project for this invocation (overrides `propr use`) |
| `-j, --json` | Machine-readable output (a per-command flag supported by most commands; a few accept only `--json`) |
| `-V, --version` | Print the CLI version |
| `-h, --help` | Help for any command or subcommand |

## Repository Setup Files

Run `propr init` from a repository root to scaffold `.propr/` setup files used inside agent execution containers. The generated `.propr/setup.sh` runs before each implementation execution; use it for repository-local setup such as installing npm helper packages from `.propr/package.json`.

The scaffold also includes a commented `.propr/pr-template.md` for shaping pull request titles and descriptions. Run `propr repo validate` in the checkout to report unknown sections and placeholders; see [Pull request templates](./pr-templates.md).

## Agent Runtime Packages

Installation-wide system packages are built into local derivatives of the unified Debian agent image. ProPR validates names against the runtime's `apt` package catalog, and the previous profile remains active until every derived image builds successfully.

```bash
propr runtime packages list
propr runtime packages add chromium ffmpeg --wait
propr runtime packages remove ffmpeg --wait
propr runtime packages apply --wait
propr runtime packages verify
propr runtime packages verify --json
propr runtime status --json
```

Use runtime packages for Debian system tools needed across repositories or by a specific installation. Keep repository-specific npm helpers and setup commands in `.propr/setup.sh`; those run in each fresh execution container without sudo privileges.

The Settings package field searches the configured runtime catalogs and validates availability across every agent image before a build is queued. The first search after an API restart may take a few seconds while package indexes are refreshed.

Package search and validation inspect the unified agent image with the local Docker daemon, so the image must be present locally (pulled by the launcher/worker or built with `scripts/build-images.sh`) before the package UI or these CLI commands can be used. A remote-only registry reference is not enough.

Run `propr runtime packages verify` after replacing or pulling an agent base image, after applying runtime-package changes, or when local Docker images may have been pruned. Verification is read-only: it compares desired and active profiles, checks the current base-image lineage and derived-image labels/final user, and queries installed Debian packages in a short-lived container with networking disabled. It does not install packages or rebuild images. An unhealthy result exits nonzero and identifies missing images or packages, pinned-version mismatches, stale lineage, and profile drift; repair these with `propr runtime packages apply --wait` and verify again. An empty profile reports `DISABLED` successfully.

## Plans

```bash
propr plan list                                  # List plans for the default project
propr plan create "Add dark mode" --wait         # Create a plan and wait for generation
propr plan create "Fix bug" -b develop           # Target a specific branch
propr plan get <draft-id>                        # Plan details (--json for JSON)
propr plan generate <draft-id> --wait            # (Re)trigger generation for a draft
propr plan finalize <draft-id>                   # Create GitHub issues from plan items
propr plan issues <draft-id>                     # List the plan's issues
propr plan abort <draft-id>                      # Abort an ongoing generation
propr plan delete <draft-id> --force             # Delete without confirmation
```

| Option | Applies to | Description |
|--------|-----------|-------------|
| `-b, --branch` | `create` | Target branch (default: `main`) |
| `-w, --wait` | `create`, `generate` | Block until plan generation completes |
| `-f, --force` | `delete` | Skip the confirmation prompt |

## Issue Implementation

```bash
propr issue implement <draft-id>/<issue-number>            # Start implementation
propr issue implement <draft-id>/1 --wait                  # Wait for completion
propr issue implement <draft-id>/1 -a claude -m <model>    # Pick agent and model
propr issue implement <draft-id>/1 --epic --auto-merge     # Epic PR + auto-merge on green CI
propr issue implement <draft-id>/1 --max-cost 5            # Stop the run once it has spent ~$5
```

The issue ID format is `<draft-id>/<issue-number>` (or `<draft-id>:<issue-number>`).

| Option | Description |
|--------|-------------|
| `-a, --agent` | Agent alias to run the implementation |
| `-m, --model` | Model ID for the implementation |
| `-w, --wait` | Block until the task completes |
| `--epic` | Create an Epic PR that collects the related PRs |
| `--auto-merge` | Enable auto-merge once CI checks pass |
| `--max-cost <usd>` | Per-run [spend cap](./execution-safety.md#spend-caps); overrides `.propr/workflow.yml` and the instance default |

## Goals

[Goals](./goals.md) can be run end to end from the terminal. The commands use the same owner-scoped goal API as the Web UI, so goals created here appear on the **Goals** page and vice versa; no MCP connection is needed.

```bash
propr goal capabilities                       # Goal-capable agents, their models, and why others are unavailable (--recheck)
propr goal create -p owner/repo -a codex -m <model> "Add audit logging"   # Create AND start a goal (or --file / --stdin)
propr goal list --state active                # Your goals (--project, --state, --limit, --offset)
propr goal attention                          # Goals waiting on you: pauses, provider questions and approvals, with the command that resolves each
propr goal inspect <goal-id>                  # State, narration, progress, checkpoints, pending input, model, failures, PRs
propr goal wait <goal-id> --until terminal --timeout 3600   # Wait, with a finite deadline, for a confirmed state or a new checkpoint
propr goal input <goal-id> "Also cover the admin endpoints"   # Correction or question (or --file / --stdin / --canned done|left)
propr goal inputs <goal-id>                   # Input delivery history, newest first (--limit, --offset)
propr goal pause <goal-id>
propr goal resume <goal-id>
propr goal model <goal-id> <model>            # Request a model change at the next provider boundary
propr goal cancel <goal-id>
```

**Creating a goal starts work immediately.** `goal create` options:

| Option | Description |
|--------|-------------|
| `-p, --project` | Repository (`owner/repo`); defaults to the configured project |
| `-a, --agent` | Agent ID or alias; defaults to the only goal-capable agent |
| `-m, --model` | Model; defaults to the agent's default model |
| `-s, --strategy` | `direct` (default) or `orchestrate` |
| `-b, --base-branch` | Base branch for the goal's pull request |
| `--max-parallel-tasks` | Parallel-task limit (1–32) |
| `--checkpoint-interval` | Checkpoint target cadence in minutes, direct strategy only (5–120, default 15) |
| `--ultrafix` | Run Ultrafix before the goal declares completion |
| `--idempotency-key` | Key for safe retries and recovery (see below) |

Agent, model and option validation is the same as goal creation in the Web UI: an unsupported model or a non-goal-capable agent is rejected with the server's reason.

### Requests versus confirmed state

Pause, resume, cancel, model changes and inputs are *requests*. They are accepted immediately and applied at the next provider boundary, so acceptance is not provider acknowledgement or completed execution. Output keeps the two apart:

- `lifecycle.requestedState` is what was asked for (`running`, `paused`, `cancelled`); `lifecycle.observedState` is what has been confirmed (`starting`, `running`, `resuming`, `pausing`, `paused`, `cancelling`, `completed`, `failed`, `cancelled`). Control results also carry `requested` and `confirmed`.
- `model.requested` and `model.effective` differ until the provider runs with the new model; `model.confirmed` is `true` only once they agree.
- An input is `pending` (queued) until it is `delivered` to the provider. Delivery does not prove the agent acted on it, so `actedOn` is always `null`.
- `lifecycle.goalCompleted` reflects the goal's result. `currentTask.taskCompleted` only reflects the current provider task: a completed task is not a completed goal.

### Idempotency and recovery

Every mutation sends an `Idempotency-Key`. Without `--idempotency-key` the CLI generates one per invocation and prints it. Transient failures (network errors, timeouts, 502/503/504) are retried automatically with the same key, so a retry never starts a second goal or queues a second input. Reusing a key with a different payload is rejected with `idempotency_conflict`.

If the outcome still cannot be confirmed, the command exits 1 with `outcome_uncertain` and the key. This also applies when a retry after a lost response is refused with 401 or 403 (for example, because the login expired): the refusal does not prove that the earlier attempt failed, so the error keeps `outcome_uncertain` and the key, and adds `refusal` (`unauthorized` or `forbidden`). Run `propr login` or restore access first, then retry with the key. Re-run the same command with `--idempotency-key <key>`: if the goal was created, it is returned (`outcome: "replayed"`) instead of starting another one. A `saved_queue_pending` outcome means the goal was saved and the server's recovery will start it; do not create it again.

### JSON output

Every goal command accepts `--json` and prints a versioned document: `{ "version": 1, "kind": ... }` with kinds `goal-capabilities`, `goal-create`, `goal-list`, `goal-detail`, `goal-input`, `goal-inputs`, `goal-control` and `goal-wait`. Goal, task, session and input identifiers are preserved. Lists return `offset`, `limit` and `nextOffset` (`null` on the last page).

### Waiting for a goal

`propr goal wait <goal-id>` blocks until the goal reaches a state or records a new durable event, and always stops at a finite deadline. It never changes the goal: Ctrl-C only stops waiting.

| Option | Meaning |
| --- | --- |
| `--until <condition>` | `completed`, `failed`, `cancelled` (the goal's persisted result), `paused` (a pause the worker confirmed), `terminal` (any of completed, failed or cancelled) or `checkpoint` (a checkpoint published after the cursor). Omit it to wait for any new goal event. |
| `--after-cursor <cursor>` | Only count events after this cursor, as printed by an earlier wait. |
| `--timeout <seconds>` | Overall deadline, `0`–`86400` (default `300`). `0` checks once without waiting. |
| `-j, --json` | Print a `goal-wait` document: `outcome`, `condition`, `cursor`, `matchedImmediately`, the triggering `event`, the current `goal` projection, `requests` and `exitCode`. The timeout and Ctrl-C variants are described below. |

Requested controls never satisfy a wait: `--until paused` ignores a pause that has only been requested, `--until cancelled` ignores a requested cancellation, and a finished child task or an idle agent never counts as goal completion.

**Cursors.** Without `--after-cursor`, a state condition that already holds matches immediately (`matchedImmediately: true`); otherwise only events after the current boundary count, so `--until checkpoint` never reports a checkpoint that already existed. With `--after-cursor`, only newer events count, and transitions that happened while nothing was waiting are replayed in order. Every result prints a cursor: pass it to the next wait to continue without missing or repeating a transition. Once a wait has reported the goal's completed, failed or cancelled event, a wait resumed from that cursor is `unreachable`, because a finished goal records nothing further. A cursor for a different goal, a malformed cursor or one this instance no longer has history for fails with `invalid_cursor` or `cursor_expired`; re-run without `--after-cursor` and check `propr goal inspect`.

**Bounded requests and retries.** The CLI chains server requests of at most 30 seconds each until the deadline, carrying the cursor between them. Without `--after-cursor`, a first non-blocking request fixes the starting cursor, so a retry never moves the boundary past a checkpoint published while the wait was in flight. That first request is itself never retried, because a repeat would be answered with a later boundary: if it fails before a cursor arrives, the wait exits 1 with the error code `boundary_not_established`. Check `propr goal inspect` for the current state and checkpoints, then re-run the wait. Once a cursor is held, transient network failures and 502/503/504 responses are retried with the same cursor, so re-running a wait with the last printed cursor is always safe. The deadline is enforced even while a request or retry is pending: at `--timeout`, plus up to 2 seconds for a reply already in flight, the CLI abandons the request and reports `timed_out` with the last cursor.

**Concurrency.** One user may hold at most 16 open waits on each API server. The limit is shared with MCP `wait_goal`, so CLI follow loops and MCP agents count together; a wait over the limit fails with HTTP 429 and the error code `wait_limit`, reports how many are open and is not retried. The limit is temporary: re-run the same command once another wait has ended.

**JSON documents.** A completed wait prints the full document above. Two variants omit information:

- `timed_out` before any request completed (for example an unresponsive server): `goal` is `null`, and `cursor` is `null` unless `--after-cursor` was given.
- Ctrl-C prints only `{ "version": 1, "kind": "goal-wait", "goalId", "outcome": "interrupted", "condition", "cursor", "exitCode": 130 }`. It has no `event`, `goal`, `matchedImmediately` or `requests`, and `cursor` is `null` when no request completed and no `--after-cursor` was given.

**Exit codes:** `0` matched, `2` timed out (a timeout is not a goal failure; the reported `goal` state is current and may already be terminal, so check it and retry with the printed cursor), `3` unreachable (the goal ended and no event after the cursor can match, for example `--until paused` on a completed goal, or `--until terminal` with the cursor of the goal's own completion event; the wait returns at once instead of running to `--timeout`), `130` interrupted with Ctrl-C (the last cursor is printed), `1` error.

```bash
# Block a script until the goal finishes, for at most an hour.
propr goal wait "$GOAL" --until terminal --timeout 3600 --json > result.json
case $? in
  0) jq -r '.goal.lifecycleState' result.json ;;   # completed, failed or cancelled
  2) echo "still running; resume with --after-cursor $(jq -r .cursor result.json)" ;;
esac

# Follow published checkpoints without ever re-reporting an old one.
cursor=""
while out=$(propr goal wait "$GOAL" --until checkpoint --timeout 900 --json ${cursor:+--after-cursor "$cursor"}); do
  cursor=$(jq -r .cursor <<<"$out"); jq -r '.event.checkpoint.commitSha' <<<"$out"
done
```

Failures exit 1. With `--json` they print a `goal-error` document to stdout whose `error.code` is one of `invalid_arguments`, `validation_failed`, `unauthorized`, `forbidden`, `not_found`, `idempotency_conflict`, `agent_not_goal_capable`, `state_conflict`, `outcome_uncertain`, `invalid_cursor`, `cursor_expired`, `wait_limit`, `boundary_not_established`, `server_error`, `network_error` or `request_failed`, plus the server message, HTTP status, idempotency key and recovery hint where relevant. Another user's goal reads as `not_found`.

## Agents (saved automations)

Agents, the saved automations on the **Agents** page of the Web UI, are driven by `propr automation` (alias `propr automations`). The group is separate from `propr agent`, which manages coding-agent configurations. See [Agents](./agents.md) for what a run does, autonomy and the cost gate.

```bash
propr automation list                          # Your agents (--limit, --offset)
propr automation show <agent-id>               # Prompt, schedule, autonomy, repositories
propr automation run <agent-id>                # Trigger a run (--idempotency-key, --source, --wait, --timeout)
propr automation runs <agent-id> --limit 5     # Run history, newest first
propr automation report <run-id> > report.md   # Report Markdown on stdout, metadata on stderr
propr automation approve <run-id> --note "Only the top finding"   # Preview runs
propr automation reject <run-id>
propr automation cancel <run-id>
```

`run` sends an `Idempotency-Key` with `{ "trigger": "cli", "source": ... }`. Without `--idempotency-key` the CLI generates `cli-<uuid>` and prints it. Transient failures are retried with the same key, so running the command again with that key returns the first run (`created: false`) instead of starting another. CLI triggers go through the usage gate: a run deferred or skipped for low provider capacity prints the reason on stderr.

With `--wait`, the CLI polls the run every 5 seconds until it reaches a terminal state, is deferred, or awaits approval, for up to `--timeout` seconds (default 1800). Run metadata and state changes go to stderr and the report goes to stdout. **Exit codes:** `0` completed (without `--wait`: accepted), `2` timed out (the run continues), `3` skipped or deferred, `4` awaiting approval, `1` failed, rejected, cancelled or error.

The trigger works from your own cron or a GitHub Actions step:

```yaml
- name: Run the weekly triage agent
  run: npx propr-cli automation run "$AGENT_ID" --idempotency-key "$GITHUB_RUN_ID" --source github-actions --wait > report.md
```

With `--json`, every command prints a `{ "version": 1, "kind": ... }` document with one of the kinds `automation-list`, `automation`, `automation-runs` or `automation-run`. Failures print `automation-error`. A missing or another user's agent prints `Agent not found`.

## Tasks

```bash
propr task list                            # All tasks
propr task list -s processing              # Filter by status
propr task list --search "auth" -l 100     # Search with a result limit
propr task inspect                         # Active tasks, including queued work
propr task inspect --state queued          # One exact server lifecycle state
propr task inspect <task-id>               # Current details and full run history
propr task get <task-id>                   # Details with run history
propr task stop <task-id>                  # Stop a running task
propr task delete <task-id> --force        # Force-delete an active task
propr task followup <task-id> "Also add tests"    # Post and queue a follow-up (or --file / --stdin)
propr task import "Recover missing tasks"  # Reconcile or recover tasks from GitHub
propr task revert owner/repo <pr> <sha> [comment-id]   # Revert a commit from a PR (--dry-run to preview)
```

Status values for `-s`: `pending`, `queued`, `processing`, `completed`, `failed`, `cancelled`, `all`. These are queue-level filters; task details additionally display the finer-grained worker states `claude_execution` ("Executing", agent run for any agent type) and `post_processing` (see [Worker Runtime](../architecture/worker-runtime.md)).

### Inspect active tasks

`propr task inspect` is the read-only view for operators and automation. With
no ID, it sends explicit server-side filters for every canonical active state:
`pending`, `queued`, `processing`, `claude_execution`, and `post_processing`.
Use `--state <state>` to request one exact lifecycle state, `--project
owner/repo` to restrict the repository, and `--limit` to cap the combined
result. The human table separates Queued, Processing, Executing, and
Post-processing work and includes repository, title, agent/model, elapsed time,
and last update.

With a task ID, the same command uses the existing task details/history endpoint:

```bash
propr task inspect <task-id>
propr task inspect <task-id> --json
```

`--json` has a deterministic, versioned contract. Lists use `version`,
`kind: "task-list"`, `states`, `tasks`, and `total`; each task always has `id`,
`repository`, `title`, `state`, `agent`, `model`, `elapsedMs`, and `updatedAt`.
Details use `kind: "task-detail"` and a `task` object containing those identity
and timing fields plus status flags, failure/PR data, `details`, and the full
`history`. Missing scalar values are `null`, timestamps are ISO 8601, and
durations are integer milliseconds.

## Repositories

```bash
propr repo list                              # Monitored repositories
propr repo add owner/repo -a "Alias" -b dev  # Add with alias and base branch
propr repo add owner/repo --auto-ci-followup # Enable automatic follow-up for failed CI
propr repo remove owner/repo
propr repo toggle owner/repo --enable        # Enable/disable monitoring
propr repo toggle owner/repo --auto-ci-followup     # Enable failed-CI follow-up
propr repo toggle owner/repo --no-auto-ci-followup  # Disable failed-CI follow-up
propr repo toggle owner/repo --visual-previews --preview-types image,video
propr repo toggle owner/repo --no-visual-previews
propr repo toggle owner/repo --no-github-pr-template  # Don't append the GitHub PR template
propr repo toggle owner/repo --auto-resolve-conflicts on       # Always auto-resolve merge conflicts (off, inherit)
propr repo index owner/repo                  # Full reindex
propr repo index owner/repo --incremental    # Incremental reindex
propr repo status                            # Indexing status for all repos
propr repo validate                          # Check .propr/pr-template.md in this checkout
```

Automatic CI follow-up is configured per repository and is **off by default**. Enable it only for repositories whose CI failures are high-quality, trusted signals; noisy or flaky checks can otherwise create unnecessary follow-up work. `propr repo list` shows the current setting for every monitored repository.

Visual previews are also per-repository and **off by default**. `--preview-types` accepts `image`, `video`, or `image,video`; use `--preview-instructions` to add project-specific capture details. See [Visual Previews](./visual-previews.md) for generation and publication behavior.

## Agents

```bash
propr agent list
propr agent add my-claude -t claude -m model1,model2 -d model1
propr agent add test -t antigravity -m antigravity-gemini-3.1-pro --disabled
propr agent add opencode -t opencode -m opencode-big-pickle \
  -d opencode-big-pickle --config-path ~/.config/opencode
propr agent add --file agent-config.json     # From a JSON file (or `-` for stdin)
propr agent enable my-agent                  # Enable / disable without deleting
propr agent disable my-agent
propr agent delete my-agent --force

propr agent pool list --json > pools.json
propr agent pool apply pools.json       # Also accepts '-' for stdin
propr agent pool delete balanced-pool
```

Agent types: `claude`, `codex`, `antigravity`, `opencode`, `vibe`.

See [Agents and Models](./agents-and-models.md) for the model catalog, label formats, and per-agent credential setup, including the OpenCode host-authentication steps and the `XDG_DATA_HOME` requirement for file-based OpenCode auth.

Synthetic pool commands replace one complete, nested configuration document. JSON from `pool list --json` can be passed unchanged to `pool apply`; validation failures retain the backend's nested field message. See [Synthetic Pools](./synthetic-pools.md) for schemas and routing behavior.

## To-Dos

```bash
propr todo list                          # Open todos (-a all, -d completed)
propr todo add "Fix login page" -c <category-id>
propr todo get <todo-id>
propr todo complete <todo-id>            # --undo to reopen
propr todo move <todo-id> 1 -c <cat-id>  # Reorder / move between categories
propr todo delete <todo-id>

propr todo category list
propr todo category add "Bug fixes"
propr todo category rename <id> "New name"
propr todo category move <id> 1
propr todo category delete <id>          # Its todos become uncategorized
```

## Settings, Logs, and System

```bash
propr setting get                                  # All settings
propr setting get -k worker_concurrency
propr setting update worker_concurrency 4
propr setting update github_user_whitelist "a,b,c"

propr log list                       # Recent LLM logs
propr log list -m <model> --failed   # Filter by model, failures only
propr log list --agent my-claude --draft <draft-id> --page 2 -l 100

propr remote-status     # Backend health check (daemon, workers, Redis, GitHub auth)
propr queue             # Queue statistics
propr stats review-scores --period 30d [--repository owner/repo] [--json]  # Review quality per implementer model
```

Settings keys:

| Key | Description |
|-----|-------------|
| `default_agent_alias` | Alias of the default implementation agent |
| `worker_concurrency` | Number of concurrent workers for processing tasks |
| `github_user_whitelist` | GitHub usernames allowed to use the system |
| `analysis_model_fast` | Used by `/review` to gather repository context before the review |
| `planner_context_model` | Model for planner context generation |
| `planner_generation_model` | Model for planner generation |
| `auto_resolve_merge_conflicts` | Automatically resolve merge conflicts |
| `dashboard_summary_enabled` | Enable AI-generated dashboard activity summaries |
| `model_reasoning_level` | System reasoning preference for Claude, Codex, and Antigravity, resolved against the selected model's supported levels (empty = default effort; model overrides and explicit run / `level-*` selections take precedence). See [Reasoning Levels](./agents-and-models.md#reasoning-levels). |
| `usage_tips_enabled` | Show daily documentation tips on the dashboard |
| `usage_tips_dismissal_cooldown_days` | Base dismissal cooldown for tips (1–365 days) |
| `pr_review_model` | Model for full PR reviews |
| `pr_review_prompt` | Override for the PR review prompt guidance (empty = built-in default) |
| `pr_review_context_enabled` | Gather related unchanged code before PR reviews |
| `pr_review_context_model` | Model for read-only PR review context scouting |
| `pr_review_max_context_tokens` | Legacy absolute PR review input token cap (0 = none) |
| `pr_review_context_budget_percent` | Review context budget as % of each reviewer's safe input capacity (10–100, steps of 10) |
| `ultrafix_rating_goal` | Target quality rating for ultrafix cycles |
| `ultrafix_max_cycles` | Maximum number of ultrafix cycles |
| `ultrafix_pause_seconds` | Pause duration between ultrafix cycles |
| `default_max_cost_usd` | Default per-run [spend cap](./execution-safety.md#spend-caps) in USD (0 = no cap) |
| `agent_stall_timeout_ms` | Stop an agent run silent this long, in ms (0 disables; `default` restores `AGENT_STALL_TIMEOUT_MS`) |
| `agent_tool_stall_timeout_ms` | Silence allowed while a tool call runs, in ms (0 disables; `default` restores `AGENT_TOOL_STALL_TIMEOUT_MS`) |
| `agent_degenerate_output_limit` | Consecutive whitespace-only deltas that stop a run (0 disables; `default` restores `AGENT_DEGENERATE_OUTPUT_LIMIT`) |

`propr setting update` also accepts `pr-label`, `ai-primary-tag`, `primary-processing-labels`, and `followup-keywords` (comma-separated for the list keys).

## Scripting

Most commands accept `--json` for programmatic use:

```bash
propr repo list --json | jq '.repos_to_monitor[].name'
```

A terminal-only path from prompt to pull request:

```bash
propr plan create "Split auth cleanup into reviewable PRs" --wait
propr plan issues <draft-id>
propr issue implement <draft-id>/1 --wait
propr task get <task-id>
```

The CLI package also exports its modules for programmatic use from Node.js — see `packages/cli/README.md` in the source repository.
