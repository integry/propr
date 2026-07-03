---
sidebar_position: 2
title: FAQ
---

# Frequently Asked Questions

**Does my code leave my infrastructure?**
Repository clones, plans, task records, logs, and credentials stay in your self-hosted stack. Two external systems see parts of your work: GitHub (branches, PRs, comments — where it already lives) and the model provider you route a task to (the prompt and code context for that task). The optional ProPR Connect relay forwards GitHub webhook events to your stack but never receives repository contents. See the [Security Overview](./concepts/security-overview.md).

**Do I have to use ProPR Connect?**
No. Connect is the zero-config path (shared GitHub App + token relay + delivery replay). You can register your own GitHub App instead and receive events by direct webhook or polling — no ProPR-hosted service involved. See [GitHub Authentication](./operations/github-auth.md).

**What does ProPR cost?**
The software is free and open source (Apache 2.0). You pay your AI providers directly — existing subscriptions work, and ProPR never marks up tokens. ProPR Connect is free for up to 3 users per installation; more seats and the managed hosted-UI tunnel are part of the paid Plus tier.

**Which agents and models can I use?**
Claude Code, Codex, Antigravity, OpenCode, and Mistral Vibe — on subscription-backed logins or API keys, switchable per task and per phase with `llm-*` labels or `/switch`. See [Agents and Models](./features/agents-and-models.md).

**Is the agent sandboxed?**
Each task runs in its own Docker container and Git worktree, and ProPR — not the agent — performs all Git and GitHub operations. Outbound network access is unrestricted by default; an optional allowlist firewall exists but requires privileged containers. See [Execution Safety](./features/execution-safety.md).

**Can I run it offline or air-gapped?**
No. ProPR needs GitHub and your model providers to do its job. The documentation is bundled for offline reading (`propr docs`), but the workflow itself is GitHub-centered.

**Does it work with GitLab or Bitbucket?**
No — the whole loop is built on GitHub's APIs: pull requests, review comments, checks, and comment commands.

**What happens when a run fails?**
The task record keeps the prompt, logs, and failure state; issues get `AI-failed-*` labels; and you retry, switch models, or revert from the PR conversation or dashboard. See [Troubleshooting](./operations/troubleshooting.md).

**Who can make ProPR do work?**
A user whitelist gates the dashboard, the CLI, and GitHub-triggered work; bots are filtered; PR commands run only for allowed authors. See [Who Can Trigger Work](./concepts/security-overview.md#who-can-trigger-work).

**Where is my data stored, and how do I remove it?**
In the stack directory on your host (`data/`, `logs/`, `repos/`, plus the Redis volume). The [Teardown guide](./operations/maintenance.md#teardown) lists every artifact to remove.
