---
sidebar_position: 1
---

# Introduction

Welcome to ProPR, an AI engineering platform for planning, building, reviewing, and shipping changes through GitHub.

## What is ProPR?

ProPR connects to your GitHub repositories and keeps the pull request as the center of the workflow. It combines a Web UI dashboard, Planner Studio, a CLI, and multi-agent workers so you can move from an idea or GitHub issue to a reviewed pull request without stitching together separate tools.

## Key Capabilities

- **Web UI Dashboard**: Configure GitHub repositories, labels, agents, and defaults, then track task activity, queue health, repository status, usage, and live run details from the browser
- **Planner Studio**: Build draft plans, attach extra context, generate structured implementation steps, refine them, and run approved work
- **Multi-Agent Support**: Run Claude Code, Codex, Antigravity, OpenCode, and Mistral Vibe agents, choose different models per task, and use the right agent for review or implementation
- **Label-Based Model Routing**: Route any issue to a specific agent and model with `llm-*` labels such as `llm-claude-opus48`, `llm-codex-gpt55`, or `llm-antigravity-pro-high`; several model labels on one issue produce a separate run, branch, and PR per model
- **CLI**: Use the `propr` command (`@propr/cli`) to manage plans, implement issues, inspect tasks, and configure repositories and agents from the terminal
- **GitHub PR Automation**: Use slash commands like `/review`, `/fix`, `/merge`, `/switch`, `/use`, and `/ultrafix` for follow-up work on pull requests after the main setup is already handled in the UI
- **End-to-End GitHub Flow**: Detect labeled issues via polling or GitHub webhooks, create isolated worktrees and branches, implement changes, and open linked pull requests automatically
- **Production Operations**: Run with retries, state tracking, Docker-isolated agent runs, and real-time dashboard visibility
- **Agent Tank**: Optionally track per-task provider capacity and rate-limit usage, with live usage bars in the sidebar; tasks proceed even if tracking is unavailable

## How It Works

1. **Connect GitHub repositories**: Add monitored repositories, choose base branches, set primary processing labels, and configure coding agents and default models from the browser. Environment variables mainly set up the deployment or seed defaults.
2. **Choose the entry point**: Create a guided plan in Planner Studio, let ProPR process labeled GitHub issues automatically (via polling or webhooks), or drive the same flows from the `propr` CLI.
3. **Run the work**: ProPR prepares repository context, runs the selected agent in an isolated environment, and records the task in the dashboard.
4. **Review and iterate**: Use dashboard task views plus PR slash commands for AI review, fixes, model switching, merge assistance, or the Ultrafix review-fix loop.
5. **Observe everything**: Follow live task progress, logs, costs, and repository activity from the dashboard and task detail views.

## Quick Start

Ready to get started? Check out our [Setup Guide](./tutorials/setup.md) to run ProPR locally from the prebuilt images, then finish repository and agent configuration in the Web UI.

## Documentation Structure

- **[Feature Overview](./features/overview.md)**: A short map of the core workflow, PR control, repository context, and tools
- **[PR Commands](./features/pr-commands.md)**: Detailed reference for review, fix, merge, model switching, and Ultrafix workflows
- **Setup**: Local, server, and source-development setup paths
- **Tutorials**: Daily use, issue-to-PR, and Planner Studio walkthroughs
- **Architecture**: Focused overviews and runtime references for intake, workers, agent runs, and git management
- **Operations**: Deployment, maintenance, metrics, feedback loops, and Web UI integration
- **[Concepts](./concepts/pr-review-guidelines.md)**: ProPR-specific PR follow-up rules
