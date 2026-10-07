---
sidebar_position: 5
---

# Isolated And Safe Execution

ProPR separates agent runs from git and GitHub operations. Agents focus on implementation inside controlled workspaces; the system handles branch setup, commits, pushes, pull request creation, labels, retries, and recovery.

## Execution Boundaries

Each task runs in its own boundary:

- A dedicated git worktree
- A task-specific branch
- A dedicated Docker container for the agent run
- Structured output capture
- A durable task record

This makes concurrent work possible across issues, PR comments, and models without sharing the same mutable checkout. When several `llm-*` model labels run against the same issue, each model gets its own worktree, branch, and pull request.

## Three-Phase Deterministic Workflow

Worker execution is split into three phases. The agent only participates in the middle one:

1. **Pre-agent setup (ProPR)**: pull the job from the queue, update the base branch, create the isolated git worktree, create the task branch, and prepare the prompt and context.
2. **Agent implementation (agent)**: run the selected agent inside its container against the worktree. The agent edits files. Read-only git metadata and a read-only GitHub token reserve commits, pushes, and GitHub mutations for ProPR.
3. **Post-agent finalization (ProPR)**: inspect changed files, commit, push to GitHub, create or update the pull request with issue linking, and update labels and task state.

Because the git and GitHub steps are deterministic code rather than agent decisions, branch mistakes are rare and failures are easier to attribute: a failure in phase 1 or 3 is a git/GitHub problem, a failure in phase 2 is an agent problem.

## Worktree And Branch Isolation

ProPR reuses one clone per repository and creates a separate git worktree per task. Clone and worktree locations are configurable:

```bash
GIT_CLONES_BASE_PATH=/tmp/git-processor/clones
GIT_WORKTREES_BASE_PATH=/tmp/git-processor/worktrees
```

Worktree isolation matters when:

- Multiple issues run at the same time
- Several models are processing the same issue in parallel
- A PR follow-up runs while another task is queued
- A failed job needs to be inspected without blocking new work

Branch names include the model identifier, so concurrent multi-model runs never collide and every branch can be traced back to the agent and model that produced it.

## Containerized Agent Runs

Each agent run starts a dedicated container from the unified `propr/agent` image. The container gets:

- The task worktree mounted as its working directory
- The agent's credential directory (for example `~/.claude`, `~/.codex`, `~/.gemini`) mounted read-write into the container's home so the CLI can refresh auth state (Vibe's config is mounted read-only)
- For all five agents, read-only git metadata and shared clones (`/tmp/git-processor`). The task worktree is writable, but its `.git` entry is mounted read-only. Other repositories' working copies cannot be changed.
- Implementation, follow-up, review-fix, direct-goal, and repository-associated analysis runs receive a read-only installation token as `GH_TOKEN`. It grants `contents`, `issues`, `pull_requests`, and `metadata` reads, plus `checks`, `actions`, and `statuses` reads when the installation grants those optional permissions. `gh issue view`, `gh pr view`, `gh pr checks` (with the optional CI permissions), and cloning/fetching related repositories work; pushes, merges, issue/PR comments, and label changes are refused by GitHub. Fetch into an agent-created clone; shared clone metadata remains read-only.
- Memory, CPU, and process limits (defaults `6g`, up to 4 CPUs, and 512 PIDs; override with `AGENT_CONTAINER_MEMORY_LIMIT`, `AGENT_CONTAINER_CPU_LIMIT`, `AGENT_CONTAINER_PIDS_LIMIT`) and the `no-new-privileges` security option
- A per-agent timeout (`CLAUDE_TIMEOUT_MS`, `CODEX_TIMEOUT_MS`, `ANTIGRAVITY_TIMEOUT_MS`, `OPENCODE_TIMEOUT_MS`, `VIBE_TIMEOUT_MS`)
- A stall and degenerate-output watchdog: a run with no output for `AGENT_STALL_TIMEOUT_MS` (10 minutes; 30 minutes, `AGENT_TOOL_STALL_TIMEOUT_MS`, while a silent tool call runs), or with `AGENT_DEGENERATE_OUTPUT_LIMIT` (50) consecutive whitespace-only text deltas, is stopped instead of holding its worker slot and repository capacity until the timeout

GitHub's permission names are not a blanket ban on every mutation: its
[Create a commit comment endpoint](https://docs.github.com/en/rest/commits/comments#create-a-commit-comment)
accepts `contents: read`. Commit comments are therefore an exception to this
boundary. Preventing every API mutation would require a host-side read broker
instead of giving agents a GitHub token.

ProPR's worker retains its full installation credential. Git authenticates through
worker process environment variables, not token-bearing remote URLs in shared
clone configuration. Existing token-bearing clone URLs are removed before agents
can see them. User-configured GitHub credential environment variables cannot
override the agent token.

Orchestrated goals are the explicit exception: they retain write-capable tokens
and git mounts so they can create issues and epic PRs. Their permissions are not
narrowed further in this release.

### Context repositories

By default, agent tokens retain read access to every repository covered by the
installation; no repository filter is sent when minting them. Administrators can
set `contextRepositories` on a repository entry through the repository settings
API (`POST /api/config/repos`, within `repos_to_monitor`):

- `"all"` (or omitted): all installation repositories and local clones.
- `"none"`: only the task repository.
- `["owner/shared-library", "owner/sibling-service"]`: the task repository plus
  the listed repositories. Only those local clones and the task's linked git metadata are mounted. GitHub access to
  private repositories outside the list is refused; public data remains public.

Analysis runs use the same repository policy for tokens and mounted clones. Analyses
without a repository context receive no GitHub token or shared clone mounts.
Repository inspection remains credential-free. Unresolvable configured repositories
stop launch with an error naming the entry and settings to correct; aliases resolving
to the same repository use one token repository ID.

Restrictions also apply to orchestrated goals' repository reach. Multiple branch
entries for the same repository use the intersection of their explicit lists.
Older clients that omit the field preserve the stored restriction.

The token relay must support `permissions` and `repository_ids` on its
`/installation-token` request and return GitHub's minted `permissions` and
`repositories` metadata. Unsupported or broader responses stop agent launch;
there is no fallback to the worker token. Own-App deployments mint scoped tokens
directly using GitHub's installation access-token endpoint. The App installation
must grant the required read permissions; see [own-App prerequisites](../operations/github-auth.md#app-mode-own-github-app).

The image-based install starts service and agent containers from published images. Source builds can use local images during development.

## Restricted Network Mode

Agent containers run in one of two network modes:

- **`open`** (the default): the container is on Docker's bridge network with ordinary outbound access.
- **`restricted`**: the container is started with `--network none`, so it has no network interface except loopback. Its only route out is a Unix socket, bind-mounted read-only from the worker, behind which a per-container HTTP/HTTPS proxy accepts connections only to allowlisted hosts. No `--privileged` flag, `NET_ADMIN` capability or iptables rules are involved.

### How a restricted run works

1. Before `docker run`, the worker starts an allowlist proxy on a Unix socket in its own directory under `PROPR_EGRESS_SOCKET_DIR` (default `/tmp/propr-egress/<run id>/proxy.sock`). Every agent container gets its own socket and directory, so concurrent runs on one worker never share a port or a proxy. The directories are traversable but not listable (`0711`), so other accounts on the worker host cannot enumerate run sockets.
2. The container starts with `--network none` and that directory mounted at `/run/propr-egress`. Before setup hooks and the agent run, a small bridge in the container exposes the socket as `127.0.0.1:3128`.
3. `HTTP_PROXY`, `HTTPS_PROXY` (and their lowercase forms) point at `http://127.0.0.1:3128`, `NO_PROXY` covers loopback, and Git gets `http.proxy` through `GIT_CONFIG_*`. Any proxy variables configured for the agent are replaced.
4. The proxy accepts `CONNECT host:port` tunnels (HTTPS, Git, package managers) and plain `http://` requests. A denied target gets `403 Forbidden` and is counted. An allowed target that cannot be reached gets `502 Bad Gateway`, and the failure is counted too. A plain HTTP response that the upstream cuts off mid-body is cut off for the container as well, so the client sees a failed transfer and does not hang.
5. When the container exits, its proxy closes and its socket directory is removed. If removing the directory fails, the failure is logged and does not change the run's result; the periodic sweep removes the directory later.
6. If the worker itself reaches the internet only through a proxy, set the standard `HTTPS_PROXY`/`HTTP_PROXY` (and `NO_PROXY`) variables on the worker. Allowed connections are then chained through that proxy (`CONNECT` over `CONNECT`, credentials from the proxy URL), and `NO_PROXY` hosts are reached directly. The allowlist is still enforced first, on the worker.

**DNS** is resolved by the proxy, on the worker. The container has no resolver to query, so DNS cannot be used as a side channel. The proxy connects to the address it resolved and checked, so a second lookup cannot answer differently.

**Private addresses.** The proxy connects from the worker's network position, which reaches more than an open container does: the worker's loopback and, in the bundled Compose stack, the Redis service on its private network. So a connection to a loopback, private (RFC 1918, unique local), carrier-grade NAT, link-local (including `169.254.169.254`) or IPv4-mapped form of those addresses is refused (403, listed as denied) whether it is named directly or by a hostname that resolves to one. To reach such an address, an administrator lists it as an IP literal in `agent_network_allow` (for example `10.0.0.5:5000`); a hostname entry that resolves to that address is then allowed too. Repository `network.allow` entries never open one. Through a worker proxy the hostname is sent on for that proxy to resolve, but a name the worker resolves to a private address is still refused.

**Timeouts.** Connecting to an upstream, and a worker proxy's answer to the chained `CONNECT`, must complete within 30 seconds; otherwise the client gets `504 Gateway Timeout` and the run's report counts a failed connection. An established connection has no deadline.

### What is allowed

Each agent gets a built-in base list, plus the instance and repository additions:

| Agent | Provider hosts |
| --- | --- |
| Claude Code | `api.anthropic.com`, `console.anthropic.com`, `platform.claude.com` |
| Codex | `api.openai.com`, `auth.openai.com`, `chatgpt.com` |
| Antigravity | `generativelanguage.googleapis.com`, `cloudcode-pa.googleapis.com`, `oauth2.googleapis.com` (see compatibility below) |
| OpenCode | `opencode.ai`, `models.dev`, `api.anthropic.com`, `api.openai.com`, `openrouter.ai`, `generativelanguage.googleapis.com` |
| Vibe | `api.mistral.ai` |

Every agent also gets `github.com`, `api.github.com`, `codeload.github.com`, `uploads.github.com`, `objects.githubusercontent.com`, `raw.githubusercontent.com`, `registry.npmjs.org`, `registry.yarnpkg.com`, `pypi.org` and `files.pythonhosted.org`.

Allowlist entries are exact hostnames (`registry.example.com`), wildcards that match subdomains but not the apex (`*.internal.example.com`), or IP literals. Without a port, an entry allows ports 80 and 443; `host:port` allows only that port. IP literals are denied unless that exact address is listed; wildcards never match an IP address. A bare `*` or a one-label wildcard such as `*.com` is rejected. Private addresses need an instance IP-literal entry, as described above.

### Choosing the mode

- **Instance** (Settings → Automation → Agent network, `propr setting update agent_network_mode restricted`, or MCP `update_execution_settings`): `agent_network_mode` sets the default mode, `agent_network_allow` adds hosts for every restricted run, and `agent_network_mode_enforced` makes restricted mode mandatory. With enforcement, `agent_network_ignore_repository_allow` also ignores the hosts repositories add, so every run is bounded by the instance list. Environment defaults: `AGENT_NETWORK_MODE`, `AGENT_NETWORK_ALLOW` (comma separated), `AGENT_NETWORK_MODE_ENFORCED` and `AGENT_NETWORK_IGNORE_REPOSITORY_ALLOW`. The policy is read for every run, so a change applies to the next run without a restart. If the stored policy cannot be read, the run fails rather than running open.
- **Repository** (`.propr/workflow.yml`, see [Repository workflow](./repository-workflow.md#network)): `network.mode` can tighten an open instance to `restricted`, or relax a non-enforced restricted default to `open`. `network.allow` adds hosts. When the instance enforces restricted mode, `network.mode: open` is ignored (the timeline says so), but `network.allow` still applies unless `agent_network_ignore_repository_allow` is set.

Restricted mode covers the agent containers of issue jobs and pull request comment jobs (implementations, follow-ups, `/fix` and the other PR commands that job runs), `/review` (its repository-inspection context scout and every reviewer), goals (including native goal sessions) and indexing summarization, with or without a workflow file. The repository's `network` block applies to issue, pull request comment and review jobs. Goals and indexing follow the instance policy. As a safety net, an agent container that a worker or indexing worker starts outside any of these runs follows the instance policy when it enforces restricted mode, rather than running open; its report is logged. Plan generation runs in the API process and currently uses the open network.

Inside a restricted run, every `docker run` is subject to the policy unless it already has no network (`--network none`). That includes containers on the default network, `bridge`, `host` and custom networks. The one deliberate exemption is ProPR's own usage probe (Agent Tank), which runs only ProPR code with read-only credential mounts and keeps its network to read provider usage APIs.

### Agent compatibility

Restricted mode relies on each agent CLI honouring the standard proxy variables for its API traffic:

| Agent | Status |
| --- | --- |
| Claude Code | Supported. Claude Code honours `HTTPS_PROXY`/`HTTP_PROXY`. |
| Codex | Supported. Codex CLI honours `HTTPS_PROXY`/`HTTP_PROXY`. |
| OpenCode | Supported. OpenCode runs on Bun, whose HTTP client honours the proxy variables. |
| Vibe | Supported. Vibe uses httpx, which honours the proxy variables. |
| Antigravity | **Falls back to `open`.** The Antigravity CLI has not been verified to send its Google sign-in and API traffic through the proxy, so its containers run with the open network and the task timeline records a warning. When the instance enforces restricted mode, Antigravity runs are refused instead. |

A scheduled CI job (`.github/workflows/restricted-network-smoke.yml`, also run on pull requests that change the proxy) runs the published agent image behind the proxy. It checks the socket mount, the bridge and allow/deny decisions, and runs each supported CLI against its real provider with an invalid credential. The provider's authentication error shows that the CLI's real transport, including Codex's WebSocket and SSE streams, went through the proxy.

`git`, `gh`, `curl`, `npm`, `pip` and `uv` inside the container use the proxy. Tools that ignore the proxy variables (for example Node.js `fetch()` in repository scripts, which ignores them unless `NODE_USE_ENV_PROXY=1` is set on Node 24 or later) fail to connect rather than bypassing the policy.

### Observability

At the end of each restricted run the task timeline gets one **Restricted Network** event with the mode, where it came from, any agent that fell back to open networking or was refused, every denied host with its attempt count, and any allowed connection that failed upstream (for example, one a worker proxy refused). The event is labelled by what the run's containers finally did: if a refused agent is followed by one that ran behind the proxy, the label reflects the proxied run and the refusal appears as a detail line. A run that ended before any agent container started says so. Indexing has no task timeline, so it logs a run's report only when a connection was denied or failed, or an agent fell back or was refused. The task detail shows the first hosts by name and counts the rest; the full list is in the event metadata. Beyond 100 distinct denied hosts per run, further hosts are counted (hosts and attempts) rather than named, so no denial is dropped from the record. A failed or cancelled run still records its event.

### Limitations

- The proxy allowlists hostnames; it does not inspect TLS traffic. An agent with credentials for an allowed host (for example a GitHub token) can still send data to that host.
- Only HTTP(S) through the proxy works. SSH (`git@github.com:`), raw TCP and UDP have no route; use HTTPS remotes.
- An allowlisted wildcard trusts every public address its DNS zone resolves to.
- The worker and the Docker daemon must see the socket directory at the same path, or `HOST_PROPR_EGRESS_SOCKET_DIR` must name the Docker host path for `PROPR_EGRESS_SOCKET_DIR`. The bundled Compose files and launcher mount `/tmp/propr-egress`. Docker Desktop file sharing does not support Unix sockets, so restricted mode needs a Linux Docker host. If the socket is missing, the container logs `ProPR restricted network: egress proxy socket ... is missing` and has no network at all.
- A run's socket accepts connections from any account on the worker host that knows its path (the container's user differs from the worker's). The directories cannot be listed, but the path appears in the `docker run` command line. Such an account could use the proxy for the run's duration to reach the run's allowlisted hosts, and nothing else. On a worker host shared with untrusted accounts, run the worker on a dedicated host or VM.
- Proxies run in the worker process. If the worker dies, its restricted containers lose their network (they fail closed); the worker removes socket directories left by dead workers in its own PID namespace at startup and every 10 minutes, and any directory not refreshed for 48 hours. Directories left by a worker container that has since restarted are removed by that age rule.

ProPR no longer ships the old iptables firewall script (`scripts/init-firewall.sh`). It needed privileged containers, so no entrypoint ever ran it.

## Spend Caps

A per-run spend cap stops a run whose estimated cost reaches a limit, instead of letting it spend until the execution timeout. The cap applies to issue implementations, PR follow-ups, `/fix`, ultrafix cycles and reviews; goals keep their own controls.

The cap is resolved per run, highest precedence first:

1. A per-task override: `maxCostUsd` on `POST /api/task-submissions` or the MCP `create_task` tool, or `propr issue implement --max-cost <usd>`.
2. `limits.max_cost_usd` in the repository's [`.propr/workflow.yml`](./repository-workflow.md).
3. The instance `default_max_cost_usd` setting (Settings → Automation → General configuration, `propr setting update default_max_cost_usd <usd>`, or MCP `update_execution_settings`). Empty or `0` means no cap.

A level that is unset or `0` defers to the next one. A malformed or negative value is logged as a warning and treated as no cap at that level; it never cancels runs at $0.

While the run executes, ProPR adds the recorded cost of the task's LLM calls (`llm_executions`, including summarization and analysis calls attributed to the task) to the usage its live agent containers have streamed so far, and checks the total every few seconds. When it reaches the cap:

- the agent container is stopped through the same container teardown that a user stop uses, but the run is treated like a timeout: its partial changes are committed and published, with a warning that the work may be incomplete. Later steps of the same run that publish that work are not stopped again;
- the task timeline records a `budget.exceeded` event with the cap, the observed spend and where the cap came from (task override, `.propr/workflow.yml` or instance default);
- an Inbox notification (task category) and a short comment on the issue or pull request say the run stopped at its cap;
- the task ends with terminal reason `cost_cap_exceeded`.

Retries share the budget. When ProPR re-queues a task (a provider usage-limit re-queue or a BullMQ retry), the retry may spend only what earlier attempts left. Task details, `propr task get --json` (`budget`) and the task history API show the cap, the spend and the percentage used.

Spend is an estimate from token counts and model pricing (see [Cost Tracking](../operations/metrics.md#cost-tracking)), so a run can overshoot the cap by the usage reported between two checks. `LLM_COST_THRESHOLD_USD` is separate: it only records a high-cost alert and never stops a run.

## Failure Handling And Recovery

Safe runs are also about what happens when something fails:

- Git and GitHub operations retry transient failures with exponential backoff (with jitter).
- Job state lives in Redis with correlation IDs, so every log line can be traced to a task.
- Task records capture where the failure happened; logs and streamed output remain available for inspection.
- Failed runs update the issue's state label (`<trigger>-failed-*`) instead of leaving it ambiguous.
- A hung or degenerate agent run is stopped by the activity watchdog and finishes with `terminalReason` `stalled` or `degenerate_output`. Its partial work is published like a timed-out run's, a comment on the issue or PR explains the stop, the Inbox notifies you, and the task timeline records which rule tripped. Tune or disable the thresholds in **Settings → Automation → Agent watchdog**; see [Worker architecture](../architecture/worker.md#stall-and-degenerate-output-watchdog).
- Revert operations run as signed system tasks: requests are authorized with `SYSTEM_TASK_SECRET`, so a revert cannot be injected through normal intake paths.

For operational details, see [Observability And Control](./observability.md) and the architecture pages.

## Goals and recovery

[Direct goals](./goals.md) use a long-lived workspace and draft PR with coherent
checkpoints. ProPR owns commits and pushes; checkpoint cadence is guidance, not a
forced timer. Orchestrated goals let the agent decompose work and submit it through
ProPR. Corrective input and pause/cancel acknowledgement follow the provider's
capabilities and execution boundaries.

Task reconciliation persists completion and recovery state. Follow-up cleanup
finishes before releasing its worktree lock, and interrupted CI cancellation
retains a restart obligation for a still-current PR head. See [CI cancellation](./pr-followup.md#cancelling-obsolete-checks-during-follow-up)
for opt-in workflow selection and recovery behavior.
