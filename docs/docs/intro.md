---
sidebar_position: 1
---

# Introduction

Welcome to ProPR, an AI engineering platform for planning, implementing, reviewing, and operating GitHub work from one system.

## What is ProPR?

ProPR combines a Web UI dashboard, Planner Studio, and multi-agent execution workers so teams can move from issue intake to merged pull request in one system. For most teams, the Web UI is the primary place to configure repositories, labels, branches, and agents, then monitor active work, create and refine implementation plans in the browser, and run coding or review jobs with Claude, Codex, and Gemini agents.

## Key Capabilities

- **Web UI Dashboard**: Configure repositories, labels, agents, and operational defaults, then track task activity, queue health, repository status, usage, and live execution details from the browser
- **Planner Studio**: Build draft plans, attach extra context, generate structured implementation steps, refine them, and execute approved work
- **Multi-Agent Support**: Configure Claude, Codex, and Gemini agents, choose different models, and use the right agent for review or implementation
- **PR Automation**: Use slash commands like `/review`, `/fix`, `/merge`, `/switch`, `/use`, and `/ultrafix` for follow-up work on pull requests after the main setup is already handled in the UI
- **End-to-End GitHub Workflows**: Detect issues, create isolated worktrees and branches, implement changes, and open linked pull requests automatically
- **Production Operations**: Run with retries, state tracking, Docker-isolated agent execution, and real-time dashboard visibility

## How It Works

1. **Configure ProPR in the Web UI**: Add monitored repositories, choose base branches, set primary processing labels, and configure coding agents and default models from the browser. Environment variables mainly bootstrap the deployment or seed defaults.
2. **Choose the entry point**: Create a guided plan in Planner Studio, or let ProPR process labeled GitHub issues automatically.
3. **Generate and execute work**: ProPR prepares repository context, runs the selected agent in an isolated environment, and records the task in the dashboard.
4. **Review and iterate**: Use dashboard task views plus PR slash commands for AI review, fixes, model switching, merge assistance, or the Ultrafix review-fix loop.
5. **Observe everything**: Follow live task progress, logs, costs, and repository activity from the dashboard and task detail views.

## Quick Start

Ready to get started? Check out our [Setup Guide](./tutorials/setup.md) to bootstrap the deployment, then finish repository and agent configuration in the Web UI.

## Documentation Structure

- **[Features](./features/overview.md)**: Current product overview, including the dashboard, Planner Studio, multi-agent execution, and Ultrafix
- **[PR Commands](./features/pr-commands.md)**: Detailed reference for review, fix, merge, model switching, and Ultrafix workflows
- **Tutorials**: UI-first setup, issue-to-PR, and Planner Studio guides for getting the platform running and using it day to day
- **Architecture**: Deep dives into agents, workers, GitHub integration, and execution internals
- **Operations**: Deployment, Web UI integration, metrics, and production guidance
- **[Concepts](./concepts/pr-review-guidelines.md)**: Human review expectations for AI-generated changes
