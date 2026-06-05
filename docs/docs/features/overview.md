---
sidebar_position: 2
---

# Features

ProPR helps you use AI coding agents inside a GitHub pull request workflow. It gives you a place to plan work, choose the right agent, run the task safely, review the result, and continue from normal GitHub comments.

The Web UI is the main way to configure and operate ProPR. Repositories, branches, processing labels, agents, planner settings, task history, logs, commits, and cost visibility all live there, while environment variables and scripts mainly set up the install.

## Plan And Run Work

Start with a GitHub issue, a Planner Studio draft, or a pull request comment.

- [Planning before execution](./planning.md): draft, review, refine, and approve plans before an agent changes code.
- [Work splitting](./work-splitting.md): turn larger efforts into smaller pull requests.
- [Repository knowledge](./repository-knowledge.md): use summaries, context previews, indexing, todos, and improvement suggestions to give agents better context.

## Choose And Control Agents

Use different coding agents without changing the rest of the workflow.

- [Agent routing](./agent-routing.md): use Claude Code, Codex, Antigravity, subscription-backed credentials, or API-backed credentials from the same GitHub flow.
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
- [CLI workflows](./cli-workflows.md): use source-development, validation, image, and maintenance commands when you need them.
