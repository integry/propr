---
sidebar_position: 4
sidebar_label: "Software Factory"
title: "Software factory: agent loops bounded by checks you set"
description: "See how ProPR runs loops that agents run on their own, bounded by checks you set: review and fix, CI repair, conflicts, epic queues, goals and automations, and how much autonomy each one gets."
---

# Software Factory

A **software factory** is a set of loops that agents run without someone driving each step. Work is found or handed in, built, checked and repaired, again and again, until a check passes or a limit stops the loop. The person sets the objective, the checks and the limits, and decides how much autonomy each loop gets, instead of steering each change. ProPR runs with a person in the loop by default: every pull request waits for someone to merge it. You can set individual loops to run further on their own.

Delivering one issue as one pull request is a single loop in that picture. This page shows the loops ProPR runs, what caps them, and how they run side by side. Each section links to the feature page with the details. When this page and a feature page differ, the feature page is correct.

## The Loops ProPR Runs

Each entry says what starts the loop, what stops it and what it leaves behind.

- **Review and fix.** `/ultrafix` alternates review and fix cycles until the latest review score reaches its goal (default 7) or the cycle limit (default 5) runs out, and waits for CI between cycles. It leaves scored review comments and fix commits on the pull request. See [`/ultrafix`](../features/pr-commands.md#ultrafix).
- **CI repair.** With **Auto CI follow-up** on (off by default), a failing check on the pull request head makes ProPR post a comment with the failure, and that comment starts a fix on the same branch. Each failing check is reported at most once per commit. See [Automatic Follow-Up For Failed CI](../features/pr-followup.md#automatic-follow-up-for-failed-ci).
- **Conflicts.** With **Auto-resolve merge conflicts** on (off by default), ProPR merges the moved base into a conflicted pull request and has an agent resolve the conflicts, at most 3 automatic attempts per pull request in 24 hours. With `auto_merge.require_up_to_date`, ProPR also brings a behind branch up to date and merges it only after CI passes on the updated head. See [Automatic Merge-Conflict Resolution](../features/pr-followup.md#automatic-merge-conflict-resolution) and [Up-to-date branches](../features/repository-workflow.md#up-to-date-branches).
- **Epic queue.** A plan's issues run in order. Each pull request merges into the epic branch before the next issue starts, and the epic pull request keeps one progress comment. A blocked issue stops the queue and shows why (for example *Waiting for human merge*), and it can trigger an automation. See [Work Splitting](../features/work-splitting.md) and [Event trigger](../features/agents.md#event-trigger).
- **Goals.** A goal keeps a coding-agent session working toward a continuing objective across many steps. When it needs a decision it asks and shows **Needs you**. You can pause, resume and cancel it, and continue it after it ends. It finishes with a draft pull request. See [Goals](../features/goals.md).
- **Automations.** A saved prompt runs on demand, on a schedule, from a trigger, or when an epic queue issue becomes blocked, and writes a report. In `preview` or `auto` mode, an acting step turns the report into tasks, plans, goals, to-dos or comments, and with the `merge` capability it may merge pull requests that are ready. This is the loop that finds its own work. See [Automations](../features/agents.md).
- **Outside drivers.** An MCP client or the `propr` CLI runs the same operations as the Web UI, so another agent or a script can run its own loop on top of ProPR: create tasks and goals, wait for them, review and fix pull requests. See [MCP](../features/mcp.md) and [ProPR CLI](../features/propr-cli.md).

## What Caps Each Loop

A loop gets as much autonomy as its check deserves. ProPR does not decide that a change is good. Your checks do, and the limits stop a loop that does not converge.

- **Your CI is the merge gate.** ProPR does not run your test suite as a merge gate. CI repair and `require_up_to_date` only help when CI failures are trustworthy. See [Repository Best Practices](./repository-best-practices.md).
- **Scored reviews and the rating goal.** `/review` posts merge blockers, suggestions and a `Score: N/10` line. `/ultrafix` stops at the score goal. See [`/review`](../features/pr-commands.md#review).
- **PR status.** The body and title show **Working**, **Needs you** or **Ready**. Ready means nothing is running, every check passed, there is no conflict and the latest score meets the rating goal. See [PR Status](../features/pr-status.md).
- **Protected paths and branch protection.** Auto-merge is not armed when a change touches a protected path (`.propr/**` always is). GitHub's branch protection, required checks and required reviews still apply. See [Auto-merge policy](../features/repository-workflow.md#auto-merge-policy).
- **Cycle and attempt limits.** The Ultrafix cycle limit, one CI report per check and commit, 3 conflict attempts a day, and at most 3 automation runs for the same blocked issue. See [Event trigger](../features/agents.md#event-trigger).
- **Spend limits.** A per-run spend cap stops a run whose estimated cost reaches the limit. Unattended automation runs are also cost-gated. See [Spend Caps](../features/execution-safety.md#spend-caps) and [Cost control](../features/agents.md#cost-control).
- **Capabilities and approval.** An automation starts with `repository_read` only, and `merge` is off by default. In `preview` mode each run waits for your approval before it acts. See [Capabilities](../features/agents.md#capabilities) and [Autonomy](../features/agents.md#autonomy).
- **Restricted network mode.** A container can reach only allowlisted hosts. See [Restricted Network Mode](../features/execution-safety.md#restricted-network-mode).

## Running In Parallel

- **One boundary per task.** Each task gets its own git worktree, branch and Docker container. The agent edits files. ProPR commits, pushes and opens the pull request. See [Isolated And Safe Execution](../features/execution-safety.md).
- **Several models on one issue.** Several `llm-*` labels give one branch and pull request per model, so you can compare them. See [Agents and Models](../features/agents-and-models.md).
- **Concurrency limits.** `limits.max_parallel_tasks` caps concurrent work per repository, within the instance's worker concurrency. A goal has its own limit on parallel tasks. See [Instance defaults and hard limits](../features/repository-workflow.md#instance-defaults-and-hard-limits).

Because every task has its own branch and container, many loops can run at once without touching each other's checkout.

## Where Work Comes From

Every entry point creates a task with its own record, and usually a pull request.

- **Issues and labels**: a processing label such as `AI`, with an optional `llm-*` model label. See [Daily Use](../tutorials/usage.md#run-work-from-an-issue).
- **Plans and epics** from Planner Studio. See [Planning Before Execution](../features/planning.md).
- **Tasks, to-dos and improvement suggestions** from **New Task**, the repository workspace and the **Improve** tab. See [Launching Work](../features/launching-work.md) and [Improvement suggestions](../features/repository-knowledge.md#improvement-suggestions).
- **Pull request comments**: a plain comment or slash command, also on pull requests ProPR did not open. See [PR Follow-up](../features/pr-followup.md).
- **Goals, automations, MCP and CLI**, described in [the loops above](#the-loops-propr-runs).

## How Much Runs On Its Own

Rows go from least to most autonomy. Branch protection, required checks and required reviews in GitHub still apply on every row.

| Setting | What ProPR does | What still needs a person | Controlled by |
| --- | --- | --- | --- |
| Every pull request waits for a person (default) | Builds the change, opens the pull request and keeps its status current. | Reviewing and merging every pull request. | No `auto-merge` label on the issue. |
| Review and repair loops | Runs the review and fix, CI repair and conflict loops. | Merging. | `/ultrafix` (or **Run ultrafix** in a plan); **Auto CI follow-up** and **Auto-resolve merge conflicts** per repository. |
| Auto-merge on green | Arms GitHub's auto-merge, or with `require_up_to_date` merges itself after CI passes on an up-to-date head. | Pull requests that touch a protected path, and anything branch protection requires. | The `auto-merge` label (**Auto-merge if checks pass** in Planner Studio, `--auto-merge`, or MCP `autoMerge`); `auto_merge` in [`.propr/workflow.yml`](../features/repository-workflow.md#auto-merge-policy). |
| Epic chain | Runs the epic queue, merging each pull request into the epic branch. | Pull requests auto-merge declines, and the final review of the epic pull request. | Epic mode with auto-merge in Planner Studio, or `propr issue implement … --epic --auto-merge`. |
| Automation that may merge | The acting step acts through ProPR's MCP tools and, with `merge`, merges only the exact head it examined, with passing checks and satisfied review and protection rules. | Approving each run in `preview` mode. The acting step never deploys, publishes, changes settings or edits files itself. | Autonomy mode (`dry_run`, `preview`, `auto`) and the `merge` capability on the automation, within the instance's MCP scope ceiling. See [Acting on a report](../features/agents.md#acting-on-a-report). |

## What You Can See

- **Task records**: trigger, repository, branch, agent and model, prompt, logs, commits and outcome. See [Observability And Control](../features/observability.md).
- **LLM Log and MCP Log**: every model call with cost, tokens and duration, and MCP tool calls for administrators. See [Metrics](../operations/metrics.md#the-llm-log-page).
- **Analytics and cost export** as JSON, CSV or `propr stats cost`. See [Cost export](../operations/metrics.md#cost-export).
- **Inbox**: plan, task, review, pull request and system events, including goals that need you. See [Inbox](../features/inbox.md).

## A Starting Path

1. Install ProPR and connect a repository: [Setup Guide](../tutorials/setup.md).
2. Make CI the check you trust and decide which paths always need a person: [Repository Best Practices](./repository-best-practices.md).
3. Run one loop by hand: label an issue, then run `/ultrafix` on its pull request: [Issue To Pull Request Walkthrough](../tutorials/end-to-end-workflow.md).
4. Let more run on its own: an epic with auto-merge ([Planner Studio Walkthrough](../tutorials/planner-studio.md)), then an automation in `preview` mode ([Automations](../features/agents.md)).
