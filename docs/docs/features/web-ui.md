# Web UI Guide

The ProPR Web UI is where you configure repositories and agents, plan and launch work, watch tasks run, and review costs and capacity. It is the same surface used in the [live demo](https://demo.propr.dev) and runs on port `5173` by default (open it with `propr ui`).

This page is a tour of what each screen does. For how the UI is wired to the backend — ports, OAuth, WebSockets, deployment — see the [Web UI Integration Guide](../operations/web-ui-integration.md). For the terminal equivalent of most of these actions, see the [ProPR CLI](./propr-cli.md).

## Navigation And Chrome

Two persistent elements frame every page.

**Sidebar (left).** The primary navigation: **Dashboard**, **Plans**, **Tasks**, **Repositories**, **Coding Agents**, **Analytics**, **LLM Log**, and **Settings**. Tasks and Plans show live count badges, and an amber dot flags setup gaps (no repositories, no agents, or no tasks yet). Below the navigation, the [Agent Tank](../operations/agent-tank.md) usage section shows live per-provider capacity bars when the integration is enabled. The footer shows the running version and copyright.

**Header (top).** A global **search** (focus with `Cmd/Ctrl+K`) spans tasks, plans, and repositories. To its right: an **AI activity monitor** (how many tasks are running now), an **active plans** dropdown, a **tasks awaiting review** dropdown grouped by repo/PR/issue, a **quick add to-do** popover (`Alt+T`), a **New Plan** button, a **system health** indicator that opens a status modal (daemon, workers, Redis, GitHub auth, indexing, and per-agent health), and your GitHub profile with sign-out.

**Voice briefing (lower right).** The on-demand control fetches a text snapshot of parallel or long-running work and can ask the browser to speak it. It does not keep a call or background listener open. Spoken commands use a fixed grammar, and stop or follow-up actions require a separate confirmation. See [Voice Briefings](./voice-briefings.md) for the command reference, privacy boundary, costs, and mobile limitations.

When the backend runs with `PROPR_DEMO_MODE=true`, a banner indicates read-only access and all mutating actions are disabled. The synthetic demo identity has member-level operational access; installation-only Settings, Coding Agents, trusted-runtime, and Access controls are hidden.

{/* SCREENSHOT PLACEHOLDER (P1): Capture the full app shell — left sidebar (nav + Agent Tank usage + version footer) and the global header (search, activity monitor, New Plan, system health, profile) — with the Dashboard behind it. */}

## Dashboard

The landing page (`/`) answers "what needs my attention right now" in four panes under a single 36px toolbar. The toolbar carries only the page name on the left and the repository filter on the right — the same filtering pattern as Plans, Goals, and Tasks — and the panes attach directly to its bottom rule. There is no separate row of counts: the pane headings and the queue summary already show them.

1. **Needs attention** — the three newest blockers and pending decisions — including runs that failed and were not recovered — each with its reason, repository and issue/PR reference, how long it has been waiting, and one primary action. The action is a single fixed-width verb (`Open` or `Review`) so every button in the column shares one left edge; what is being opened or reviewed is named in the button's accessible label. With nothing to attend to, the panel leaves the desktop layout entirely and mobile shows a single quiet line.
2. **Happening now** — compact rows for work in flight, newest first, with elapsed time and a live sub-phase line on every row. The line is the agent's current plan step, or else its latest action (`Editing Dashboard.tsx`, `Running npm test`), or else the setup or publishing phase. At the end of the line are the step count from the agent's own plan (`step 3/7`) and when it last produced output (`last output 18 mins ago`), so a quiet run shows up without a spinner and without being labelled stalled. Five rows expand inline to the rest, ordering stays stable while tasks run (new work appears on top), and a compact queue summary below says how much is waiting and why when the backend knows.
3. **Completed** — a flat feed of finished work, newest first, with a title filter in its header. Failures are listed under Needs attention instead, and cancelled or skipped runs are not listed. A row shows what the run produced when it recorded something ("2 issues found: …" for a review), never a bare "completed successfully". Only reviews carry a score, drawn as the fixed-width quality pill (`[ ● 9 ]`, `[ ◆ 7 ]`); the out-of-ten scale is announced to assistive technology rather than printed as `/10`, which would put variable-width glyphs outside the badge and make the right rail shift between rows.
4. **Historical stats** — Completed, Success rate, and Recorded spend over seven or thirty days, plus a small daily-completions chart that marks only the day still in progress. Data the instance cannot report renders as "—", never as zero.

Wherever a row shows a task title, the task type (`Issue`, `Fix`, `Review`, `Follow-up`…) is drawn as a badge in front of it, and the title itself drops the type prefix, the PR number and the model tag the run was queued with.

The dashboard is a split-pane console rather than a set of cards. No section draws its own box: the two columns are separated by one continuous vertical rule that runs the full height of the canvas, sub-sections are separated by edge-to-edge horizontal rules, and every pane header is the same height so the rules in the two columns land on the same pixel. Technical entities (repository names, issue and PR references) are monospace chips that always name their type, with the repository drawn without its owner — the filter above the console already establishes the workspace, and one screen must not spell the same repository two ways, and colour is reserved for work in progress, blockers and failures — completed and merged work stays neutral.

A single repository filter applies to every section and is kept in the URL, so it survives navigation and a reload. The sections refresh live over WebSocket; if the connection drops, the last known rows stay on screen until it returns, without a status line reporting on the socket. New instances also surface an onboarding widget and, when ProPR detects a running Agent Tank, a banner offering to enable it.

**Analytics** (`/analytics`) holds the fuller reporting view — daily activity, task status distribution, the Repository Breakdown, and Top Models — because the dashboard benefits more from space for ongoing work. For where each number comes from and how to read it, see [Metrics](../operations/metrics.md).

## Plans And Planner Studio

**Plans** (`/plans`) lists every plan draft with repository, status, and timestamps, filterable by repository and status. **New Plan** opens **Planner Studio**, the guided flow for turning an idea or selected issues/PRs into a reviewed, executable plan:

- a setup stage (title, repository and branch, agent, context repositories, context level, granularity, file selection, and a cost preview);
- AI generation with live progress;
- a plan editor where you reorder, expand, refine through chat, and approve or revise items;
- finalization into GitHub issues you can implement.

Planner Studio is covered step by step in the [Planner Studio tutorial](../tutorials/planner-studio.md); see also [Planning](./planning.md).

## Tasks

**Tasks** (`/tasks`) is the execution history, with status, repository, and search filters and live updates. Selecting a task opens the **task detail** view:

- a context strip with repository, model, PR link, commit, duration, cost, and (with Agent Tank) usage deltas;
- the exact prompt and execution log files;
- a live event log, a thinking log where the agent emits one, and per-file diffs as they change;
- a progress bar over the agent's to-do list;
- actions to **Follow Up**, **Stop**, and **Delete**.

These records are the heart of ProPR's observability — see [Observability And Control](./observability.md). To undo a committed change, the **Revert** flow (`/revert`) previews the target commit and the resulting HEAD before running a signed revert.

## Repositories

**Repositories** (`/repositories`) manages the repos ProPR monitors — add, alias, set a base branch, enable/disable, configure [visual previews](./visual-previews.md), reindex, hide, or delete. Visual preview controls select image/video evidence and optional capture instructions for each repository. The selected repository opens a panel with four tabs:

- **Chat** — converse with the indexed repository;
- **Improve** — generate categorized improvement suggestions;
- **Browse** — the file tree with AI-generated summaries (also reachable at `/summaries`);
- **To-dos** — the repository's to-do list by category (the header's quick-add writes here).

See [Repository Knowledge](./repository-knowledge.md) and [Branch Configuration](./branch-config.md) for what indexing and branch settings drive.

## Coding Agents

**Coding Agents** (`/ai-agents`) is an administrator-only split view: configure agent aliases and their models on one side, and a **playground** to test an agent interactively on the other. When adding Claude, Codex, Antigravity, or OpenCode, choose a new-account login or reuse an existing config. New-account login creates an isolated ProPR-managed credential directory, so multiple accounts of the same provider can coexist without entering host paths. The login dialog starts the configured agent image, displays the CLI's authorization link and instructions, and accepts requested confirmation codes or terminal menu input without requiring the agent CLI on the host. Existing entries also include **Log in**. The dialog includes Up, Down, and Enter controls for provider and login-method menus; Escape or backdrop dismissal cancels its temporary container. Vibe uses an API key or pre-populated config instead of this interactive flow. See [Agents And Models](./agents-and-models.md).

Administrators can switch the configuration pane to **Synthetic Pools** to combine direct agent/model pairs behind virtual models with strict priority tiers, usage caps, round-robin or usage-based routing, and failover. Synthetic models also appear in the playground, which reports the virtual choice and physical member used. See [Synthetic Pools](./synthetic-pools.md).

## LLM Log

**LLM Log** (`/llm-logs`) shows every model call with expandable rows and filters by execution type, model, status, and work type. What each record contains and how to use the page for cost analysis is covered in [Metrics](../operations/metrics.md).

## Settings

**Settings** (`/settings`) is administrator-only, auto-saves, and is organized in two columns.

**AI engine configuration:** model roles (fast analysis, planner context, planner generation, default agent alias, PR review, and summarization), the knowledge-base reindex control, and the **LLM Usage Tracking** ([Agent Tank](../operations/agent-tank.md)) toggle and URL.

**Automation rules:** the GitHub user whitelist, primary processing labels, the PR label, follow-up keywords and ignore keywords, worker concurrency, the auto-follow-up score threshold, auto-resolve merge conflicts, and the Ultrafix rating goal / max cycles / pause settings.

These map onto [Agents And Models](./agents-and-models.md), [PR Follow-up](./pr-followup.md), the [Ultrafix commands](./pr-commands.md), and [Execution Safety](./execution-safety.md).

## Access

**Access** (`/admin/members`) is available to administrators. It creates durable `admin` and `member` role assignments using stable GitHub user IDs, shows environment administrators configured through `PROPR_ADMIN_USERS`, surfaces recent role-audit events, and prevents removal or demotion of the last durable administrator. On a new installation, sign in as a configured environment administrator and use **Store my administrator role** before removing that username from `PROPR_ADMIN_USERS`.

Role assignments do not edit the GitHub trigger whitelist. Configure allowed login and trigger actors separately under **Settings**.

## Live Updates And Shortcuts

The UI subscribes to socket.io events, so the dashboard, task list, task detail, and plan generation update without a refresh. Keyboard shortcuts: `Cmd/Ctrl+K` focuses global search, `Alt+T` opens quick add to-do, and `Esc` closes open popovers.


## Visual preview settings

Under a repository's **Visual previews** controls, **GitHub attachment plan**
accepts `auto`, `free`, or `paid`. `auto` detects the upload credential owner's
plan only for repositories owned by that user. Unknown plans, organizations,
missing credentials, and API failures use conservative Free limits. Images
remain limited to 10 MiB; videos allow 10 MiB on Free and 100 MiB on paid.
Only the override is saved; resolved capacity is read-only. This setting does
not change the installation's Plus entitlement.

**Settings → Integrations → Visual preview uploads** contains the attachment
credential and **Managed preview storage** status. Status is **Enabled**,
**Plus required**, **Disabled**, or **Unavailable**. **Refresh status** reads
Connect again. Quota, object maximum, and retention show Connect's effective
values. When those values cannot be loaded, the UI explicitly labels the v1
standard defaults: 25 GiB installation quota, 500 MiB per object, 90 days.
Unavailable storage leaves GitHub attachment publishing available. The managed
viewer links require Connect authentication; the GitHub upload credential is
still required for inline attachments.

See [Visual previews](./visual-previews.md) for capture and publication behavior.
