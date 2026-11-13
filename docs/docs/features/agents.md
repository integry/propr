---
sidebar_label: "Automations"
title: "Schedule automations and recurring agent reports"
description: "Create reusable automations that run on demand or on a schedule to investigate repositories and produce reports."
---

# Automations


An **Automation** is a saved, reusable definition that runs on demand or on a schedule and produces a free-form report. Use one for recurring investigation: a weekly dependency review, a daily triage of new issues, a check of a competitor's changelog, a summary of what merged last week. Use a [task](./launching-work.md) for a single change and a [goal](./goals.md) for a continuing objective.

The UI, REST API, MCP tools and shared contract call these **Automations**. **Coding agents** (Claude Code, Codex and the other runtimes) execute them. The CLI drives automations with `propr automation`.

Every run follows the same path:

1. **Definition.** A name, a prompt with optional input files, repositories, an agent and model, capabilities, an optional schedule, an optional [event trigger](#event-trigger) and an autonomy mode.
2. **Isolated report run.** ProPR starts an ordinary task container for the run. The agent investigates and its final message becomes the report.
3. **Free-form report.** Markdown stored with the run, shown on the **Automations** page and available over the API, MCP and CLI.
4. **Optional acting step.** In `preview` or `auto` mode, a second, separate agent run reads the report and acts on it through ProPR's MCP tools (see [Acting on a report](#acting-on-a-report)).

What an Automation is **not**:

- **Not a new engine.** Report and acting runs are ordinary ProPR task executions with the same containers, spend caps, watchdog, logs and LLM Log entries as any other task.
- **Not a general event watcher.** The only built-in event is an [epic queue issue becoming blocked](#event-trigger). Automations do not watch labels, issues, pushes or webhooks. For those, use the schedule, or call the [trigger](#triggers) from your own automation (a GitHub Actions workflow, a webhook relay or a crontab).
- **Not structured actions.** ProPR never parses a report for actions. A report is text for a human. Acting on it is a separate agent run with a fixed tool set.

Automations are personal: every definition and run belongs to the user who created it. Another user's automation reads as "not found" on every surface.

## Create an automation

Open **Automations** in the sidebar and choose **New Automation** in the header. Fill in the form, or [start from a template](#templates), and choose **Create automation** at the bottom of the form (later edits use **Save changes** in the same place), then use **Run now** or the **Runs** tab. The REST API (`POST /api/automation-definitions`) accepts the same fields; `GET /api/automation-definitions/contract` and the MCP tool `get_automation_definition_contract` return the authoritative limits.

### Scope

**Repositories** (up to 10, `owner/repo`) are the repositories the agent may read and, in the acting step, act on. Every repository must be enabled in ProPR, and your GitHub account must be able to read it: ProPR checks your access when you save and every time a run is triggered. An automation may have no repositories at all, for example one that only researches the web and writes TODOs.

The first repository is the primary one: with `repository_read` it is checked out as the workspace. The others are shallow, read-only copies under `.propr/context/`.

### Prompt and input files

The **prompt** (up to 32,768 characters) is the standing instruction for every run. Write it like a brief for a colleague: what to look at, what matters, and what the report should contain.

**Input files** (up to 10) are attached to the definition and copied into `.propr/agent-inputs/` in every run's workspace. Use them for checklists, reference lists or report templates. Text files only; binary uploads are refused.

### Previous reports

**Previous reports** (0 to 5, default 0) feeds the newest earlier reports of the same automation into the next run. The prompt then tells the agent to compare with them and lead with what is new, changed or resolved. Use it for "what changed since last week" automations. Each previous report is cut to 10,000 characters (50,000 in total) with a visible `[truncated]` marker. If the prompt would still exceed its size limit, the oldest reports are left out and the prompt says so. Only runs that produced a report count: completed, rejected, awaiting-approval and acting runs, not failed or skipped ones.

### Agent and model

Choose a configured coding agent and a model it supports, or leave both empty to use the instance's default agent. A [synthetic pool](./synthetic-pools.md) works too. The choice is validated against the live agent configuration when you save and again at trigger time, so a run whose agent has since been removed is refused with `AGENT_INVALID` instead of running with a different one.

### Capabilities

Each capability can be switched on or off separately. The default is `repository_read` only.

| Capability | Effect | Claude Code | Codex | Antigravity, OpenCode, Vibe |
| --- | --- | --- | --- | --- |
| `repository_read` | Checks out the repositories and gives the container a read-only GitHub token. Off: the workspace is an empty git directory with only the input files. No clone is mounted and no repository token is issued. | Enforced by ProPR | Enforced by ProPR | Enforced by ProPR |
| `web` | Allows web search and fetching URLs. | Enforced natively (`WebFetch`, `WebSearch` disallowed when off) | Enforced natively (`web_search` disabled when off) | **Best effort**: the prompt tells the agent not to use the web, but the runtime has no switch to enforce it |
| `propr_mcp` | Mounts ProPR's MCP server in the report run with a read-only grant, so the agent can read tasks, PRs, TODOs and docs. | Supported | Supported | **Not supported**: saving such a definition is refused |
| `merge` | Adds the `merge` MCP scope to the acting step's grant, so the acting agent may merge pull requests through `merge_pull_request`. Off (the default): the acting step is told it must never merge and holds no merge scope. Has no effect on the report step or on `dry_run` automations. | Supported | Supported | **Not supported**: the acting step needs ProPR tools |

The acting step of `preview` and `auto` automations always uses ProPR's MCP server, so those modes also require Claude Code or Codex (or a synthetic pool whose enabled members all support it). `web` in the acting step follows the definition.

If web access must be blocked, choose Claude Code or Codex. For the other runtimes, have an administrator enforce [restricted network mode](./execution-safety.md#restricted-network-mode): agent runs then reach only the allowlisted hosts (Antigravity runs are refused). Agent runs follow restricted mode only when the instance enforces it.

### Schedule

**Schedule** is off by default: the automation then runs only when triggered. To run it automatically, enter a standard 5-field cron expression (`minute hour day-of-month month day-of-week`) or pick a preset:

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
- The form previews the next run time, and the automation list shows each schedule with when it fires next. Automations without a schedule show **Manual**.
- Each slot fires once, even with several daemons. If the daemon was down across several slots, they coalesce into one run for the latest slot; missed slots are not replayed.
- Scheduled runs are [cost-gated](#cost-control).

Setting **Schedule** back to **Off** stops scheduled runs; the automation can still be triggered. A definition disabled through the API (`"enabled": false` on `PATCH /api/automation-definitions/:id`) also refuses every trigger with `AGENT_DISABLED`. Neither deletes the definition or its history.

### Event trigger

**Event trigger** is off by default, and no automation reacts to an event unless you turn it on. Set it to **Plan issue blocked** to run the automation once each time an issue in an [epic plan's execution queue](./planning.md) becomes blocked, for example to start Ultrafix, create a replacement task or escalate instead of leaving the queue stopped.

- The automation must name its repositories. It only reacts to plans in those repositories. You can limit it further to some of them, and to some blocker reasons (`closed_unmerged`, `missing_from_plan`, `dispatch_failed`, `agent_blocked`, `awaiting_human_merge`, `label_handoff`, `setup_not_ready`). Nothing checked means all of them. If you remove every repository the trigger was limited to from the automation, the editor will not save until you choose its repositories again (or choose all of them) or turn the trigger off, so the trigger never silently widens to the remaining repositories.
- **One run per event.** Each blocked event starts at most one run of each subscribed automation, including after a restart or a repeated delivery. The daemon reads the durable blocked-event log with a cursor per automation, about once a minute. An event that has not started a run yet is matched against the automation as saved when its run is recorded, so narrowing the repositories or the reasons stops it from starting.
- **No backlog.** Events from before you subscribed, and events from while the automation was disabled, are never run later. A run that was already recorded but could not be queued (for example while the job queue was down) is still queued later, even if you disable and re-enable the automation in between.
- **The event is the run's input.** The report step and the acting step get the event as data: `repository`, `planId` and `planName`, `executionId`, `issueNumber`, `reasonKind` and `reason`, `planUrl` and `issueUrl`, `eventId` and `occurredAt`. The run detail and `propr automation runs` show which event started a run.
- **Unattended, like a schedule.** An event run is [cost-gated](#cost-control) and uses the automation's autonomy mode, capabilities and grants. An event never widens what the automation may do: a `dry_run` automation still only reports, and a `preview` one still waits for your approval.
- **Loop protection.** An automation runs at most **3 times for the same issue of the same plan**. If its own actions keep blocking that issue again, later blocked events for it are recorded as `skipped` runs with the reason "loop protection", and nothing else starts.

A minimal recovery automation, as the `POST /api/automation-definitions` body:

```json
{
  "name": "Recover blocked epic issues",
  "prompt": "An epic queue issue is blocked; the trigger event has the details. Read the issue and the blocker reason. If a fresh attempt is likely to succeed, recommend a replacement task with a sharper description; otherwise recommend escalating to a person and explain why.",
  "repositories": ["acme/app"],
  "capabilities": ["repository_read", "propr_mcp"],
  "autonomy": "preview",
  "eventTriggers": [{ "event": "plan.issue_blocked", "reasonKinds": ["agent_blocked", "dispatch_failed"] }]
}
```

### Autonomy

The autonomy mode decides what happens after the report is stored:

| Mode | After the report |
| --- | --- |
| `dry_run` (default) | Nothing. The report is the whole result and the run completes. |
| `preview` | The run waits in **Awaiting approval** and you get an Inbox notification. **Approve and act** (with an optional note for the acting agent) starts the acting step. **Reject** ends the run and keeps the report. |
| `auto` | The acting step starts straight away, subject to the [cost gate](#cost-control). |

The mode is captured when a run is queued. Editing the definition later does not change a run that already exists.

## Templates

ProPR ships a small catalog of automation templates for common recurring jobs. A template fills in the new-automation form. It creates nothing: the automation exists only once you choose **Create automation**.

- On the **Automations** page, open **New Automation** and choose a card under **Start from a template**. When you have no automations yet, the empty list shows the same templates; choosing one opens the form already filled in.
- The template sets the name, description, prompt, capabilities, a suggested schedule and the number of previous reports. Repositories you already picked and the coding agent stay as they are.
- Every template starts in `dry_run` (**Dry run**), so its runs only write a report. To have an agent act on the report, raise the [autonomy](#autonomy) mode yourself before saving.
- A **Review before saving** note lists what the template cannot choose for you, at least the repositories, the schedule and the autonomy mode.

| Template | What the report contains | Suggested schedule |
| --- | --- | --- |
| **Daily issue triage** (`daily-issue-triage`) | Issues that need a human today, likely duplicates (including repeats of recently closed issues), proposed severity labels, proposed security labels and stale issues with a suggested next step. It only reads issues and never comments on, labels or closes them. | `0 7 * * 1-5` (weekdays at 07:00 UTC), with the previous report included so each run focuses on what changed |
| **Instruction learning loop** (`instruction-learning-loop`) | Candidate rules from review corrections that repeat across pull requests, each with proposed wording, a target instruction file and links to at least two pull requests; existing instructions that look stale or contradicted, as removal candidates; and the size of the instruction files, with a warning when they grow too long. | `0 8 * * 1` (Mondays at 08:00 UTC), with the previous report included so candidates are not proposed twice |
| **Weekly codebase drift report** (`weekly-codebase-drift-report`) | The last 7 days of merged changes: what changed and why, grouped by area; newly added functions or modules that appear to duplicate existing ones, each with both locations, listed only after both were read; lines and files added and removed per top-level area and the largest new files; and a short list of suggested consolidations. With autonomy raised, the acting step saves the consolidations as repository To-Dos. See [Repository Knowledge](./repository-knowledge.md#weekly-codebase-drift-report). | `0 9 * * 1` (Mondays at 09:00 UTC), with the previous report included so pairs are not listed twice |

The triage template needs `repository_read`, which gives the run a read-only GitHub token for the repositories in scope. With `preview` or `auto`, the acting step can turn the report into TODOs, tasks or plans through ProPR's MCP tools (see [Acting on a report](#acting-on-a-report)).

### Instruction learning loop

The same correction often gets made in review after review: "use the shared helper", "add a migration test", "do not log the token". The **Instruction learning loop** template turns those repeats into proposed instructions, so the next run gets them right the first time.

Each week the run reads the repository's agent instructions (`AGENTS.md`, `.propr/instructions.md` and the file named by `instructions` in [`.propr/workflow.yml`](./repository-workflow.md#instructions-and-validation)) and the last 30 days of pull request discussions through ProPR's MCP tools (`list_pull_requests`, `get_pull_request_discussion`, `list_tasks` and `get_task_events`). For each pull request it pages through the conversation, the submitted reviews and the inline review comments, because most human review corrections are made on specific lines rather than in the conversation. It needs `repository_read` and `propr_mcp`, so it runs on Claude Code or Codex. Its report lists:

- **Candidate rules**: the proposed wording in one or two sentences, the target file, and links to at least two distinct pull requests where the same correction was made. A correction seen in a single pull request, or a one-off preference, is never proposed.
- **Removal candidates**: existing instructions that look stale or that recent merged work contradicts.
- **Instruction file size**: each file and the total, with a warning above 300 lines or 20,000 characters, because long instructions crowd out the task.
- **Proposed task**: a ready-to-use task body with the changes and their citations.

Pull request text is treated as untrusted data: the run never follows instructions found in it, and never proposes a rule whose only source is text asking for that rule.

Instruction changes always go through a reviewed pull request. Instructions steer every later run in the repository, so a bad rule learned from a misread review, or one planted in a pull request comment, would repeat its mistake on every task. The template starts in `dry_run`, so a run only writes the report. With `preview` (recommended) or `auto`, the acting step creates one ProPR task per repository whose body carries the proposed changes and their citations. The acting step cannot edit files itself; the task opens a pull request, and a maintainer reviews and merges it like any other change.

The catalog is also available outside the UI: `GET /api/automation-definitions/templates`, the MCP read tool `list_automation_templates` and `propr automation templates` (add `--json` for the versioned document). Each entry has an `id`, `name`, `description`, `category`, `prompt`, `capabilities`, `schedule`, `autonomy`, `previousReportCount` and `reviewBeforeSaving`, and the document carries a catalog `version`. To start an automation from a template through the API, send its fields to `POST /api/automation-definitions` together with your own `repositories`.

Templates live in `packages/shared/automation-templates/<id>/` (`template.json` plus `prompt.md`). `npm run automation-templates:generate` builds `packages/shared/src/automationTemplates.catalog.json`, and CI checks that the committed catalog is current and that every template satisfies the automation definition contract and defaults to `dry_run`.

## Triggers

Every run goes through one trigger primitive, whatever started it. The run history records which:

| Trigger | Started by | Cost-gated |
| --- | --- | --- |
| `manual` | **Run now** on the Automations page | No (you see a capacity warning instead) |
| `schedule` | The daemon, from the definition's schedule | Yes |
| `api` | `POST /api/automation-definitions/:id/runs` from a script or service | Yes |
| `cli` | `propr automation run` | Yes |
| `mcp` | The MCP tool `trigger_automation_run` | Yes |
| `event` | The daemon, from a subscribed [event](#event-trigger); the run records the event | Yes |

All non-UI triggers take an **idempotency key**. The same key for the same automation always returns the first run (`created: false`) instead of starting another one, so retries are safe. Use a value that identifies the event, such as the CI run id or the date, not a random value generated on every attempt.

### Run now

On the automation's page, **Run now** starts a run immediately. If Agent Tank reports the agent's provider at or above the [pause threshold](#cost-control), the button first asks you to confirm. Run now is never deferred or skipped: you are watching it.

### HTTP

```bash
curl -sS -X POST "https://propr.example.com/api/automation-definitions/$AUTOMATION_ID/runs" \
  -H "Authorization: Bearer $PROPR_GITHUB_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: nightly-$(date -u +%F)" \
  -d '{"source": "nightly cron on build-01"}'
```

Authenticate with the same GitHub token the [CLI](./propr-cli.md#connect-and-authenticate) accepts (`repo` and `read:org` scopes) for a user on the instance's allowlist. The run belongs to, and acts as, the automation's owner, so use the owner's token. The body is optional:

- `source` (up to 255 characters) is a free-form label shown in the run history. It defaults to `user:<you>`.
- `trigger` is `api` (the default for token requests) or `cli`.

The `Idempotency-Key` header is optional and up to 255 characters. A new run answers `202` and a replayed key answers `200`. Both return `{ "run": { ... }, "created": true|false }`. The run's `state` is `queued`, or `deferred`/`skipped` with the reason in `error` when the cost gate held it back.

Follow the run with `GET /api/automation-runs/:runId`. It is finished when `state` is `completed`, `failed`, `skipped`, `rejected` or `cancelled`. `report` holds the Markdown.

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
      - name: Run the automation
        run: |
          propr automation run "${{ vars.PROPR_AUTOMATION_ID }}" \
            --idempotency-key "gha-${{ github.run_id }}-${{ github.run_attempt }}" \
            --source "github-actions: ${{ github.workflow }}" \
            --wait --timeout 3600 > report.md
      - uses: actions/upload-artifact@v4
        with:
          name: automation-report
          path: report.md
```

`--wait` exits `0` when the run completed, `3` when it was skipped or deferred, `4` when it awaits approval, `2` on timeout (the run keeps going) and `1` otherwise. See [the CLI reference](./propr-cli.md#agents-saved-automations).

`PROPR_GITHUB_TOKEN` is a personal access token of the automation's owner. The workflow's own `GITHUB_TOKEN` is not a user token and is refused.

### Crontab

Use the schedule unless you need a time zone or a host that is not ProPR. If you do, this crontab line runs the automation at 08:30 local time on weekdays and keeps one run per day even if cron fires twice:

```cron
30 8 * * 1-5  propr automation run 3f0c1d9e-1d2b-4c55-9a51-6e2f8f1a7b10 --idempotency-key "host-cron-$(date +\%F)" --source "crontab on build-01" >> /var/log/propr-automation.log 2>&1
```

Cron needs `%` escaped as `\%`. Run `propr remote` and `propr login` once for the user whose crontab it is.

### MCP

From a chat client connected to ProPR's [MCP server](./mcp.md) with `execute` scope:

```json
{
  "name": "trigger_automation_run",
  "arguments": {
    "definitionId": "3f0c1d9e-1d2b-4c55-9a51-6e2f8f1a7b10",
    "source": "chat: weekly competitor check",
    "idempotencyKey": "competitor-scan-2026-10-07"
  }
}
```

The receipt returns the `runId` and its `state`. Follow it with `get_operation`, or read the report with `get_automation_run` once it is ready. In practice you ask the chat client "run my competitor check automation", and it finds the automation with `list_automation_definitions` and calls the tool.

## Reports

A report is the agent's final message, as Markdown. Open a run from the automation's **Runs** list to see:

- the state, trigger, source, timing and any skip or failure reason;
- the report, rendered as Markdown;
- for `preview` and `auto` runs, the acting step's summary of what it did, with the links and ids its tools returned;
- links to the report and acting tasks, with their full logs, prompts and costs.

Limits and truncation:

- A stored report is at most 100,000 characters. A longer final message is cut with a `[truncated]` marker. The full output stays in the report task's execution logs.
- The acting step's summary is cut at 20,000 characters the same way.
- MCP's `get_automation_run` keeps the whole run under the 256 KiB tool result limit. It returns at most 200 KB of report, less when the action summary and the rest of the run need the room, and sets `reportTruncated: true` when it cuts the report. Any other text it cuts, such as the action summary, carries its own flag (`actionSummaryTruncated: true`). The full run is at its `url`.
- The CLI's `propr automation report <run-id>` prints the stored Markdown to stdout.

Report text is agent output. ProPR never treats it as instructions. The acting step receives it fenced as data, with instructions to ignore anything inside it that tries to change its rules.

## Acting on a report

In `preview` (after approval) and `auto` mode, ProPR starts a second agent run, the **acting step**. Its input is the report, the definition's prompt for context, and the approver's note if there is one. Its only means of acting is ProPR's MCP server, through a grant that ProPR issues for that step alone.

The acting agent **can**, within the automation's repositories:

- create tasks, plans and goals, TODOs and pull request comments;
- add or remove plain pull request labels with `update_pull_request_labels`, for example the instance's trigger label that hands a PR to ProPR (managed `llm-*` and `ultrafix` labels stay with their own tools);
- request a ProPR review with `review_pull_request`, and run `fix_review_findings`, `run_ultrafix` or `start_ultrafix` on a pull request;
- approve the CI runs of a pull request from a fork or a first-time contributor with `approve_pull_request_workflow_runs`, after reading its diff. The tool approves only the head the agent examined and refuses a pull request that changes workflow or action definitions under `.github`, which a person must approve in GitHub;
- close a pull request that should not proceed at all (a duplicate, out of scope, invalid or harmful) with `close_pull_request`, which posts the reason as a comment first and closes only the head the agent examined;
- read anything a `read` grant can (tasks, PRs, TODOs, docs);
- with the `merge` capability, merge a pull request with `merge_pull_request`. The tool still requires the exact head the agent examined, passing checks and satisfied review and protection rules, and the prompt limits merges to pull requests the report shows are ready.

It receives the `read`, `plan`, `execute` and `review` MCP scopes, plus `merge` when the capability is on, limited to the definition's repositories, to what the owner can access and to the instance's MCP scope ceiling. Each creating call carries an idempotency key derived from the run id, so a retried acting step does not create duplicates. The prompt also tells it to check for existing tasks and TODOs before creating new ones.

The acting agent **cannot**:

- deploy, publish, or change settings or configuration (no `deploy`, `publish` or `manage` scope), nor merge without the `merge` capability;
- touch repositories outside the definition;
- edit files, commit, push or open pull requests itself (its workspace is never committed; changes go through the tasks it creates);
- trigger, approve or reject automation runs: those tools refuse every agent-issued grant with `AGENT_RECURSION_FORBIDDEN`, so coding agents cannot start other automations.

An automation without repositories can only create TODOs.

Only one autonomy mode applies to every action. Per-action-kind autonomy (for example "create TODOs automatically, but ask before starting tasks") is deferred beyond v1.

## Runs that change nothing

A scheduled automation can finish every night with an empty report, the same report as last time, or an acting step that did nothing. Such runs still end as `completed`, but ProPR flags them:

- **Report novelty.** When a report is stored, ProPR saves a SHA-256 hash of its normalised text (`reportHash`: whitespace collapsed; dates, times, weekdays, relative times like "3 hours ago" and the ids of this automation's runs replaced; other ids, such as an incident or task id the report names, are kept, so a report about a different one is `new`) and compares it with the previous reported run of the same automation: the report stored most recently, even when that run was created later than this one or its acting step failed afterwards. `reportNovelty` is `new`, `unchanged` (same hash) or `empty` (fewer than 40 characters after normalisation).
- **Acting-step changes.** When the acting step ends, ProPR counts the mutating MCP operations its grant performed before revoking the grant, and stores the count as `actingMutations`. Calls that definitely failed are not counted. `0` marks a no-op acting step. If the count cannot be read, it stays `null`, which is not treated as a no-op.

A run is shown as **No change** in the run history and run detail when its report is `empty` or `unchanged`, or its acting step changed nothing. An acting step that changed something counts as productive whatever its report said. The REST run payload, MCP `get_automation_run` and `list_automation_runs`, and the CLI (`propr automation runs`, `propr automation report`) also carry the flags, plus a derived `noChangeReason` (`empty_report`, `unchanged_report`, `no_op_action` or `null`). Runs recorded before this version have `null` flags.

**Streak notification.** After 3 consecutive unproductive **scheduled** runs, the owner gets one Inbox notification naming the automation. It is not repeated while the streak continues; the next productive scheduled run resets it. If the notification cannot be saved, the next unproductive scheduled run tries again. A run waiting for approval is not counted until its acting step finishes, or it is rejected or cancelled; cancelling a run counts it at once, unless its acting step is still running, in which case it counts once that step has stopped. Manual and other non-scheduled runs are flagged but neither count toward the streak nor reset it. Change the number with the instance setting `automation_unproductive_run_threshold` (1–50, default 3), for example `propr setting update automation_unproductive_run_threshold 5` or MCP `update_execution_settings`. It is not in the Settings UI.

**Pausing the schedule.** Turn on **Pause the schedule when scheduled runs keep producing no change** under the automation's schedule (`pauseWhenUnproductive: true` over the API) to have ProPR turn the schedule off when the notification fires. Like other automatic schedule disables, this counts as an edit and drops any pending scheduled slot, and ProPR logs the reason. The notification itself says the automation is set to pause, not that it was paused, because it is saved before the schedule is changed and stays as it was saved. Once the schedule has actually been turned off, a second Inbox item (without a push) says it was paused; you get none if pausing was turned off, or the streak ended, first. If the schedule could not be turned off after the notification was saved, the next unproductive scheduled run of the streak turns it off. Once it is off, turning it back on is respected: later runs of the same streak do not pause it again. Turning the option off before the schedule is changed is respected too, even while the notification is being sent, and so is a newer scheduled run that finishes with a change in that time: it ends the streak, and the schedule stays on. It is off by default. Turn the schedule back on once the prompt is fixed.

## Cost control

Unattended runs (`schedule`, `event`, `api`, `cli`, `mcp`) start while nobody is watching. Before one is queued, before a deferred run is retried and before an `auto` acting step starts, ProPR compares the provider's subscription usage from [Agent Tank](../operations/agent-tank.md) with the instance's **pause threshold**.

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

For a synthetic pool, a run is held back only when every enabled member is over the threshold. The gate only reads the snapshot Agent Tank already has and never starts a refresh. It is a brake, not an accounting system. Each run also stays subject to the ordinary [per-run spend cap](./execution-safety.md#spend-caps), and v1 never escalates an automation run to another model.

Scheduled runs can also be paused by [token-outlier alerts](../operations/metrics.md#token-outlier-alerts): with `token_outlier_pause_alerts` set (off by default), a `schedule` run of an agent whose repository raised that many alerts within `token_outlier_pause_window_hours` is **skipped** with the reason. Other triggers are not paused.

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
| `skipped` | Never ran: cost gate, disabled automation or schedule, offboarded owner, or the event trigger's loop protection; see the reason |
| `rejected` | A `preview` run was rejected; the report is kept |
| `cancelled` | Cancelled by you |

**Cancel run** works in `queued`, `deferred`, `running`, `awaiting_approval` and `acting`, and stops the running task where there is one.

## Troubleshooting

- **A run is `skipped` or `deferred`.** Read the reason on the run. Usage reasons come from the [cost gate](#cost-control): wait for the window to reset, raise `agent_run_usage_pause_percent`, or use **Run now**. "The scheduled run was skipped: Automation is disabled" or "the schedule was turned off" means the definition changed after the slot was claimed.
- **An event run is `skipped` with "loop protection".** The automation already ran 3 times for that issue of that plan. Resolve the issue by hand, or retry or skip it from Planner Studio.
- **A blocked issue started no run.** Check that the automation is enabled, that the event trigger is on, that the plan's repository is one of the automation's (and of the trigger's filter), and that the blocker reason is allowed by the filter. Events from while the automation was disabled are not run later.
- **`GITHUB_AUTHORIZATION_REQUIRED`.** A run with `propr_mcp`, or an acting step, failed with "ProPR MCP grant request failed (GITHUB_AUTHORIZATION_REQUIRED): The agent owner must sign in to ProPR to authorize GitHub access." The owner's stored GitHub authorization is missing or expired. Sign in to the Web UI again, then trigger a new run.
- **`MCP_DISABLED`.** The grant request failed because ProPR's MCP server is not enabled on this instance. An administrator enables it under **Settings → Integrations & MCP → MCP Server** (see [MCP](./mcp.md)). Until then, use `dry_run` automations without `propr_mcp`.
- **`SYSTEM_TASK_SECRET_MISSING` or "ProPR API unreachable".** The worker could not request the grant. `SYSTEM_TASK_SECRET` must be set, and identical, on the API and worker. The worker must reach the API at `PROPR_INTERNAL_API_URL` (default `http://api:4000`). Agent containers must reach the MCP endpoint at `PROPR_AGENT_MCP_URL`. See [execution safety](./execution-safety.md#agent-runs).
- **The report says the `propr` MCP tools were unavailable.** The grant was issued but the agent container never reached the MCP endpoint; the worker log carries "Agent run MCP grant ended without a single recorded call" with the URL and Docker network it used. A container with a grant joins the worker's Compose network so the default `http://api:4000/api/mcp` resolves. If the worker runs outside Compose, set `PROPR_AGENT_DOCKER_NETWORK` to the API's network, or point `PROPR_AGENT_MCP_URL` at an address the default bridge can reach.
- **The schedule turned itself off after an Inbox item about runs with no change.** The automation has **Pause the schedule when scheduled runs keep producing no change** turned on, and its last scheduled runs produced nothing new (see [Runs that change nothing](#runs-that-change-nothing)). Review the prompt, then turn the schedule back on.
- **The schedule turned itself off.** When the owner is no longer an instance member, the daemon skips the slot and disables the automation's schedule. The definition and its history stay. A new owner has to recreate the automation: definitions cannot be transferred in v1.
- **The schedule cannot be evaluated.** A stored expression that no longer parses disables the schedule with that reason. Edit and save a valid one.
- **`REPOSITORY_FORBIDDEN` or a repository access error on trigger.** Your GitHub account, or the MCP grant you are using, lost access to one of the automation's repositories. MCP hides such automations from `list_automation_definitions`.
- **`AGENT_INVALID`.** The agent or model no longer exists, a repository is no longer enabled, or the agent does not support `propr_mcp` while the definition or its autonomy mode needs it. Edit the definition.
- **"The worker stopped before recording the result."** The run's task ended, but the worker died before storing the outcome. The daemon fails such runs 10 minutes later. Trigger a new run.
- **The agent used the web although `web` is off.** Antigravity, OpenCode and Vibe only receive a prompt instruction. Use Claude Code or Codex for enforcement.
- **The acting step says it is not allowed to merge.** That is the default: merging needs the `merge` capability on the definition. If the capability is on and the step still cannot merge, the worker log carries "Automation has the merge capability, but the MCP grant was issued without the merge scope": the instance's MCP scope ceiling (**Settings → Integrations & MCP → MCP Server**) excludes `merge`.
- **The acting step says it cannot request a review or approve CI runs.** Acting grants carry the `review` scope, and the `approve_pull_request_workflow_runs` tool exists, from this version on; an older API issues neither, so upgrade the API and worker together. The instance's MCP scope ceiling may also exclude `review`. CI approval is refused with `CI_CONFIGURATION_CHANGED` when the pull request changes workflow files: approve those in GitHub after reading them.

## Deferred beyond v1

- Other built-in event triggers (label watching, issue or PR events, push webhooks), and goals reacting to plan events. Call the trigger from your own automation instead.
- Per-action-kind autonomy.
- Schedule time zones (schedules are UTC).
- Structured or typed actions parsed from reports.
- Sharing or transferring automations between users.

## Naming and compatibility

Use `list_automation_definitions`, `get_automation_definition`,
`get_automation_definition_contract`, `list_automation_templates`, `list_automation_runs`, `get_automation_run`,
`trigger_automation_run`, `approve_automation_run` and `reject_automation_run`.
Their former `*_agent_*` names remain callable as deprecated aliases with the
same scopes, repository authorization, recursion guard and input schemas.
Canonical mutation receipts use `continuation.automationRunId`; `get_operation`
uses `targetState.automationRunId` for those receipts. Legacy calls and stored
legacy operations retain `agentRunId`. A trigger retried across the two names
with the same arguments and idempotency key returns the original receipt
(including its original field names) and still creates only one run.

REST clients use `/api/automation-definitions` and `/api/automation-runs`;
`/api/agent-definitions` and `/api/agent-runs` remain deprecated aliases with the
same request and response shapes. Shared clients use `AutomationDefinition`,
`AutomationDefinitionInput`, `AutomationRun`, and `AUTOMATION_DEFINITION_CONTRACT`
from `@propr/shared`; the old exports remain deprecated compatibility aliases.
`AutomationRun.automationDefinitionId` replaces the legacy shared type's
`agentDefinitionId`; REST and MCP run records continue to use `definitionId`.

The configured execution backend still uses `agentId`, `agentAlias`, and
`proprMcpAgentTypes` (`claude`, `codex`): these identify coding agents, not
saved automations. Persisted database tables, queue identifiers, settings,
internal worker grant endpoints and existing error codes keep their wire names
so upgrades do not invalidate stored runs or workers.

### Upgrade order

Upgrade the backend to a release that serves `/api/automation-definitions` and
`/api/automation-runs` before upgrading `propr-cli` or using Automations in the
hosted UI against a local stack through the tunnel. These clients use only the
new paths for definitions, input files, capacity, runs and run decisions; they
do not fall back to the legacy paths. An older backend returns 404 even when the
automation exists, and the CLI may report "Automation not found". Upgrade the
local stack to resolve this; CLI users can keep their previous CLI version until
then. Server-side aliases support older clients on newer backends, not newer
clients on older backends.

### MCP alias retirement plan

All eight deprecated `*_agent_*` tools remain callable and discoverable in this
release. MCP clients should migrate discovery and calls to the canonical
`*_automation_*` names now; hosts with tool-count limits should select those
canonical tools when configuring their allowed tools.

Plan retirement for a future breaking release: announce the target release and
migration instructions at least one stable release in advance, then remove the
eight aliases from `tools/list` while keeping direct calls working for one more
stable release. Remove callable aliases only in a subsequent breaking release.
No retirement version is assigned yet, and this rename does not hide aliases.
Legacy stored operation receipts keep their original field names throughout
this migration.

Instance administrators can also manage reusable [agent extension profiles](./agent-extensions.md) for selected Claude and Codex task runs, with explicitly authorized MCP tools and immutable skill bundles.

## Next steps

- [Instance agent extensions](/docs/features/agent-extensions)
- [Run ProPR From Your Chat Assistant](/docs/features/mcp-chat)
