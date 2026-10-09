# Launching Work

Use **New Task** for one bounded change, **New Plan** when you want to review a set of issues before execution, or **New Goal** for a continuing objective. The header defaults to New Task, switches to New Plan in Plans/Planner Studio, New Goal in Goals and New Automation in [Automations](./agents.md), and keeps the other actions in its menu. All three use configured repositories and agents.

## Start a task

1. Open **New Task** (`/tasks/new`) and select an enabled repository.
2. Enter the **Prompt** with the intended result and acceptance criteria. Attach relevant files if needed (up to 10), and choose an agent and model under **Advanced Options** when overriding the default. **Plan first** opens the same request in Planner Studio instead.
3. Choose **Run task**. ProPR creates a GitHub issue and submits the ordinary implementation task. Follow the linked task for progress and its resulting PR.

![New task form with a repository, invoice formatting instruction and Run task action](/img/screenshots/0.9.0/new-task.png)

The repository workspace's **New task** action prefills the repository. Select a to-do and choose **Run task** to prefill its text; once the submission opens its GitHub issue, the to-do is marked complete and shows a `#<issue number>` chip that opens that issue. Reopen it from **Completed Items** if the work still needs doing; launching it again links it to the new issue. Submission acceptance is not implementation completion. If submission reports a failure or uncertain issue creation, use the displayed recovery action instead of starting duplicate requests.

MCP clients can use `create_task` with execute scope and a stable idempotency key, then follow the task and its pull request with `get_task_submission`; see [MCP](./mcp.md). `create_task` and `POST /api/task-submissions` accept an optional `maxCostUsd` that caps what the run may spend; see [Spend caps](./execution-safety.md#spend-caps). The CLI's existing issue implementation and `task inspect` commands are described in [ProPR CLI](./propr-cli.md#issue-implementation).

## Plan or goal?

[Planner Studio](../tutorials/planner-studio.md) lets you edit, refine and approve a complete plan before creating issues. [Goals](./goals.md) keep an agent working toward an objective with progress, corrective inputs and pause/resume controls.
