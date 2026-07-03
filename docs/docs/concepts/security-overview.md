---
sidebar_position: 3
title: Security Overview
---

# Security Overview

ProPR is self-hosted: the delivery layer, task history, credentials, and repository clones run on infrastructure you operate. This page describes the trust boundaries, the isolation model, the network surface, and who can make ProPR do work — the model behind the hardening steps in [Secure VPS Deployment](../tutorials/setup-vps-hardening.md).

## Trust Boundaries

| System | Receives | Never receives |
| --- | --- | --- |
| **Your ProPR stack** | Everything: repository clones, plans, prompts, task records, logs, usage data, credentials | — |
| **GitHub** | Branches, commits, pull requests, comments, labels, status checks | Plans, task logs, provider credentials |
| **Selected model provider** | The prompt and code context for the specific task routed to it | Unrelated repositories, other providers' credentials, the task archive |
| **ProPR Connect** (optional) | GitHub webhook payloads it relays, plus the installation metadata needed to route and bill them | Repository contents. Successful deliveries are not stored; failed deliveries are cached briefly for replay |

Model calls go directly from your stack to the provider you configured. ProPR is not a proxy for LLM traffic and never sees or marks up your tokens.

## Isolation Model

Every implementation task runs in its own Docker container and its own Git worktree on a dedicated branch. The agent edits files; it does not commit, push, or open PRs — ProPR performs those Git and GitHub operations deterministically after the agent finishes. The main checkout is never touched, and a wrong result is contained to a branch you can review, retry, or discard. Details: [Execution Safety](../features/execution-safety.md).

Outbound network access from agent containers is **unrestricted by default**. An optional allowlist firewall (model provider, GitHub, DNS only) ships in the agent images but is off by default because it requires privileged containers — do not assume network sandboxing unless you enabled it.

## Network Surface

- **Inbound: none required.** The default event intake is an outbound WebSocket to the routing service, so a stack behind NAT or a firewall works without exposing any port. The API (4000) and Web UI (5173) bind locally; expose them deliberately (reverse proxy, VPN, or the managed [hosted UI tunnel](../operations/deployment.md#hosted-ui-tunnel)).
- **`direct_webhook` mode** (advanced) is the exception: it requires a public `POST /webhook` endpoint and a webhook secret.
- **Unauthenticated endpoints:** `GET /api/compatibility` is intentionally unauthenticated so the hosted UI can check version compatibility before login — the release version of your stack is readable pre-auth. Treat that as public information or keep the API off the public internet.
- API access is protected by session auth (GitHub OAuth) and optional bearer-token auth for automation.
- **Organizations with GitHub IP allow lists**: add your ProPR server's egress IP to the org allow list. The GitHub App deliberately declares no IP allow list of its own — API calls are made by your self-hosted stack from your address, not from ProPR-run infrastructure, so inheriting an App-level list would block your own stack.

## Who Can Trigger Work

Access control is layered, and all of it is enforced by **your** stack — ProPR Connect forwards deliveries without applying policy:

1. **User whitelist** — restricts who can log in to the dashboard and CLI *and* whose GitHub activity (issue labels, comments) starts tasks. Non-whitelisted triggers are rejected; on the relay path the delivery is acknowledged as `ignored: user_not_allowed`, visible in the Connect delivery history.
2. **Blacklist and bot filtering** — explicitly blocked users and bot accounts never trigger work.
3. **Command gating** — PR slash commands run only for allowed authors, and admins choose whether any eligible comment starts a follow-up or an explicit trigger is required.
4. **Identity gate (hardened deployments)** — the [VPS hardening guide](../tutorials/setup-vps-hardening.md) layers an SSO gate (Cloudflare Zero Trust) in front of the UI, before ProPR's own auth.

Configuration lives in the Web UI settings and `.env` — see [GitHub Authentication](../operations/github-auth.md) and the [Configuration Reference](../operations/configuration-reference.md).

## Secrets And Credentials

- **`.env` in the stack root** holds deployment secrets; it is mounted read-only into containers.
- **Agent credentials** (`~/.claude`, `~/.codex`, `~/.gemini`, …) are mounted read-write at their host paths so agent CLIs can refresh their own auth state.
- **GitHub access**: on the default relay path your stack holds a revocable relay token and mints short-lived installation tokens — no GitHub App private key on disk. On the own-App path, the private key stays on your host.
- **Tunnel token**: `PROPR_UI_TUNNEL_TOKEN` is a live Cloudflare credential — keep it in `.env` only.

## Data At Rest

Everything operational lives in the stack directory on your host: the database and application state under `data/`, logs under `logs/`, repository clones and worktrees under `repos/`, and queue state in the Redis volume. Removing a deployment removes the data — see [Teardown](../operations/maintenance.md#teardown).
