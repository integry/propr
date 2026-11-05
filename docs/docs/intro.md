---
sidebar_position: 1
sidebar_label: "Introduction"
title: "Official documentation and getting started"
description: "Set up ProPR, sign in to your instance, and find guides for AI coding agents, GitHub pull requests, the CLI, and API."
---

# Introduction

Welcome to ProPR, an AI engineering platform for planning, building, reviewing, and shipping changes through GitHub.

## What is ProPR?

ProPR connects to your GitHub repositories and keeps the pull request as the center of the workflow. It combines a Web UI dashboard, Planner Studio, a CLI, and multi-agent workers so you can move from an idea or GitHub issue to a reviewed pull request without stitching together separate tools.

## Sign in, use the app, or find a reference

To sign in to ProPR, open your own self-hosted instance's Web UI
(`http://localhost:5173` by default on a local install, or the address you configured)
and sign in with GitHub. If the UI is stopped, run `propr ui on` from your stack
directory to start it. See the [local setup guide](./tutorials/setup-local.md)
for the instance address and the [Web UI guide](./features/web-ui.md) for the app's screens.
If you use the optional relay, the [ProPR Connect dashboard](./operations/connect-dashboard.md)
manages seats, relay tokens, and tunnels; repositories, agents, and tasks live in
your instance's UI.

- [ProPR CLI reference](./features/propr-cli.md): install, authenticate, control your stack, and manage work from the terminal.
- [ProPR API reference](./operations/api-reference.md): HTTP endpoints, authentication, an interactive reference, and the OpenAPI specification.

## First 15 Minutes

You need a supported Docker host (Linux `amd64` is native and recommended; Apple Silicon macOS works through Docker Desktop running the published Linux `amd64` images under emulation; native `arm64` images are not yet available), Node.js 22+ for the CLI path, and a login for at least one coding agent — reuse one already on the host (Claude Code's `claude auth login`, Antigravity's `agy login`, …) or create it through the agent's own Docker image with `propr agent login <agent>`. Then:

```bash
npm install -g propr-cli
propr setup   # guided: verify host, authorize agents, connect GitHub, start
```

Label a GitHub issue `AI` (or approve a plan in the Web UI) and the result comes back as a pull request. The [Setup Guide](./tutorials/setup.md) has the full walkthrough, including a copyable [safe installation prompt for coding agents](./tutorials/setup.md#give-this-to-your-coding-agent) — or explore the [live demo](https://demo.propr.dev) first without installing anything.

## A Modular Tool

ProPR supports the full idea-to-merge flow and leaves every stage optional. Each stage is a separate entry point you can adopt on its own and slot into the workflow you already have:

- **Planning only**: use Planner Studio to generate GitHub issues, then implement them manually or with another tool or agent.
- **Issue implementation only**: write issues by hand (or with another planning tool), then trigger ProPR by adding a processing label such as `AI` or `propr` and an optional `llm-*` model label.
- **PR review and fixes only**: run `/review`, `/fix`, and other slash commands on any eligible pull request — including PRs created outside ProPR.
- **Existing PR takeover**: hand an already-open PR to ProPR by adding the configured processing label, then continue with normal follow-up comments or slash commands.

End-to-end usage remains fully supported — it is simply one of the ways to use ProPR.

## Key Capabilities

- **Web UI Dashboard**: Configure GitHub repositories, labels, agents, and defaults, then track task activity, queue health, repository status, usage, and live run details from the browser
- **Planner Studio**: Build draft plans, attach extra context, generate structured implementation steps, refine them, and run approved work
- **Multi-Agent Support**: Run Claude Code, Codex, Antigravity, OpenCode, and Mistral Vibe agents, choose different models per task, and use the right agent for review or implementation
- **Label-Based Model Routing**: Route any issue to a specific agent and model with `llm-*` labels such as `llm-claude-opus5`, `llm-codex-gpt55`, or `llm-antigravity-argon`; several model labels on one issue produce a separate run, branch, and PR per model
- **CLI**: Use the `propr` command (`propr-cli`) as the local stack control plane (`propr init stack`, `propr check`, `propr start`) and to manage plans, implement issues, inspect tasks, and configure repositories and agents from the terminal
- **GitHub PR Automation**: Use slash commands like `/review`, `/fix`, `/merge`, `/switch`, `/use`, and `/ultrafix` for follow-up work on pull requests after the main setup is already handled in the UI
- **End-to-End GitHub Flow**: Detect labeled issues through the configured event intake mode (routing WebSocket by default, or optionally polling or a direct webhook), create isolated worktrees and branches, implement changes, and open linked pull requests automatically
- **Production Operations**: Run with retries, state tracking, Docker-isolated agent runs, and real-time dashboard visibility
- **[Agent Tank](./operations/agent-tank.md)**: Optionally track per-task provider capacity and rate-limit usage, with live usage bars in the sidebar; tasks proceed even if tracking is unavailable

## How It Works

1. **Connect GitHub repositories**: Add monitored repositories, choose base branches, set primary processing labels, and configure coding agents and default models from the browser. Environment variables mainly set up the deployment or seed defaults.
2. **Choose the entry point**: Create a guided plan in Planner Studio, let ProPR process labeled GitHub issues automatically (events arrive over the default routing WebSocket, or optionally via polling or a direct webhook), or drive the same flows from the `propr` CLI.
3. **Run the work**: ProPR prepares repository context, runs the selected agent in an isolated environment, and records the task in the dashboard.
4. **Review and iterate**: Use dashboard task views plus PR slash commands for AI review, fixes, model switching, merge assistance, or the Ultrafix review-fix loop.
5. **Observe everything**: Follow live task progress, logs, costs, and repository activity from the dashboard and task detail views.

## Documentation Structure

- **[Feature Overview](./features/overview.md)**: A short map of the core workflow, PR control, repository context, and tools
- **[PR Commands](./features/pr-commands.md)**: Detailed reference for review, fix, merge, model switching, and Ultrafix workflows
- **Setup**: Local, server, and source-development setup paths
- **Tutorials**: Daily use, issue-to-PR, and Planner Studio walkthroughs
- **Architecture**: Focused overviews and runtime references for intake, workers, agent runs, and git management
- **Operations**: Deployment, maintenance, metrics, feedback loops, and Web UI integration
- **[Concepts](./concepts/glossary.md)**: Glossary, security overview, and repository best practices
