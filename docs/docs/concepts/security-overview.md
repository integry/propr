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
| **Selected model provider** | The prompt and code context for the specific task routed to it, plus whatever the agent reads inside its container | Other providers' credentials, the task archive |
| **ProPR Connect** (optional) | GitHub webhook payloads it relays, plus the installation metadata needed to route and bill them | Repository contents. Successful deliveries are not stored; failed deliveries are cached briefly for replay |

Model calls go directly from your stack to the provider you configured. ProPR is not a proxy for LLM traffic and never sees or marks up your tokens.

[Voice Briefings](../features/voice-briefings.md) have a separate browser-vendor boundary. The ProPR server returns text JSON and does not accept raw microphone audio, provide server-side TTS, or keep a call or WebRTC session open. Speech recognition belongs to the browser or operating system and may send audio to its vendor, so it must not be assumed to run locally. Only a confirmed follow-up instruction is sent to ProPR as text through the normal authenticated task or plan API, as applicable.

## Isolation Model

Every implementation task runs in its own Docker container and its own Git worktree on a dedicated branch. The agent edits files; it does not commit, push, or open PRs — ProPR performs those Git and GitHub operations deterministically after the agent finishes. The main checkout is never touched, and a wrong result is contained to a branch you can review, retry, or discard. Details: [Execution Safety](../features/execution-safety.md).

Implementation, follow-up, review-fix, and direct-goal containers receive a
read-only GitHub installation token. GitHub enforces the boundary: agents can
read issues, PRs, check results and repository contents, but cannot push, merge,
label or post issue/PR comments. The worker keeps its full credential outside the container and
authenticates git through process environment variables; shared clone remote URLs
do not contain it. All five adapters mount git metadata and other repositories'
working copies read-only while keeping task files writable. GitHub permits
[creating commit comments with `contents: read`](https://docs.github.com/en/rest/commits/comments#create-a-commit-comment),
so token scoping does not prohibit every possible API mutation. A strict ban on
all API writes requires a host-side read broker.

Cross-repository reads cover the installation by default. Administrators can set
`contextRepositories` to `"none"` or a list of `owner/repository` names in the
repository settings API to restrict both the token and mounted clones to the task
repository plus that list. Public GitHub data remains accessible over the network.
Orchestrated goals retain write access because they create issues and epic PRs.
The token relay must honor scoped mint requests and return scope metadata;
otherwise agent launch fails closed. See [Execution Safety](../features/execution-safety.md#context-repositories)
for the configuration and relay contract.

When a repository has a [workflow file](../features/repository-workflow.md), the container wrapper reports hook and validation results on its own stderr. The agent cannot forge those reports because it runs as the unprivileged `node` user and cannot open the root wrapper's output (`/proc/1/fd/2`). Every agent entrypoint drops to `node` before starting the agent, and the wrapper refuses to start the agent when it runs as root without an unprivileged `node` user and `su-exec`. Output from the agent and repository commands is labelled in segments small enough for atomic pipe writes, so concurrent output cannot place unlabelled bytes at the start of a line. This guarantee depends on a root wrapper: if a container starts as a non-root user, the agent shares the wrapper's user, and every validation result is marked unverified.

Outbound network access from agent containers is **unrestricted by default** (`open` mode). In **restricted** mode, set per instance (optionally enforced) or per repository in `.propr/workflow.yml`, the agent containers of issue, pull request comment, review, goal and indexing jobs start with `--network none` and reach the outside only through a per-run allowlist proxy on the worker: the agent's provider API, GitHub, npm and PyPI, plus the hosts you add. DNS is resolved by the proxy, so the container cannot query DNS at all. No privileged container or extra capability is needed.

Restricted mode is a hostname allowlist, not a content filter: it does not inspect TLS, so an agent can still send data to an allowed host it holds credentials for (such as GitHub). SSH and non-HTTP protocols have no route. Antigravity has not been verified to use the proxy and falls back to open networking with a timeline warning (or is refused when restricted mode is enforced). Restricted mode also covers `/review`, goals and indexing; plan generation currently uses the open network. Every denied host is listed on the task timeline. Each run's proxy socket sits in a directory other accounts on the worker host cannot list, but any account that learns its path can use it for the run's duration to reach that run's allowlisted hosts. On a worker host shared with untrusted accounts, use a dedicated host or VM. See [Restricted network mode](../features/execution-safety.md#restricted-network-mode).

The API and worker use the host Docker socket to launch task containers; the API also uses it for authenticated agent-login sessions. Docker-socket access is root-equivalent control of the host. Treat the API container as part of the trusted control plane, restrict dashboard access, and do not expose the socket to unrelated containers. Login sessions run only the provider-specific allowlisted command in the configured agent image, keep output in memory, and remove their temporary container on completion, cancellation, timeout, graceful shutdown, or the next API startup after a crash.

## Network Surface

- **Inbound: none required.** The default event intake is an outbound WebSocket to the routing service, so a stack behind NAT or a firewall works without exposing any port. The API (4000) and Web UI (5173) bind locally; expose them deliberately (reverse proxy, VPN, or the managed [hosted UI tunnel](../operations/deployment.md#hosted-ui-tunnel)).
- **`direct_webhook` mode** (advanced) is the exception: it requires a public `POST /webhook` endpoint and a webhook secret.
- **Unauthenticated endpoints:** `GET /api/compatibility` and `GET /api/desktop/discovery` intentionally expose only product/version compatibility and desktop-auth capabilities. The rate-limited desktop pairing start/poll endpoints use a high-entropy, body-only device secret and disclose an instance token only after browser-session approval. Treat version metadata as public information or keep the API off the public internet.
- API access is protected by session auth (GitHub OAuth) and optional bearer-token auth for automation.
- **Organizations with GitHub IP allow lists**: add your ProPR server's egress IP to the org allow list. The GitHub App deliberately declares no IP allow list of its own: every API call comes from your self-hosted stack at your own address, so inheriting an App-level list would block your own stack.

## Who Can Manage The Instance

Authenticated users have an instance role:

- **Administrator** — can change installation settings, repositories, agents, trusted runtime packages, and access-role assignments.
- **Member** — can use ProPR's task, plan, repository, and log workflows without changing the installation.

The API enforces permissions independently of the Web UI. Full settings, repository configuration, agent configuration, image metadata, and Agent Tank configuration reads require the corresponding administrator permission. Members receive only a sanitized operational catalog containing enabled repository names and the agent aliases/models needed by task and plan workflows. Member-facing indexing status is independently projected and intersected with the enabled repository-and-branch catalog.

Durable role assignments use the stable numeric GitHub user ID, so a GitHub username change does not transfer that access to another account. A new installation has no implicit administrator: configure at least one username in `PROPR_ADMIN_USERS`, sign in as that user, then use **Web UI → Access** to store the bootstrap role against its numeric GitHub ID and manage other assignments. Outside demo mode, the API refuses to start when neither a bootstrap entry nor a durable administrator exists.

`PROPR_ADMIN_USERS` remains authoritative while configured and can be retained as a break-glass path. It is an independent override rather than a property of a durable assignment, so a user may have both an environment override and a separately editable durable role. It is intentionally username-based, so it does not have the stable-ID guarantee: GitHub usernames can be renamed and eventually reassigned. Remove bootstrap entries after storing durable access, or audit the list whenever an administrator renames or deletes an account. Bootstrap entries are not counted by last-durable-administrator protection because they can be changed outside the database. The role audit retains the most recent 10,000 changes.

Durable authorization is deliberately read from the database on every authenticated API request. This adds one indexed lookup for non-bootstrap users, but makes a demotion or removal effective on that user's next request without a cache-expiry window.

Instance roles and the GitHub trigger whitelist are intentionally separate: a role controls what an authenticated dashboard or CLI user may administer; the whitelist controls who may log in and whose GitHub activity can trigger work.

## Who Can Trigger Work

Access control is layered, and all of it is enforced by **your** stack — ProPR Connect forwards deliveries without applying policy:

1. **User whitelist** — restricts who can log in to the dashboard and CLI *and* whose GitHub activity (issue labels, comments) starts tasks. Non-whitelisted triggers are rejected; on the relay path the delivery is acknowledged as `ignored: user_not_allowed`, visible in the Connect delivery history.
2. **Blacklist and bot filtering** — explicitly blocked users and bot accounts never trigger work.
3. **Command gating** — PR slash commands run only for allowed authors, and admins choose whether any eligible comment starts a follow-up or an explicit trigger is required.
4. **Identity gate (hardened deployments)** — the [VPS hardening guide](../tutorials/setup-vps-hardening.md) layers an SSO gate (Cloudflare Zero Trust) in front of the UI, before ProPR's own auth.

Configuration lives in the Web UI settings and `.env` — see [GitHub Authentication](../operations/github-auth.md) and the [Configuration Reference](../operations/configuration-reference.md).

## Secrets And Credentials

- **`.env` in the stack root** holds deployment secrets; it is mounted read-only into the service containers, not into agent containers.
- **Agent credentials** are mounted read-write so agent CLIs can refresh their own auth state. Direct-login accounts are isolated by agent ID below ProPR's managed credential root (`~/.propr/agent-credentials` for native/Compose installs or the launcher data directory); reused host accounts keep their configured paths (`~/.claude`, `~/.codex`, `~/.gemini`, …).
- **GitHub access**: on the default relay path your stack holds a revocable relay token and mints short-lived installation tokens — no GitHub App private key on disk. On the own-App path, the private key stays on your host.
- **Tunnel token**: `PROPR_UI_TUNNEL_TOKEN` is a live Cloudflare credential — keep it in `.env` only.

## Data At Rest

Application state lives in the stack directory on your host: the database under `data/`, logs under `logs/`, and queue state in the Redis volume. Repository clones and task worktrees live on the host under `/tmp/git-processor` by default (`GIT_CLONES_BASE_PATH`, `GIT_WORKTREES_BASE_PATH`). Direct-login credentials live in the managed credential root, which is below `~/.propr` for native/Compose installs or below the launcher data directory. Treat that root as persistent secret data when backing up or removing a deployment — see [Teardown](../operations/maintenance.md#teardown).

## Connected clients and private media

[MCP connections](../features/mcp.md) use separate OAuth grants with a scope ceiling
and explicit repository consent. Instance membership and repository authorization
are rechecked on calls; GitHub REST bearer credentials are not MCP access tokens.
Revoking a connected app invalidates its grant. The MCP access log records metadata
without tool arguments or result bodies.

[Desktop pairing](../operations/desktop-pairing.md) approves a connection in the
browser and keeps credentials behind the native boundary. Private PR preview
images use authenticated application media access; [managed originals](../features/visual-previews.md)
require Connect sign-in and repository authorization. A screenshot URL is not an
access grant.
