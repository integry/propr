# Launching Work

Use **New Task** for one bounded change, **New Plan** when you want to review a set of issues before execution, or **New Goal** for a continuing objective. The header defaults to New Task, switches to New Plan in Plans/Planner Studio, New Goal in Goals and New Automation in [Automations](./agents.md), and keeps the other actions in its menu. All three use configured repositories and agents.

## Start a task

1. Open **New Task** (`/tasks/new`) and select an enabled repository.
2. Enter the **Prompt** with the intended result and acceptance criteria. Attach relevant files if needed (up to 10), and choose an agent and model under **Advanced Options** when overriding the default. **Plan first** opens the same request in Planner Studio instead.
3. Choose **Run task**. ProPR creates a GitHub issue and submits the ordinary implementation task. Follow the linked task for progress and its resulting PR.

![New task form with a repository, invoice formatting instruction and Run task action](/img/screenshots/0.9.0/new-task.png)

New Task preselects the repository, agent and model from your last task that created its issue or was queued; the choice is kept in this browser. A launcher that passes a repository, such as the repository workspace's **New task** action, overrides it, and a remembered repository that has since been removed or disabled is cleared.

Attached images also appear inline in the GitHub issue. ProPR uploads them with the visual preview upload credential (**Settings → Integrations → Visual preview uploads**) under the issue's attachment list, while the files themselves still reach the task worktree. Without that credential, or when an upload fails, the issue is created without the inline image; text attachments are listed only. See [Visual previews](./visual-previews.md#publication-and-upload-failures) for GitHub's attachment limits.

The repository workspace's **New task** action prefills the repository. Select a to-do and choose **Run task** to prefill its text; launching does not mark the to-do complete. Submission acceptance is not implementation completion. If submission reports a failure or uncertain issue creation, use the displayed recovery action instead of starting duplicate requests.

MCP clients can use `create_task` with execute scope and a stable idempotency key, then follow the task and its pull request with `get_task_submission`; see [MCP](./mcp.md). `create_task` and `POST /api/task-submissions` accept an optional `maxCostUsd` that caps what the run may spend; see [Spend caps](./execution-safety.md#spend-caps). The CLI's existing issue implementation and `task inspect` commands are described in [ProPR CLI](./propr-cli.md#issue-implementation).

## Plan, goal or agent?

[Planner Studio](../tutorials/planner-studio.md) lets you edit, refine and approve a complete plan before creating issues. [Goals](./goals.md) keep an agent working toward an objective with progress, corrective inputs and pause/resume controls. [Agents](./agents.md) run a saved prompt on demand or on a schedule and write a report for recurring investigation.
