---
sidebar_position: 1
---

# Introduction

Welcome to ProPR, an AI engineering platform for planning, implementing, reviewing, and operating GitHub work from one system.

## What is ProPR?

ProPR combines a Web UI dashboard, Planner Studio, and multi-agent execution workers so teams can move from issue intake to merged pull request with more control than a simple bot workflow. You can monitor active work in the dashboard, create and refine implementation plans in the browser, and run coding or review jobs with Claude, Codex, and Gemini agents.

## Key Capabilities

- **Web UI Dashboard**: Track task activity, queue health, repository status, usage, and live execution details from the browser
- **Planner Studio**: Build draft plans, attach extra context, generate structured implementation steps, refine them, and execute approved work
- **Multi-Agent Support**: Configure Claude, Codex, and Gemini agents, choose different models, and use the right agent for review or implementation
- **PR Automation**: Use slash commands like `/review`, `/fix`, `/merge`, `/switch`, `/use`, and `/ultrafix` to control follow-up work on pull requests
- **End-to-End GitHub Workflows**: Detect issues, create isolated worktrees and branches, implement changes, and open linked pull requests automatically
- **Production Operations**: Run with retries, state tracking, Docker-isolated agent execution, and real-time dashboard visibility

## How It Works

1. **Connect repositories and agents**: Add monitored repositories, configure coding agents, and set default models in the Web UI.
2. **Choose the entry point**: Let ProPR process labeled GitHub issues automatically, or create a guided plan in Planner Studio.
3. **Generate and execute work**: ProPR prepares repository context, runs the selected agent in an isolated environment, and records the task in the dashboard.
4. **Review and iterate**: Use PR slash commands for AI review, fixes, model switching, merge assistance, or the Ultrafix review-fix loop.
5. **Observe everything**: Follow live task progress, logs, costs, and repository activity from the dashboard and task detail views.

## Quick Start

Ready to get started? Check out our [Setup Guide](./tutorials/setup.md) to configure ProPR for your repositories.

## Documentation Structure

- **[Features](./features/overview.md)**: Current product overview, including the dashboard, Planner Studio, multi-agent execution, and Ultrafix
- **[PR Commands](./features/pr-commands.md)**: Detailed reference for review, fix, merge, model switching, and Ultrafix workflows
- **Tutorials**: Setup and usage guides for getting the platform running
- **Architecture**: Deep dives into agents, workers, GitHub integration, and execution internals
- **Operations**: Deployment, Web UI integration, metrics, and production guidance
- **[Concepts](./concepts/pr-review-guidelines.md)**: Human review expectations for AI-generated changes
