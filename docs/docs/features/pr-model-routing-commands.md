---
sidebar_position: 15
---

# Model Routing Commands

Use model routing commands when the current PR should use a different configured agent or model.

## `/switch`

`/switch` changes the PR's model label for future work:

```text
/switch <model-id>
```

If you include instructions, ProPR switches models and queues a follow-up review with the new model:

```text
/switch <model-id>
Please re-review after switching.
```

Use `/switch` when the model choice should persist for later comments and commands.

## `/use`

`/use` runs one immediate follow-up task with a temporary model:

```text
/use <model-id>
Please investigate the flaky test failure and update the PR.
```

The PR's model label does not change. Later work returns to the PR's configured model unless you use `/switch` or another `/use`.

## Choosing A Model

Check AI Agents in the Web UI for valid model IDs. The `llm-` label prefix is optional in command arguments when the ID is otherwise unambiguous.

Use routing when:

- A model is better suited to the task
- The current model is stuck
- You want a one-off second opinion
- You need to work around provider capacity or rate limits
