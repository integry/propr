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

ProPR replaces the PR's `llm-*` label with the new model's label. Later comments, commands, and ultrafix cycles on this PR use the new model.

`/switch` takes exactly one model argument; extra arguments are ignored with a warning. The model must be a known catalog model or a model configured on an enabled agent — unrecognized models are rejected.

If you include instructions on the lines below the command, ProPR switches the label and also queues one follow-up run with the new model using those instructions:

```text
/switch llm-claude-opus48
Re-check the concurrency handling after switching.
```

Without instructions, `/switch` only updates the label and makes no code changes.

## `/use`

`/use` runs one immediate follow-up task with a temporary model:

```text
/use <model-id>
Please investigate the flaky test failure and update the PR.
```

The PR's model label does not change. Later work returns to the PR's configured model unless you use `/switch` or another `/use`. Like `/switch`, `/use` takes one model argument, and the agent sees only your instructions — not the command syntax.

## Choosing A Model

Check AI Agents in the Web UI for the model IDs available in your deployment; the built-in catalog is in [Agents and Models](./agents-and-models.md). The `llm-` prefix is optional in command arguments.

Use routing when:

- A model is better suited to the task
- The current model is stuck
- You want a one-off second opinion
- You need to work around provider capacity or rate limits
