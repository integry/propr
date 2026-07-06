# Web UI Guide

The ProPR Web UI is where you configure repositories and agents, plan and launch work, watch tasks run, and review costs and capacity. It is the same surface used in the [live demo](https://demo.propr.dev) and runs on port `5173` by default (open it with `propr ui`).

This page is a tour of what each screen does. For how the UI is wired to the backend — ports, OAuth, WebSockets, deployment — see the [Web UI Integration Guide](../operations/web-ui-integration.md). For the terminal equivalent of most of these actions, see the [ProPR CLI](./propr-cli.md).

## Navigation And Chrome

Two persistent elements frame every page.

**Sidebar (left).** The primary navigation: **Dashboard**, **Plans**, **Tasks**, **Repositories**, **Coding Agents**, **LLM Log**, and **Settings**. Tasks and Plans show live count badges, and an amber dot flags setup gaps (no repositories, no agents, or no tasks yet). Below the navigation, the [Agent Tank](../operations/agent-tank.md) usage section shows live per-provider capacity bars when the integration is enabled. The footer shows the running version and copyright.

**Header (top).** A global **search** (focus with `Cmd/Ctrl+K`) spans tasks, plans, and repositories. To its right: an **AI activity monitor** (how many tasks are running now), an **active plans** dropdown, a **tasks awaiting review** dropdown grouped by repo/PR/issue, a **quick add to-do** popover (`Alt+T`), a **New Plan** button, a **system health** indicator that opens a status modal (daemon, workers, Redis, GitHub auth, indexing, and per-agent health), and your GitHub profile with sign-out.

When the backend runs with `PROPR_DEMO_MODE=true`, a banner indicates read-only access and all mutating actions are disabled.

{/* SCREENSHOT PLACEHOLDER: Capture the full app shell — left sidebar (nav + Agent Tank usage + version footer) and the global header (search, activity monitor, New Plan, system health, profile) — with the Dashboard behind it. */}

## Dashboard

The landing page (`/`) pairs a **Recent Activity** task feed with an analytics rail: an Active / Success / Total / Failed stats grid, Total Cost, a daily activity sparkline, task status distribution, a Repository Breakdown, and Top Models. New instances also surface an onboarding widget and, when ProPR detects a running Agent Tank, a banner offering to enable it. The panels refresh live over WebSocket as tasks change. For where each number comes from and how to read it, see [Metrics](../operations/metrics.md).

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

**Repositories** (`/repositories`) manages the repos ProPR monitors — add, alias, set a base branch, enable/disable, reindex, hide, or delete. The selected repository opens a panel with four tabs:

- **Chat** — converse with the indexed repository;
- **Improve** — generate categorized improvement suggestions;
- **Browse** — the file tree with AI-generated summaries (also reachable at `/summaries`);
- **To-dos** — the repository's to-do list by category (the header's quick-add writes here).

See [Repository Knowledge](./repository-knowledge.md) and [Branch Configuration](./branch-config.md) for what indexing and branch settings drive.

## Coding Agents

**Coding Agents** (`/ai-agents`) is a split view: configure agent aliases and their models on one side, and a **playground** to test an agent interactively on the other. See [Agents And Models](./agents-and-models.md).

## LLM Log

**LLM Log** (`/llm-logs`) shows every model call with expandable rows and filters by execution type, model, status, and work type. What each record contains and how to use the page for cost analysis is covered in [Metrics](../operations/metrics.md).

## Settings

**Settings** (`/settings`) auto-saves and is organized in two columns.

**AI engine configuration:** model roles (fast analysis, planner context, planner generation, default agent alias, PR review, and summarization), the knowledge-base reindex control, and the **LLM Usage Tracking** ([Agent Tank](../operations/agent-tank.md)) toggle and URL.

**Automation rules:** the GitHub user whitelist, primary processing labels, the PR label, follow-up keywords and ignore keywords, worker concurrency, the auto-follow-up score threshold, auto-resolve merge conflicts, and the Ultrafix rating goal / max cycles / pause settings.

These map onto [Agents And Models](./agents-and-models.md), [PR Follow-up](./pr-followup.md), the [Ultrafix commands](./pr-commands.md), and [Execution Safety](./execution-safety.md).

## Live Updates And Shortcuts

The UI subscribes to socket.io events, so the dashboard, task list, task detail, and plan generation update without a refresh. Keyboard shortcuts: `Cmd/Ctrl+K` focuses global search, `Alt+T` opens quick add to-do, and `Esc` closes open popovers.
