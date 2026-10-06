# Launching Work

Use **New Task** for one bounded change, **New Plan** when you want to review a set of issues before execution, or **New Goal** for a continuing objective. The header defaults to New Task, switches to New Plan in Plans/Planner Studio and New Goal in Goals, and keeps the other two actions in its menu. All three use configured repositories and agents.

## Start a task

1. Open **New Task** (`/tasks/new`) and select an enabled repository.
2. Enter the **Prompt** with the intended result and acceptance criteria. Attach relevant files if needed (up to 10), and choose an agent and model under **Advanced Options** when overriding the default. **Plan first** opens the same request in Planner Studio instead.
3. Choose **Run task**. ProPR creates a GitHub issue and submits the ordinary implementation task. Follow the linked task for progress and its resulting PR.

![New task form with a repository, invoice formatting instruction and Run task action](/img/screenshots/0.9.0/new-task.png)

The repository workspace's **New task** action prefills the repository. Select a to-do and choose **Run task** to prefill its text; launching does not mark the to-do complete. Submission acceptance is not implementation completion. If submission reports a failure or uncertain issue creation, use the displayed recovery action instead of starting duplicate requests.

MCP clients can use `create_task` with execute scope and a stable idempotency key, then follow the task and its pull request with `get_task_submission`; see [MCP](./mcp.md). `create_task` and `POST /api/task-submissions` accept an optional `maxCostUsd` that caps what the run may spend; see [Spend caps](./execution-safety.md#spend-caps). The CLI's existing issue implementation and `task inspect` commands are described in [ProPR CLI](./propr-cli.md#issue-implementation).

## Steer a running task

While a task's agent runs, you can correct its direction without stopping the run and losing its work. Steering is a separate, explicit channel: PR comments that arrive during a run are still batched and processed after it finishes.

- **Web UI:** the **Steer the running agent** box below the live log on the task detail page.
- **CLI:** `propr task steer <task-id> "<message>"` (or `--file` / `--stdin`); see [ProPR CLI](./propr-cli.md#tasks).
- **MCP:** `steer_task` with execute scope; see [MCP](./mcp.md).
- **API:** `POST /api/tasks/:taskId/steer` with `{ "message": "..." }`; `GET /api/tasks/:taskId/steers` lists the messages and whether the task can be steered now.

Each agent declares its steering capability for ordinary task runs in its agent definition:

| Agent | Capability | How a steer reaches it |
|---|---|---|
| Claude | `live` | Written into the running session as a user message over the stream-json stdin channel, the same channel Claude goals use. |
| Codex | `none` | Task runs are one-shot `codex exec --ephemeral` invocations with no input channel. Codex goals remain steerable live. |
| Antigravity | `none` | Task runs are one-shot `agy --print` invocations. Antigravity goals remain steerable at the next step boundary. |
| OpenCode | `none` | One-shot task runs. |
| Vibe | `none` | One-shot task runs. |

A steer to a task that is not running, or whose running agent's capability is `none`, is rejected with HTTP 409, a clear error and the capability. Issue implementation tasks and PR comment follow-ups can be steered; goals use their own [goal inputs](./goals.md).

Rules:

- A message is at most 4,000 characters, and a run accepts at most 20 steers.
- Each message is stored with its author (browser session user, bearer-token identity or MCP identity), and is delivered **at most once**. If the run ends or its container is replaced before a message was delivered, the replacement run receives it in its prompt instead.
- A delivered steer counts as activity for the [stall watchdog](./execution-safety.md).
- Delivered messages appear in the task timeline, and the GitHub completion comment lists them under **Operator input during the run**.

## Plan or goal?

[Planner Studio](../tutorials/planner-studio.md) lets you edit, refine and approve a complete plan before creating issues. [Goals](./goals.md) keep an agent working toward an objective with progress, corrective inputs and pause/resume controls.
