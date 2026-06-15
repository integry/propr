---
sidebar_position: 2
---

# Features

ProPR helps you use AI coding agents inside a GitHub pull request workflow. It gives you a place to plan work, choose the right agent, run the task safely, review the result, and continue from normal GitHub comments.

The Web UI is the main way to configure and operate ProPR. Repositories, branches, processing labels, agents, planner settings, task history, logs, commits, and cost visibility all live there, while environment variables and scripts mainly set up the install.

## Use One Stage Or All Of Them

ProPR is modular. Each stage below is its own entry point, so you can introduce ProPR gradually or use only the parts that fit your team — without committing to the whole flow:

- **Plan only** — generate issues in [Planner Studio](./planning.md), then implement them however you like.
- **Implement only** — label a hand-written issue to have ProPR build it.
- **Review or fix only** — run [PR slash commands](./pr-commands.md) on any eligible PR, including ones ProPR did not create.
- **Take over an existing PR** — add the processing label to an open PR and keep working from [PR comments](./pr-followup.md).

Running the full flow end to end is supported, but never required.

## Plan And Run Work

Start with a GitHub issue, a Planner Studio draft, or a pull request comment.

- [Planning before execution](./planning.md): draft, review, refine, and approve plans before an agent changes code.
- [Work splitting](./work-splitting.md): turn larger efforts into smaller pull requests.
- [Repository knowledge](./repository-knowledge.md): use summaries, context previews, indexing, todos, and improvement suggestions to give agents better context.

## Choose And Control Agents

Use different coding agents without changing the rest of the workflow.

- [Agent routing](./agent-routing.md): use Claude Code, Codex, Antigravity, OpenCode, or Mistral Vibe — with subscription-backed or API-backed credentials — from the same GitHub flow.
- [Agents and models](./agents-and-models.md): the canonical catalog of supported agents, model IDs, and `llm-*` labels.
- [Isolated and safe execution](./execution-safety.md): run agents in controlled containers and separate worktrees.
- [Self-hosted operation](./self-hosting.md): run ProPR from published images or from source while using your own credentials.

## Refine Pull Requests

ProPR keeps follow-up work where the review already happens: the pull request.

- [PR automation and fine-tuning](./pr-followup.md): create pull requests automatically, then refine them through natural GitHub comments or slash-command workflows.
- [PR slash commands](./pr-commands.md): the command reference for `/review`, `/fix`, `/merge`, `/switch`, `/use`, and `/ultrafix`.
- [Branch configuration](./branch-config.md): repository-specific branch defaults and resolution rules.

## See What Happened

Every run leaves a task record you can inspect later.

- [Observability and control](./observability.md): inspect task records, streamed logs, commits, costs, failures, and recovery state after every run.
- [CLI workflows](./cli-workflows.md): source-development, validation, image, and maintenance commands for developing and operating ProPR itself. The end-user `propr` CLI is documented separately in [ProPR CLI](./propr-cli.md).
