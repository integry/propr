---
sidebar_position: 7
---

# Observability And Control

ProPR is built so you can see what happened after every agent run. A task should not disappear into a terminal session or a provider dashboard; it should leave a record that connects the request, selected agent, logs, commits, costs, outcome, and recovery state.

## Task Records

Each run creates a task record that can be inspected from the Web UI. Task records help answer:

- What triggered this run?
- Which repository, branch, agent, and model were used?
- What state is the task in now?
- Which commits or pull request came out of it?
- Where did a failure occur?

This makes ProPR useful as a control layer for AI-assisted development, not just as a PR generator.

## Logs And Live Output

Task detail views expose progress while work is running, including streamed output where supported. That helps operators tell the difference between:

- A job waiting in the queue
- A job actively running
- An agent still thinking or editing files
- A git or GitHub finalization failure
- A completed task waiting for review

## Commits And Pull Requests

ProPR connects implementation output back to GitHub:

- Branch name and model traceability
- Commit summaries
- Pull request links
- Follow-up comments
- Review and fix cycles

The pull request remains the place to collaborate, while the task record preserves the run history.

## Cost And Usage Visibility

The dashboard shows model usage and cost-oriented data where it is available. This helps you:

- Comparing agents and models across real work
- Spotting unexpectedly expensive runs
- Understand which repositories drive usage
- Planning around subscription access, API access, and provider rate limits

Agent Tank and related usage views fit into this control layer: they make agent capacity and rate-limit pressure visible before they become workflow failures.

## Recovery

Observability matters most when a run fails. ProPR tracks enough state to support recovery decisions:

- Retry transient git or GitHub failures
- Inspect failed agent output
- Re-run a follow-up with stronger instructions
- Switch models when the current model is a bad fit
- Resume work from the PR conversation

For deeper operational metrics, see [LLM Metrics](../operations/llm-metrics.md) and [System Metrics](../operations/system-metrics.md).
