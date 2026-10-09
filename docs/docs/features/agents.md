---
title: Automations
---

An **Automation** is a saved, reusable definition that runs on demand or on a schedule and produces a free-form report. Use one for recurring investigation: a weekly dependency review, a daily triage of new issues, a check of a competitor's changelog, a summary of what merged last week. Use a [task](./launching-work.md) for a single change and a [goal](./goals.md) for a continuing objective.

The Web UI calls these **Automations**, to keep them apart from the **Coding Agents** (Claude Code, Codex and the other runtimes) that execute them. The REST API, MCP tools and stored records still call one an *agent definition*, and the CLI drives them with `propr automation`.

Every run follows the same path:

1. **Definition.** A name, a prompt with optional input files, repositories, an agent and model, capabilities, an optional schedule and an autonomy mode.
2. **Isolated report run.** ProPR starts an ordinary task container for the run. The agent investigates and its final message becomes the report.
3. **Free-form report.** Markdown stored with the run, shown on the **Automations** page and available over the API, MCP and CLI.
4. **Optional acting step.** In `preview` or `auto` mode, a second, separate agent run reads the report and acts on it through ProPR's MCP tools (see [Acting on a report](#acting-on-a-report)).

What an Agent is **not**:

- **Not a new engine.** Report and acting runs are ordinary ProPR task executions with the same containers, spend caps, watchdog, logs and LLM Log entries as any other task.
- **Not an event watcher.** v1 has no built-in event triggers: it does not watch labels, issues, pushes or webhooks. Use the schedule, or call the [trigger](#triggers) from your own automation (a GitHub Actions workflow, a webhook relay or a crontab).
- **Not structured actions.** ProPR never parses a report for actions. A report is text for a human. Acting on it is a separate agent run with a fixed tool set.

Agents are personal: every definition and run belongs to the user who created it. Another user's agent reads as "not found" on every surface.

## Create an agent

Open **Automations** in the sidebar and choose **New Automation** in the header. Fill in the form and choose **Create automation** at the bottom of the form (later edits use **Save changes** in the same place), then use **Run now** or the **Runs** tab. The REST API (`POST /api/agent-definitions`) accepts the same fields; `GET /api/agent-definitions/contract` and the MCP tool `get_agent_definition_contract` return the authoritative limits.

### Scope

**Repositories** (up to 10, `owner/repo`) are the repositories the agent may read and, in the acting step, act on. Every repository must be enabled in ProPR, and your GitHub account must be able to read it: ProPR checks your access when you save and every time a run is triggered. An agent may have no repositories at all, for example one that only researches the web and writes TODOs.

The first repository is the primary one: with `repository_read` it is checked out as the workspace. The others are shallow, read-only copies under `.propr/context/`.

### Prompt and input files

The **prompt** (up to 32,768 characters) is the standing instruction for every run. Write it like a brief for a colleague: what to look at, what matters, and what the report should contain.

**Input files** (up to 10) are attached to the definition and copied into `.propr/agent-inputs/` in every run's workspace. Use them for checklists, reference lists or report templates. Text files only; binary uploads are refused.

### Previous reports

**Previous reports** (0 to 5, default 0) feeds the newest earlier reports of the same agent into the next run. The prompt then tells the agent to compare with them and lead with what is new, changed or resolved. Use it for "what changed since last week" agents. Each previous report is cut to 10,000 characters (50,000 in total) with a visible `[truncated]` marker. If the prompt would still exceed its size limit, the oldest reports are left out and the prompt says so. Only runs that produced a report count: completed, rejected, awaiting-approval and acting runs, not failed or skipped ones.

### Agent and model

Choose a configured coding agent and a model it supports, or leave both empty to use the instance's default agent. A [synthetic pool](./synthetic-pools.md) works too. The choice is validated against the live agent configuration when you save and again at trigger time, so a run whose agent has since been removed is refused with `AGENT_INVALID` instead of running with a different one.

### Capabilities

Each capability can be switched on or off separately. The default is `repository_read` only.

| Capability | Effect | Claude Code | Codex | Antigravity, OpenCode, Vibe |
| --- | --- | --- | --- | --- |
| `repository_read` | Checks out the repositories and gives the container a read-only GitHub token. Off: the workspace is an empty git directory with only the input files. No clone is mounted and no repository token is issued. | Enforced by ProPR | Enforced by ProPR | Enforced by ProPR |
| `web` | Allows web search and fetching URLs. | Enforced natively (`WebFetch`, `WebSearch` disallowed when off) | Enforced natively (`web_search` disabled when off) | **Best effort**: the prompt tells the agent not to use the web, but the runtime has no switch to enforce it |
| `propr_mcp` | Mounts ProPR's MCP server in the report run with a read-only grant, so the agent can read tasks, PRs, TODOs and docs. | Supported | Supported | **Not supported**: saving such a definition is refused |

The acting step of `preview` and `auto` agents always uses ProPR's MCP server, so those modes also require Claude Code or Codex (or a synthetic pool whose enabled members all support it). `web` in the acting step follows the definition.

If web access must be blocked, choose Claude Code or Codex. For the other runtimes, also consider the instance's optional [network firewall](./execution-safety.md#restricted-network-mode).

### Schedule

**Schedule** is off by default: the agent then runs only when triggered. To run it automatically, enter a standard 5-field cron expression (`minute hour day-of-month month day-of-week`) or pick a preset:

| Preset | Expression |
| --- | --- |
| Hourly | `0 * * * *` |
| Daily 09:00 | `0 9 * * *` |
| Weekdays 09:00 | `0 9 * * 1-5` |
| Weekly Mon 09:00 | `0 9 * * 1` |

The rules:

- Times are **UTC**. Time zones are not supported in v1: for 09:00 in New York (UTC−4 in summer), write `0 13 * * *`.
- Lists (`1,15`), ranges (`1-5`), steps (`*/30`) and the macros `@hourly`, `@daily`, `@weekly` and `@monthly` are accepted. Day-of-week is 0–7, where 0 and 7 are Sunday. If both day-of-month and day-of-week are restricted, either one matching is enough (standard cron behavior).
- A schedule may not fire more often than every **15 minutes**. `*/5 * * * *` is refused when you save.
- The form previews the next run time, and the agent list shows each schedule with when it fires next. Agents without a schedule show **Manual**.
- Each slot fires once, even with several daemons. If the daemon was down across several slots, they coalesce into one run for the latest slot; missed slots are not replayed.
- Scheduled runs are [cost-gated](#cost-control).

Setting **Schedule** back to **Off** stops scheduled runs; the agent can still be triggered. A definition disabled through the API (`"enabled": false` on `PATCH /api/agent-definitions/:id`) also refuses every trigger with `AGENT_DISABLED`. Neither deletes the definition or its history.

### Autonomy

The autonomy mode decides what happens after the report is stored:

| Mode | After the report |
| --- | --- |
| `dry_run` (default) | Nothing. The report is the whole result and the run completes. |
| `preview` | The run waits in **Awaiting approval** and you get an Inbox notification. **Approve and act** (with an optional note for the acting agent) starts the acting step. **Reject** ends the run and keeps the report. |
| `auto` | The acting step starts straight away, subject to the [cost gate](#cost-control). |

The mode is captured when a run is queued. Editing the definition later does not change a run that already exists.

## Triggers

Every run goes through one trigger primitive, whatever started it. The run history records which:

| Trigger | Started by | Cost-gated |
| --- | --- | --- |
| `manual` | **Run now** on the Automations page | No (you see a capacity warning instead) |
| `schedule` | The daemon, from the definition's schedule | Yes |
| `api` | `POST /api/agent-definitions/:id/runs` from a script or service | Yes |
| `cli` | `propr automation run` | Yes |
| `mcp` | The MCP tool `trigger_agent_run` | Yes |

All non-UI triggers take an **idempotency key**. The same key for the same agent always returns the first run (`created: false`) instead of starting another one, so retries are safe. Use a value that identifies the event, such as the CI run id or the date, not a random value generated on every attempt.

### Run now

On the agent's page, **Run now** starts a run immediately. If Agent Tank reports the agent's provider at or above the [pause threshold](#cost-control), the button first asks you to confirm. Run now is never deferred or skipped: you are watching it.

### HTTP

```bash
curl -sS -X POST "https://propr.example.com/api/agent-definitions/$AGENT_ID/runs" \
  -H "Authorization: Bearer $PROPR_GITHUB_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: nightly-$(date -u +%F)" \
  -d '{"source": "nightly cron on build-01"}'
```

Authenticate with the same GitHub token the [CLI](./propr-cli.md#connect-and-authenticate) accepts (`repo` and `read:org` scopes) for a user on the instance's allowlist. The run belongs to, and acts as, the agent's owner, so use the owner's token. The body is optional:

- `source` (up to 255 characters) is a free-form label shown in the run history. It defaults to `user:<you>`.
- `trigger` is `api` (the default for token requests) or `cli`.

The `Idempotency-Key` header is optional and up to 255 characters. A new run answers `202` and a replayed key answers `200`. Both return `{ "run": { ... }, "created": true|false }`. The run's `state` is `queued`, or `deferred`/`skipped` with the reason in `error` when the cost gate held it back.

Follow the run with `GET /api/agent-runs/:runId`. It is finished when `state` is `completed`, `failed`, `skipped`, `rejected` or `cancelled`. `report` holds the Markdown.

### GitHub Actions

The CLI's `--wait` waits for the run and prints the report, which makes a workflow step short:

```yaml
name: Weekly dependency review
on:
  schedule:
    - cron: "0 7 * * 1"
  workflow_dispatch:

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - run: npm install -g propr-cli
      - run: |
          propr remote "${{ vars.PROPR_URL }}"
          propr login "${{ secrets.PROPR_GITHUB_TOKEN }}"
      - name: Run the agent
        run: |
          propr automation run "${{ vars.PROPR_AGENT_ID }}" \
            --idempotency-key "gha-${{ github.run_id }}-${{ github.run_attempt }}" \
            --source "github-actions: ${{ github.workflow }}" \
            --wait --timeout 3600 > report.md
      - uses: actions/upload-artifact@v4
        with:
          name: agent-report
          path: report.md
```

`--wait` exits `0` when the run completed, `3` when it was skipped or deferred, `4` when it awaits approval, `2` on timeout (the run keeps going) and `1` otherwise. See [the CLI reference](./propr-cli.md#agents-saved-automations).

`PROPR_GITHUB_TOKEN` is a personal access token of the agent's owner. The workflow's own `GITHUB_TOKEN` is not a user token and is refused.

### Crontab

Use the schedule unless you need a time zone or a host that is not ProPR. If you do, this crontab line runs the agent at 08:30 local time on weekdays and keeps one run per day even if cron fires twice:

```cron
30 8 * * 1-5  propr automation run 3f0c1d9e-1d2b-4c55-9a51-6e2f8f1a7b10 --idempotency-key "host-cron-$(date +\%F)" --source "crontab on build-01" >> /var/log/propr-agent.log 2>&1
```

Cron needs `%` escaped as `\%`. Run `propr remote` and `propr login` once for the user whose crontab it is.

### MCP

From a chat client connected to ProPR's [MCP server](./mcp.md) with `execute` scope:

```json
{
  "name": "trigger_agent_run",
  "arguments": {
    "definitionId": "3f0c1d9e-1d2b-4c55-9a51-6e2f8f1a7b10",
    "source": "chat: weekly competitor check",
    "idempotencyKey": "competitor-scan-2026-10-07"
  }
}
```

The receipt returns the `runId` and its `state`. Follow it with `get_operation`, or read the report with `get_agent_run` once it is ready. In practice you ask the chat client "run my competitor check agent", and it finds the agent with `list_agent_definitions` and calls the tool.

## Reports

A report is the agent's final message, as Markdown. Open a run from the agent's **Runs** list to see:

- the state, trigger, source, timing and any skip or failure reason;
- the report, rendered as Markdown;
- for `preview` and `auto` runs, the acting step's summary of what it did, with the links and ids its tools returned;
- links to the report and acting tasks, with their full logs, prompts and costs.

Limits and truncation:

- A stored report is at most 100,000 characters. A longer final message is cut with a `[truncated]` marker. The full output stays in the report task's execution logs.
- The acting step's summary is cut at 20,000 characters the same way.
- MCP's `get_agent_run` keeps the whole run under the 256 KiB tool result limit. It returns at most 200 KB of report, less when the action summary and the rest of the run need the room, and sets `reportTruncated: true` when it cuts the report. Any other text it cuts, such as the action summary, carries its own flag (`actionSummaryTruncated: true`). The full run is at its `url`.
- The CLI's `propr automation report <run-id>` prints the stored Markdown to stdout.

Report text is agent output. ProPR never treats it as instructions. The acting step receives it fenced as data, with instructions to ignore anything inside it that tries to change its rules.

## Acting on a report

In `preview` (after approval) and `auto` mode, ProPR starts a second agent run, the **acting step**. Its input is the report, the definition's prompt for context, and the approver's note if there is one. Its only means of acting is ProPR's MCP server, through a grant that ProPR issues for that step alone.

The acting agent **can**, within the agent's repositories:

- create tasks, plans and goals, TODOs and pull request comments;
- read anything a `read` grant can (tasks, PRs, TODOs, docs).

It receives the `read`, `plan` and `execute` MCP scopes, limited to the definition's repositories and to what the owner can access. Each creating call carries an idempotency key derived from the run id, so a retried acting step does not create duplicates. The prompt also tells it to check for existing tasks and TODOs before creating new ones.

The acting agent **cannot**:

- merge pull requests, deploy, review, publish, or change settings or configuration (no `merge`, `deploy`, `review`, `publish` or `manage` scope);
- touch repositories outside the definition;
- edit files, commit, push or open pull requests itself (its workspace is never committed; changes go through the tasks it creates);
- trigger, approve or reject agent runs: those tools refuse every agent-issued grant with `AGENT_RECURSION_FORBIDDEN`, so agents cannot start other agents.

An agent without repositories can only create TODOs.

Only one autonomy mode applies to every action. Per-action-kind autonomy (for example "create TODOs automatically, but ask before starting tasks") is deferred beyond v1.

## Cost control

Unattended runs (`schedule`, `api`, `cli`, `mcp`) start while nobody is watching. Before one is queued, before a deferred run is retried and before an `auto` acting step starts, ProPR compares the provider's subscription usage from [Agent Tank](../operations/agent-tank.md) with the instance's **pause threshold**.

The threshold is the instance setting `agent_run_usage_pause_percent` (50–100, default 90). Change it with `propr setting update agent_run_usage_pause_percent 80` or MCP `update_execution_settings`. It is not in the Settings UI in v1.

| Situation | Result |
| --- | --- |
| Session (5-hour) usage at or above the threshold | **Deferred** until shortly after the session window resets, at most 30 minutes at a time, then checked again |
| Still limited after 6 deferrals | **Skipped**, with the reason |
| Weekly usage at or above the threshold | **Skipped**: a weekly window does not recover within hours |
| Usage below the threshold | Queued |
| Agent Tank disabled, unreachable, or no usage snapshot from the last hour | Queued: the gate **fails open**, so a monitoring outage never silently stops automation |
| `manual` (Run now) | Always queued; the UI warns first when usage is high |
| `auto` acting step held back | The run waits in **Awaiting approval** with the reason, so you can approve it later |

Every deferral and skip reason is a full sentence in the run history, for example "Weekly subscription usage for claude is at 93% (pause threshold 90%), so this run was skipped; …".

For a synthetic pool, a run is held back only when every enabled member is over the threshold. The gate only reads the snapshot Agent Tank already has and never starts a refresh. It is a brake, not an accounting system. Each run also stays subject to the ordinary [per-run spend cap](./execution-safety.md#spend-caps), and v1 never escalates an agent run to another model.

## Run states

| State | Meaning |
| --- | --- |
| `queued` | Accepted; waiting for a worker |
| `deferred` | Held back by the cost gate; retried automatically |
| `running` | The report run is executing |
| `report_ready` | The report is stored; the autonomy mode is being applied |
| `awaiting_approval` | A `preview` report (or a held-back `auto` step) waits for Approve or Reject |
| `acting` | The acting step is running |
| `completed` | Finished: the report, and the acting step if any, are done |
| `failed` | The report or acting run failed; see the reason |
| `skipped` | Never ran: cost gate, disabled agent or schedule, or offboarded owner; see the reason |
| `rejected` | A `preview` run was rejected; the report is kept |
| `cancelled` | Cancelled by you |

**Cancel run** works in `queued`, `deferred`, `running`, `awaiting_approval` and `acting`, and stops the running task where there is one.

## Troubleshooting

- **A run is `skipped` or `deferred`.** Read the reason on the run. Usage reasons come from the [cost gate](#cost-control): wait for the window to reset, raise `agent_run_usage_pause_percent`, or use **Run now**. "The scheduled run was skipped: Agent is disabled" or "the schedule was turned off" means the definition changed after the slot was claimed.
- **`GITHUB_AUTHORIZATION_REQUIRED`.** A run with `propr_mcp`, or an acting step, failed with "ProPR MCP grant request failed (GITHUB_AUTHORIZATION_REQUIRED): The agent owner must sign in to ProPR to authorize GitHub access." The owner's stored GitHub authorization is missing or expired. Sign in to the Web UI again, then trigger a new run.
- **`MCP_DISABLED`.** The grant request failed because ProPR's MCP server is not enabled on this instance. An administrator enables it under **Settings → Integrations → MCP Server** (see [MCP](./mcp.md)). Until then, use `dry_run` agents without `propr_mcp`.
- **`SYSTEM_TASK_SECRET_MISSING` or "ProPR API unreachable".** The worker could not request the grant. `SYSTEM_TASK_SECRET` must be set, and identical, on the API and worker. The worker must reach the API at `PROPR_INTERNAL_API_URL` (default `http://api:4000`). Agent containers must reach the MCP endpoint at `PROPR_AGENT_MCP_URL`. See [execution safety](./execution-safety.md#agent-runs).
- **The schedule turned itself off.** When the owner is no longer an instance member, the daemon skips the slot and disables the agent's schedule. The definition and its history stay. A new owner has to recreate the agent: definitions cannot be transferred in v1.
- **The schedule cannot be evaluated.** A stored expression that no longer parses disables the schedule with that reason. Edit and save a valid one.
- **`REPOSITORY_FORBIDDEN` or a repository access error on trigger.** Your GitHub account, or the MCP grant you are using, lost access to one of the agent's repositories. MCP hides such agents from `list_agent_definitions`.
- **`AGENT_INVALID`.** The agent or model no longer exists, a repository is no longer enabled, or the agent does not support `propr_mcp` while the definition or its autonomy mode needs it. Edit the definition.
- **"The worker stopped before recording the result."** The run's task ended, but the worker died before storing the outcome. The daemon fails such runs 10 minutes later. Trigger a new run.
- **The agent used the web although `web` is off.** Antigravity, OpenCode and Vibe only receive a prompt instruction. Use Claude Code or Codex for enforcement.

## Deferred beyond v1

- Built-in event triggers (label watching, issue or PR events, push webhooks). Call the trigger from your own automation instead.
- Per-action-kind autonomy.
- Schedule time zones (schedules are UTC).
- Structured or typed actions parsed from reports.
- Sharing or transferring agents between users.
