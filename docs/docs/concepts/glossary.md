---
sidebar_position: 4
title: Glossary
---

# Glossary

**Agent** — a coding CLI ProPR runs inside an isolated container: Claude Code, Codex, Antigravity, OpenCode, or Mistral Vibe.

**Agent Tank** — an optional companion tool that tracks subscription capacity and rate-limit usage per agent (not API spend). See [Agent Tank](../operations/agent-tank.md).

**Epic mode** — running a plan's issues as an ordered chain: each PR must merge (optionally auto-merging on green CI) before the next task starts. See [Work Splitting](../features/work-splitting.md).

**Follow-up** — a task created from PR feedback (a comment or slash command) that lands as another commit on the same branch. See [PR Follow-up](../features/pr-followup.md).

**Hosted UI tunnel** — the optional managed Cloudflare Tunnel that publishes a local stack's API at `https://t-<id>.propr.dev` so the hosted UI at `app.propr.dev` can drive it. See [Deployment](../operations/deployment.md#hosted-ui-tunnel).

**Intake mode** — how GitHub events reach the stack: `routing_websocket` (default, outbound connection via the relay), `polling`, or `direct_webhook`. See [Deployment](../operations/deployment.md#issue-intake-modes).

**`llm-*` label** — a GitHub issue label that routes work to a specific agent and model, e.g. `llm-claude-opus48`. Several on one issue produce one run, branch, and PR per model.

**Planner Studio** — the planning surface: draft, context preview, generated task breakdown, refinement, and approval. See [Planner Studio](../tutorials/planner-studio.md).

**Processing label** — the trigger label (such as `AI` or `propr`) that tells ProPR to pick up an issue; state labels (`AI-processing`, `AI-done`, `AI-failed-*`) track progress.

**ProPR Connect** — the hosted bridge: GitHub App webhook relay, delivery replay, relay-token issuance, and tunnel provisioning. It never runs agents or sees repository contents. See [ProPR Connect](../operations/propr-connect.md).

**Relay (token relay)** — the default GitHub auth mode: your stack holds a revocable relay token and mints short-lived installation tokens through Connect instead of storing a GitHub App private key.

**Seat** — a distinct developer using a Connect installation in a billing cycle; the Community tier includes 3.

**Task** — one unit of agent work with its own record: prompt, isolated run, logs, usage, commits, and resulting PR or follow-up.

**Ultrafix** — the automated review-fix loop: `/review` scores the PR, fixes are applied, and cycles repeat until the target score, cycle limit, or a human stop. See [PR Comment Commands](../features/pr-commands.md#ultrafix).

**Worktree** — the dedicated Git working directory each task gets, paired with its own branch and container, so parallel tasks never collide and the main checkout stays untouched.
