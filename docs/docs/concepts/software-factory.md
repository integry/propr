---
sidebar_position: 4
sidebar_label: "Software Factory"
title: "Software factory: how ProPR turns requests into merged pull requests"
description: "See how intake, isolated builds, pull request verification loops and autonomy settings fit together as one line from request to merged pull request."
---

# Software Factory

In these docs, a **software factory** is a repeatable line that takes a request and turns it into a merged pull request. ProPR runs each step of that line the same way every time. A person decides how much of it runs without them, from reviewing and merging every pull request to letting a planned chain of pull requests merge on green CI.

This page shows how the parts fit together. Each section links to the feature page that describes the details. When this page and a feature page differ, the feature page is correct.

## Where Work Comes From

Every entry point ends in the same place: a task with its own record, and usually a pull request.

- **Issues and labels.** Add a processing label such as `AI` to a GitHub issue; an optional `llm-*` label picks the model. See [Daily Use](../tutorials/usage.md#run-work-from-an-issue).
- **Plans and epics.** Draft, refine and approve a set of issues in Planner Studio, then run them one at a time or as an epic. See [Planning Before Execution](../features/planning.md) and [Work Splitting](../features/work-splitting.md).
- **Tasks and repository to-dos.** Start one bounded change from **New Task**, or from a to-do in the repository workspace. See [Launching Work](../features/launching-work.md).
- **Improvement suggestions.** The **Improve** tab suggests changes that you can turn into to-dos or a plan. See [Repository Knowledge](../features/repository-knowledge.md#improvement-suggestions).
- **Pull request comments.** A plain comment or a slash command on a pull request starts follow-up work on the same branch, also on pull requests ProPR did not open. See [PR Follow-up](../features/pr-followup.md).
- **Goals.** A goal keeps a coding-agent session working toward a continuing objective. See [Goals](../features/goals.md).
- **Automations.** A saved prompt runs on demand, on a schedule, from the API, CLI or MCP (for example called from GitHub Actions or a crontab), or when an epic queue issue becomes blocked, and writes a report. [Templates](../features/agents.md#templates) fill in common ones. In `preview` or `auto` mode, an [acting step](../features/agents.md#acting-on-a-report) turns the report into tasks, plans, to-dos or comments. See [Automations](../features/agents.md).
- **MCP and CLI clients.** A connected MCP client or the `propr` CLI can create tasks, plans and goals through the same API as the Web UI. See [MCP](../features/mcp.md) and [ProPR CLI](../features/propr-cli.md).

## How A Change Is Built

- **One boundary per task.** Each task gets its own git worktree, its own branch and its own Docker container. The agent edits files. ProPR commits, pushes and opens the pull request after the agent finishes. See [Isolated And Safe Execution](../features/execution-safety.md).
- **Agent and model per task.** ProPR uses the configured default agent and model unless you choose another one for the task: in **New Task**, in the plan's execution step, or with an `llm-*` label. Several `llm-*` labels on one issue give one branch and pull request per model. See [Agents and Models](../features/agents-and-models.md).
- **Network access.** Agent containers run with open network access by default. In restricted mode, a container can reach only allowlisted hosts. An administrator can set it per instance and can enforce it; a repository can choose it in `.propr/workflow.yml`. See [Restricted Network Mode](../features/execution-safety.md#restricted-network-mode).

## How A Change Is Verified

ProPR does not run your test suite as a merge gate. Your CI is that gate. See [Repository Best Practices](./repository-best-practices.md).

- **The pull request.** ProPR opens it linked to the source issue, with its implementation summary in the body. The task that produced it keeps its full record in the Web UI. See [PR Follow-up](../features/pr-followup.md#automatic-pull-request-creation).
- **The pull request status.** The first line of the body, and one emoji in the title, show **Working**, **Needs you** or **Ready**. Ready means nothing is running, every check passed, there is no conflict with the base, and the latest review score (if any) meets the rating goal. See [PR Status](../features/pr-status.md).
- **Scored reviews.** `/review` posts merge blockers (`F1`, `F2`, …), suggestions (`S1`, `S2`, …) and a `Score: N/10` line. It does not change code. See [`/review`](../features/pr-commands.md#review).
- **`/fix`.** Applies every pending merge blocker, all suggestions with `/fix all`, or only the records you name, such as `/fix F1 S2`. See [`/fix`](../features/pr-commands.md#fix).
- **Ultrafix.** `/ultrafix` repeats review and fix cycles until the score reaches its goal (default 7) or the cycle limit (default 5) runs out. It waits for CI between cycles. See [`/ultrafix`](../features/pr-commands.md#ultrafix).
- **CI failures.** With **Auto CI follow-up** on (off by default), ProPR posts a failing check on the pull request head as a comment, and that comment starts follow-up work. See [Automatic Follow-Up For Failed CI](../features/pr-followup.md#automatic-follow-up-for-failed-ci).
- **Merge conflicts.** `/merge` brings the base branch into the pull request branch and resolves conflicts with an agent. With **Auto-resolve merge conflicts** on (off by default), ProPR does this when the base moves on. See [Automatic Merge-Conflict Resolution](../features/pr-followup.md#automatic-merge-conflict-resolution).
- **Visual previews.** When a repository turns them on, a change that users can see gets image or video evidence in the pull request. See [Visual Previews](../features/visual-previews.md).

## How Much Runs On Its Own

Rows go from least to most autonomy. Branch protection, required checks and required reviews in GitHub still apply on every row: auto-merge does not bypass them.

| Setting | What ProPR does | What still needs a person | Controlled by |
| --- | --- | --- | --- |
| Every pull request waits for a person (default) | Builds the change, opens the pull request and keeps its status current. | Reviewing and merging every pull request. | No `auto-merge` label on the issue. |
| Review and repair loops | Runs review and fix cycles toward a score goal, fixes failing CI and resolves merge conflicts. | Merging. | `/ultrafix` (or **Run ultrafix** in a plan); **Auto CI follow-up** and **Auto-resolve merge conflicts** per repository. |
| Auto-merge on green | Arms GitHub's auto-merge, which merges once required checks and approvals pass. With `auto_merge.require_up_to_date`, ProPR updates a behind branch from its base and merges it itself only after CI passes on the updated head. | Pull requests that touch a protected path (`.propr/**` always is), and anything branch protection requires. ProPR comments and leaves the merge to a person. | The `auto-merge` label (**Auto-merge if checks pass** in Planner Studio, `--auto-merge`, or MCP `autoMerge`); `auto_merge` in [`.propr/workflow.yml`](../features/repository-workflow.md#auto-merge-policy). |
| Epic chain | Runs a plan's issues in order. Each pull request merges into the epic branch before the next issue starts. | A pull request auto-merge declines: the queue shows *Waiting for human merge* until a person merges it. The final review of the epic pull request. | Epic mode with auto-merge in Planner Studio, or `propr issue implement … --epic --auto-merge`. See [Work Splitting](../features/work-splitting.md). |
| Automation that may merge | The acting step reads the report and acts through ProPR's MCP tools. With the `merge` capability it may merge a pull request, but only the exact head it examined, with passing checks and satisfied review and protection rules. | Approving each run in `preview` mode. The acting step never deploys, publishes or changes settings, never touches repositories outside the automation, never edits files, commits, pushes or opens pull requests itself, and never starts or approves automation runs. | Autonomy mode (`dry_run`, `preview`, `auto`) and the `merge` capability (off by default) on the automation; the instance's MCP scope ceiling must include `merge`. See [Acting on a report](../features/agents.md#acting-on-a-report). |

## What You Can See

- **Task records.** Each run keeps what triggered it, the repository, branch, agent and model, the prompt, logs, commits and outcome. See [Observability And Control](../features/observability.md).
- **LLM Log and MCP Log.** Every model call is recorded with cost, tokens and duration. Administrators can see MCP tool calls with their outcome and timing. See [Metrics](../operations/metrics.md#the-llm-log-page) and [MCP](../features/mcp.md).
- **Analytics and cost export.** The Analytics page reports activity, repository and model results. Recorded cost exports as JSON or CSV, or with `propr stats cost`. See [Cost export](../operations/metrics.md#cost-export).
- **Notifications and Inbox.** Inbox collects plan, task, review, pull request and system events, with optional push notifications. See [Inbox](../features/inbox.md).

## A Starting Path

To run the line on one repository:

1. Install ProPR and connect the repository: [Setup Guide](../tutorials/setup.md).
2. Make CI the quality gate and decide which paths always need a person: [Repository Best Practices](./repository-best-practices.md).
3. Label one issue and review the pull request it produces: [Issue To Pull Request Walkthrough](../tutorials/end-to-end-workflow.md).
4. Plan a larger change and run it as an epic: [Planner Studio Walkthrough](../tutorials/planner-studio.md).
