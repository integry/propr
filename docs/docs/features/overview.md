---
sidebar_position: 2
---

# Features

ProPR is a GitHub automation platform with a Web UI control plane, guided planning workflow, multi-agent execution, and PR refinement loops.

For most users, the Web UI is the main way to configure and operate ProPR. Repositories, branches, processing labels, agents, planner settings, and task visibility all live there, while environment variables and scripts mainly bootstrap the deployment.

## Web UI Control Plane

### Dashboard

The dashboard gives you a live operational view of the system and a starting point for day-to-day operations:

- Recent task activity and status
- Queue health and throughput
- Success and failure rates
- Repository breakdowns
- Top model usage and total cost visibility

### Live Task Visibility

Task detail views surface execution progress while work is running, including streamed agent output, task state transitions, and final outcomes. This makes long-running implementations and review passes observable instead of opaque.

### Repository Workspace

The Repositories area is the operational home for monitored repos. From there you can:

- Add or remove repositories
- Configure aliases and per-repo base branches
- Reindex repository knowledge
- Open repo-specific tooling such as summaries and related actions

### AI Agent Management

The Web UI includes an AI Agents area for configuring coding agents, choosing models, setting credential paths, and testing them in a built-in playground. This separates agent configuration from task execution so teams can tune defaults before sending real work through the system.

### Settings and Ops Controls

Administrative settings cover primary processing labels, PR behavior, worker behavior, planner defaults, and model defaults. Combined with the dashboard, this gives teams a browser-based control surface instead of relying only on environment variables and logs.

## Planner Studio

### Draft-Based Planning Workflow

Planner Studio is ProPR's guided planning environment. You create a draft, generate a structured implementation plan, review it, refine it, and then approve it for execution.

### Context Assembly

Planner Studio can gather the context needed to create a stronger plan:

- Repository selection from your monitored repos
- Branch-aware planning based on the configured repository entry
- File and repository context previews
- Attachments and supporting material
- Relevance and context statistics before generation

### Human-in-the-Loop Approval

Plans are not forced straight into execution. Teams can inspect generated steps, edit scope, revise the draft, or send it back for additional refinement before approving implementation.

### Controlled Execution

After approval, Planner Studio can dispatch implementation work in a controlled way:

- Implement individual planned issues
- Implement all approved issues in a plan
- Pause and resume draft execution
- Reset a draft back to setup when the plan needs to be rebuilt

### Branch Resolution Rules

Planner Studio uses the selected repository entry's configured branch rather than ad hoc branch input. See [Repository-Specific Default Branch Configuration](./branch-config.md) for the exact behavior.

## Multi-Agent Execution

### Multiple Agent Providers

ProPR supports multiple coding agent backends, including:

- Claude
- Codex
- Gemini

This lets teams use different agents for different tasks instead of committing to a single provider.

### Model-Aware Routing

Agents can be configured with default models, and follow-up commands can target specific models when needed. Model-specific labeling and routing make it possible to steer review or implementation jobs without changing the rest of the workflow.

### Concurrent Processing

Different tasks, models, or follow-up actions can run concurrently without sharing the same git workspace. ProPR isolates work so multi-agent experimentation does not collapse into branch conflicts.

### Isolated Agent Execution

Agent runs happen in controlled environments with Docker-backed execution and structured output capture. That gives ProPR a stable interface for Claude-style file logs as well as Redis-streamed output used by other agents.

## PR Automation And Follow-Up Commands

### Review And Fix Workflow

ProPR supports PR comment commands that turn pull requests into an active follow-up surface after repositories and defaults are already configured in the Web UI:

- `/review` posts AI review feedback
- `/fix` applies outstanding AI review suggestions
- `/merge` merges the base branch into the PR branch
- `/switch` changes the PR's configured model
- `/use` overrides the model for one follow-up run
- `/ultrafix` runs an automated review-fix loop

See [PR Slash Commands](./pr-commands.md) for full command syntax and examples.

### Editable Review Feedback

AI review comments are intentionally human-editable before `/fix` runs. That means reviewers can trim, rewrite, or remove suggestions so the next implementation pass uses the exact feedback they want.

### Automatic PR Lifecycle Handling

When ProPR creates or updates work, it handles the GitHub plumbing around it:

- Branch creation and pushes
- Issue-linked pull request creation
- Follow-up comment handling
- Status reporting back into the PR

## Ultrafix Loop

### Automated Review-Fix Cycling

Ultrafix is ProPR's closed-loop PR refinement workflow. Instead of running one review and one fix manually, you can ask ProPR to keep iterating until the PR reaches a target score or a maximum cycle count.

### CI-Aware Continuation Rules

Ultrafix does not blindly run back-to-back commands. Between cycles it waits for:

- Required checks to pass
- A configurable cooldown period
- PR inactivity, so it does not race with human pushes or comments

### Configurable Goals

Ultrafix supports score goals, cycle limits, pause durations, and model overrides. That makes it useful both as a light polish pass and as a stronger autonomous cleanup loop.

### Human Circuit Breaker

The loop is controlled by a visible `ultrafix` label on the pull request. Removing that label stops further cycles after the current step, which gives humans a simple way to halt automation without special tooling.

## GitHub And Repository Automation

### Automatic Issue Intake

ProPR can monitor repositories for labeled issues and enqueue them for automated processing. Multiple primary trigger labels are supported, and each trigger label gets its own derived processing and completion labels.

### Deterministic Git Workflow

Execution is separated into clear phases so git state is handled predictably:

1. Repository setup and branch preparation
2. AI execution in an isolated workspace
3. Commit, push, and PR finalization

### Isolated Worktrees

Each task runs in its own git worktree. This allows multiple issues, PR commands, and agents to operate at the same time without trampling one another.

### Repository Knowledge Features

ProPR also builds supporting repository intelligence for planning and navigation, including generated file summaries and indexing-driven repository exploration in the UI.

## Reliability And Observability

### Real-Time System Feedback

The platform exposes live status through the dashboard, task views, and related operational pages so you can see what is running, what is blocked, and where failures occurred.

### Retry And Recovery

GitHub API calls, git operations, and long-running jobs are wrapped with retry and recovery behavior so temporary failures do not immediately derail the workflow.

### State Tracking

Redis-backed state management, queue coordination, and execution metadata make it possible to resume, inspect, and reason about work across agents and workflows.

### Production-Oriented Design

ProPR is designed for running against real repositories with:

- GitHub App authentication
- Per-repository configuration
- Queue-backed workers
- Browser-based operations
- Secure agent execution boundaries
