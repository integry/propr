---
sidebar_position: 6
---

# Agent Runtime Reference

This is the canonical runtime reference for ProPR coding agents. It covers the shared Docker execution model used by Claude Code, Codex, Antigravity, OpenCode, and Mistral Vibe. For the higher-level integration contract, routing model, and worker responsibilities, see [Coding Agent Integration](./coding-agent-integration.md).

## Runtime Model

By default, each coding agent runs in a Docker container so ProPR can control runtime dependencies, workspace mounts, credential mounts, timeouts, logging, and resource boundaries. The agent implementation changes the CLI command, image, credential directory, and output parser, but the container shape is shared:

- A task worktree mounted at `/home/node/workspace`
- Agent credentials from a ProPR-managed per-agent directory or a configured existing host directory. Task and analysis runs get a per-run copy holding only the provider's credential and config files, and refreshed tokens are written back after the run (see [Per-run credential copies](../features/execution-safety.md#per-run-credential-copies)).
- GitHub credentials passed through `GH_TOKEN` and `GITHUB_TOKEN`
- Agent, model, timeout, and task metadata passed as environment variables or CLI flags
- `--security-opt no-new-privileges`, `--cap-add CHOWN` (Vibe omits it), and Docker's default `bridge` network; the repository setup hook runs without sudo privileges before the agent entrypoint
- Memory, CPU, and process limits from `AGENT_CONTAINER_MEMORY_LIMIT` (default `6g`), `AGENT_CONTAINER_CPU_LIMIT` (default: available CPUs, capped at 4), and `AGENT_CONTAINER_PIDS_LIMIT` (default `512`)
- For every agent except Vibe, the host's `/tmp/git-processor` directory (all clones and worktrees) mounted at the same path so git works in the linked worktree
- Structured stdout, stderr, exit code, duration, session ID, and token usage capture when the CLI exposes those fields

Docker agents run from the unified Debian/glibc `propr/agent` image. Its internal base stage includes Node.js 22, Git and repository tooling, a scoped `gh` wrapper, and entrypoint support used by the worker. The image uses Node.js 22 to satisfy current agent CLI engine requirements. Independent CLI build stages preserve Docker cache reuse when one configured version changes.

This table maps each agent type to the unified image, its type-specific entrypoint, and its credential mount; other pages link here instead of repeating it.

| Agent | Image | Dockerfile | Entrypoint | Existing host credential mount | Container credential path |
| --- | --- | --- | --- | --- | --- |
| Claude Code | `propr/agent` | `Dockerfile.agent` | `scripts/claude-entrypoint.sh` | `HOST_CLAUDE_DIR` (`~/.claude`) | `/home/node/.claude` |
| Codex | `propr/agent` | `Dockerfile.agent` | `scripts/codex-entrypoint.sh` | `HOST_CODEX_DIR` (`~/.codex`) | `/home/node/.codex` |
| Antigravity | `propr/agent` | `Dockerfile.agent` | `scripts/antigravity-entrypoint.sh` | `HOST_ANTIGRAVITY_DIR` (`~/.gemini`) | `/home/node/.gemini` |
| OpenCode | `propr/agent` | `Dockerfile.agent` | `scripts/opencode-entrypoint.sh` | `HOST_OPENCODE_XDG_DIR` (`~/.config/opencode`) plus `HOST_OPENCODE_DATA_DIR` | `/home/node/.config/opencode` |
| Mistral Vibe | `propr/agent` | `Dockerfile.agent` | `scripts/vibe-entrypoint.sh` | `HOST_VIBE_DIR` (`~/.vibe`) | `/home/node/.vibe` |

Agent runs go through the runtime seam described in [Coding Agent Integration](./coding-agent-integration.md#runtime-seam). Docker is the default runtime (`PROPR_AGENT_RUNTIME=docker`). Remote agent runs can use [Fly Machines](#fly-machines-runtime) or [Fly Sprites](#fly-sprites). The container shape below is how `DockerRuntime` renders each provider's `AgentRunSpec`. With `PROPR_WORKSPACE_TRANSPORT=clone`, the worktree and git mounts are left out. The container clones the task base with a short-lived repository-scoped token and returns its result through a temporary `refs/propr/runs/<runId>/result` ref, falling back to a bundle. It also runs without `--rm` so the worker can read the result files before removing it. See [Workspace Transport](./coding-agent-integration.md#workspace-transport).

## Fly Machines Runtime

`PROPR_AGENT_RUNTIME=fly-machines` (or an agent's `runtime: fly-machines`) creates one Fly Machine per run through the Machines API (`api.machines.dev/v1`). Machines boot from OCI images, so the `propr/agent` image runs unchanged with the same entrypoints. Use it when you need exact image parity or more memory than the worker host has.

| Variable | Meaning |
| --- | --- |
| `PROPR_FLY_API_TOKEN` (fallback `FLY_API_TOKEN`) | Deploy token scoped to the app: `fly tokens create deploy -a <app>`. Required. |
| `PROPR_FLY_APP` | App the run Machines are created in. Required. |
| `PROPR_FLY_REGION` | Region code, for example `ams`. When unset, Fly picks the region. |
| `PROPR_FLY_MACHINE_SIZE` | `shared-cpu-<n>x` or `performance-<n>x` (default `performance-2x`). |
| `PROPR_FLY_MACHINE_MEMORY_MB` | Memory in MB. Defaults to the run's memory limit (`AGENT_CONTAINER_MEMORY_LIMIT`), else the preset's. |
| `PROPR_FLY_IMAGE` | Pullable image to run instead of the run's own reference. Reference it by digest, for example `registry.fly.io/<app>@sha256:<digest>` (see **Agent image** below). Locally built images are not visible to Fly. |
| `PROPR_FLY_PRIVATE_NETWORK` | `auto` (default: on when the control plane runs on Fly), `on` or `off`. |
| `PROPR_FLY_PREWARM` | `1` pulls `PROPR_FLY_IMAGE` in the region when the runtime starts. A throwaway Machine runs `/bin/true`, and the pull time is logged. |
| `PROPR_FLY_RESULT_LINGER_SECONDS` | How long a finished Machine waits for the worker before it destroys itself (default and minimum 7200). The wait starts when the agent exits, and the worker cannot extend it. So it must outlast the worker's worst case: noticing the exit, reading the output, then retaining the Machine or removing it 10 minutes after the run settled. That worst case is about 67 minutes, with every request answered just inside its timeout. Normally the worker destroys the Machine as soon as it has the result. The full wait only applies when the worker is gone. A run the worker retains (its result may exist only in the Machine) waits until it is released. |

**Agent image.** Build `Dockerfile.agent` and push it to the app's registry, then set `PROPR_FLY_IMAGE` to the pushed image by digest: `registry.fly.io/<app>@sha256:<digest>`. Do not rely on a tag. `fly deploy --build-only --push --image-label <label>` on an app with no releases yet pushed the image by digest only, so `registry.fly.io/<app>:<label>` did not exist: pulling it failed with `MANIFEST_UNKNOWN` (404), while the `@sha256:` reference worked. Copy the `sha256:` digest that the push reports. A digest also pins every run to exactly the image you pushed, so rebuilding the image does not change runs until you update `PROPR_FLY_IMAGE`. If a create or `PROPR_FLY_PREWARM` fails with `MANIFEST_UNKNOWN`, the reference names a tag or digest the registry does not have.

Each Machine has `auto_destroy` set and restart policy `no`. Runs always use the clone [workspace transport](./coding-agent-integration.md#workspace-transport), so start them as root (the transport requires it). Fly starts a Machine's process as the image's `USER` (`node` for ProPR agent images) unless the config overrides it, and `init` has no user field. The create request therefore also carries a `processes` entry with `user: root` and the same entrypoint and command as `init`: a process entry with only a user would run the image's default command instead of the launcher. The clone wrapper then clones as root into the image's `/home/node/workspace`, which belongs to `node`. It trusts exactly that path as `safe.directory` in the configuration it passes to its own git commands, so git does not refuse the checkout as dubiously owned. Setting `GIT_CONFIG_*` in the run's environment has no effect, because the wrapper sets its own. Credential stores arrive as per-run copies from the credential broker, written into the Machine as files. Refreshed tokens are read back (refused above 1 MiB before any content is transferred) and written to the canonical store after the run. A credential output that is a symlink, or whose path leads through one, is not read. A writable credential store that the worker cannot write to refuses the run before a Machine is created, since there is no direct mount to fall back to. So does a store that keeps provider session state between launches, as goal sessions do: the per-run copy holds only the credential files, so the session history a resumed session needs never reaches the Machine, and what the run adds to it is not written back. Run goal sessions on Docker. Concurrent refreshes are ordered by the file's modification time in the Machine. A refresh that cannot be written back is saved to a root-only `<run>-recovered-*` directory under the credential run root, marked like a retained staging copy. Before refreshed tokens are read back, the worker marks the Machine retained and waits for the mark, so the launcher's linger cannot end and destroy the Machine while a read is still outstanding. After a successful read-back the Machine is released as usual. If the mark cannot be written, the worker still reads the tokens, but it logs that the Machine may already be gone instead of reporting it as kept. A refresh that cannot be read back keeps the Machine instead of releasing it. Other bind sources are copied in, bounded at 16 MiB, and log directories are created empty. Read-only binds stay read-only: before the agent starts, the launcher bind-mounts each read-only upload read-only onto itself. Each declared tmpfs is mounted as a tmpfs with its own options, on top of Docker's `noexec,nosuid,nodev` defaults. The run is refused, and the agent never starts, when one of these cannot be set up: the launcher is not root, a mount fails, the tmpfs takes an option Linux tmpfs does not (such as Docker's `tmpcopyup`), a tmpfs would hide uploaded files, a writable upload sits inside a read-only one, or a mount covers the launcher's run directory. An agent that keeps root holds every capability in the Machine and could undo these mounts. ProPR's entrypoints drop the agent to the `node` user. Machines have no stdin, so a small launcher feeds the prompt from an uploaded file. The launcher also forwards stop signals to the agent and keeps exact stdout and stderr in files. A signal never reaches the clone transport wrapper itself. While the agent runs, it goes straight to the agent. Once the agent has exited and the wrapper is snapshotting or publishing the workspace, nothing is signalled. Once the exit is recorded, the launcher ignores termination signals while it lingers. A deadline or `stop()` signal that arrives before the worker has seen the exit therefore leaves the Machine and its output, workspace result and refreshed credentials in place. The worker then finds the recorded exit and collects them. Only the end of the linger or the destroy request (on release, cancellation or a failed stop) removes the Machine. It mirrors them, line-marked, to the console, which is how the logs API streams them live. The worker reads the exact output through the exec API once the agent exits, then destroys the Machine. Liveness comes from the Machine state, and `stop()` signals the agent through the Machine. At the run deadline the agent gets `SIGTERM`, then the agent and everything it started are killed, including processes it detached into their own session: every process running as the agent user is killed too, before the wrapper may continue. The clone transport wrapper is spared: it snapshots and publishes the workspace (up to 3 minutes) before the exit is recorded, so a timed-out run keeps its changes, and the Machine keeps the partial output and result files. This also applies when the deadline passes after the agent exited, while the wrapper is already publishing. If that kill cannot be confirmed, or the wrapper does not finish in time, the Machine is destroyed. A run whose agent cannot be confirmed stopped fails rather than settling. Cancellation destroys the Machine, also during the timeout stop. A logs request still in flight does not hold up cancellation, the deadline or the end of a stop window: it is abandoned. A `release()` that arrives while the Machine is still being created waits for the create request to return and then destroys the Machine. Each create carries a unique creation id in the Machine's metadata. If a create fails without a definite refusal (lost or timed-out response, a 5xx), the Machine it may have created is looked up by that id and destroyed. The run still fails. The handle keeps looking, on its cleanup timer and on every `release()`, until it destroys the Machine or a successful lookup finds none 10 minutes after the create was sent. A failed lookup does not end this. Only Machines carrying the run's creation id are destroyed. A failed destroy, including a failed `release()` of a retained Machine, is retried with backoff (up to 10 minutes apart) until it succeeds, and the next `release()` retries it at once. The create-to-started time (image pull plus boot) is logged as `coldStartMs`.

**Machine limit and the Free plan.** Every Machine in the Fly organization counts toward its Machine limit, across all of its apps: the ProPR control plane, other apps, and run Machines that still exist. A run's Machine exists while it runs and while the worker reads its result. It also stays when the run is retained because its result or refreshed credentials could not be read, and, if the worker went away, until the result linger ends. A create refused with `422 ... reached its machine limit` fails the run with an error that says this; no Machine was created, so nothing is cleaned up. The Free plan allows 3 Machines. Next to the control plane, that fits about one concurrent run on this runtime, and one leftover Machine blocks the next run. Sprites is the recommended runtime on the Free plan. To clear leftovers, list them with `fly machines list -a <app>` and destroy the ones whose run has settled.

Restricted network policies are refused on this runtime because Fly has no per-Machine egress allowlist. This applies whether the run carries the policy itself or the policy applies when it starts, and also when the runtime is called directly instead of through dispatch. The run is refused before any Machine is created. When the control plane runs on Fly, run Machines share the org private network. ProPR MCP is then reached over `http://<control-plane-app>.internal:<port>/api/mcp`: point `PROPR_INTERNAL_API_URL` or `PROPR_AGENT_MCP_URL` there. Elsewhere, runs reach a reachable URL with their per-run grant token. The spend cap, physical admission slots and activity watchdog of the Docker executor do not apply to Fly runs. Secrets in the run environment and uploaded credential copies are part of the Machine config, which any holder of the deploy token can read until the Machine is destroyed.

## Fly Sprites

Set `PROPR_AGENT_RUNTIME=sprites` on the worker, or set `runtime: sprites` on an individual Claude Code, Codex, or Antigravity agent. Supply an organization token in the worker’s `PROPR_SPRITES_TOKEN` environment variable (`SPRITES_TOKEN` is also accepted). The worker defaults `SPRITES_CLIENT_SIGNALS` to `0` unless the operator sets it. Runs use the clone workspace transport and require open networking. MCP grants need an endpoint reachable from the Sprite.

The worker creates a privately named Sprite for each concurrent run and reuses restored Sprites within its process. Provisioning installs the versions pinned in `Dockerfile.agent` and takes a clean checkpoint before uploading any run data. The clone transport holds its repository token separately while the setup hook and provider entrypoint run as the unprivileged `node` user. Provider credentials arrive in one batch from the broker. Each CLI uses a writable copy of its read-only source. The worker collects only declared refreshable files through the launcher export and commits them through the broker.

Release restores the entire checkpoint after credential write-back and workspace result retrieval, including failed and stopped runs. If result retrieval fails before the worker verifies a local Git ref, cleanup keeps the Sprite out of the pool and reports its name and result directory for recovery. A restore failure causes the worker to destroy the Sprite and provision a replacement. A restarted worker creates its own Sprites. On graceful shutdown the worker drains its jobs and deletes its idle Sprites. Standalone callers should await `runtime.close()` after releasing their runs.

After a crash or failed deletion, use `sprite list --prefix propr-` in the worker’s Sprites organization. Match each candidate’s exact name to the stopped worker’s `Worker created Sprite` log entry and check its job errors for bundles kept for recovery. If the creating worker is unknown, drain and stop all ProPR workers sharing the organization before reaping their Sprites. Once any needed result is recovered, delete the confirmed orphan with `sprite destroy -s <exact-name>`. [Sprites CLI reference](https://docs.sprites.dev/working-with-sprites/#managing-sprites)

## Container Configuration

The worker launches the unified agent image with a prepared worktree, a generated container name, the selected type's credential mount, and any agent-level environment variables. Containers are removed after execution with `--rm`, run with stdin enabled, and use `/home/node/workspace` as the working directory.

Docker starts an init process as PID 1 with `--init`. It reaps orphaned children, forwards signals to the entrypoint, and returns its exit status. When the entrypoint execs the agent CLI, the CLI receives those signals directly.

Most entrypoints start as root so they can prepare runtime directories or fix container-local ownership, then drop to the `node` user before running the CLI. Entrypoints also mark Git directories as safe, install the `gh` wrapper when present, and emit diagnostics that are captured with the task logs.

Existing-account credential and launcher paths must be absolute host paths. Shell shortcuts such as `~` and `$HOME` are not expanded by launcher configuration. Direct-login accounts instead save a portable `~/.propr/agent-credentials/<agent-id>/…` path that ProPR maps to its managed host root automatically.

## Timeouts And Loop Limits

Timeouts prevent runaway jobs and make failures visible in task state. Defaults differ by agent:

| Agent | Timeout variable | Default | Loop variable | Default |
| --- | --- | ---: | --- | ---: |
| Claude Code | `CLAUDE_TIMEOUT_MS` | `86400000` (24 hours) | `CLAUDE_MAX_TURNS` | `1000` |
| Codex | `CODEX_TIMEOUT_MS` | `86400000` (24 hours) | Not used | N/A |
| Antigravity | `ANTIGRAVITY_TIMEOUT_MS` | `86400000` (24 hours) | Not used | N/A |
| OpenCode | `OPENCODE_TIMEOUT_MS` | `86400000` (24 hours) | Not used | N/A |
| Mistral Vibe | `VIBE_TIMEOUT_MS` | `86400000` (24 hours) | `VIBE_MAX_TURNS` | `1000` |

These task-execution defaults are shared across all coding agents and match the shipped `.env.example`. Planner keyword extraction and semantic relevance scoring default to 60 minutes per call and can be adjusted with `CONTEXT_ANALYSIS_TIMEOUT_MS`.

When an implementation run reaches its execution timeout or maximum turn limit, ProPR preserves any workspace changes produced before the interruption. If changes exist, it commits and pushes them, opens the issue PR or updates the existing follow-up PR, and marks the result as potentially incomplete with the agent's last available summary and explicit remaining-work guidance. Other execution errors still fail normally, and an interrupted run with no changes has nothing to publish.

When tuning these values, consider repository size, task complexity, provider rate limits, worker concurrency, and host CPU and memory. Increase timeouts only after checking task and worker logs; a timeout may indicate missing context, provider slowness, a task that should be split, or an agent loop.

## Security Boundary

The runtime should preserve these boundaries:

- Keep git finalization outside the agent.
- Mount only the workspace, the shared git directory, and required credential directories.
- Avoid further host filesystem mounts. The shared git directory already exposes every cloned repository to the agent, so separate repositories with different trust levels onto separate stacks.
- Keep credential directories scoped to the deployment user.
- Monitor container CPU, memory, and duration.
- Treat `--dangerously-*` CLI flags as acceptable only because Docker is the outer isolation boundary.

#### Agent `envVars` redaction

Agent `envVars` values are treated as secrets at every administrative output boundary. `GET`/`POST /api/config/agents`, `propr agent list`/`add` (text and `--json`) and the MCP agent tools return only the variable names; each value is the fixed marker `[REDACTED]` (or the field is omitted), never a prefix, length, hash or encoding of the real value. Agent containers still receive the stored values. When a client saves the agent list back, a `[REDACTED]` value keeps the stored value for that variable on the same agent id; a new value replaces it, and a removed key deletes it. A marker with no stored value is rejected with `400`.

### Network Egress

Containers run on Docker's default bridge network with `--security-opt no-new-privileges` and `--cap-add CHOWN`, so outbound network access is unrestricted in the default `open` mode. The `.propr/setup.sh` hook runs under that same Docker privilege boundary and cannot use sudo to install system packages.

In `restricted` mode (instance setting `agent_network_mode`, or `network.mode` in `.propr/workflow.yml`), the Docker executor starts a per-container allowlist proxy in the worker process on a Unix socket under `PROPR_EGRESS_SOCKET_DIR`, replaces the container's network (whatever `docker run` named, or the default bridge) with `--network none`, mounts the socket directory read-only at `/run/propr-egress`, and sets `HTTP_PROXY`/`HTTPS_PROXY`, `NO_PROXY` and Git's `http.proxy`. A bridge started by the container wrapper exposes the socket as `127.0.0.1:3128` before setup hooks and the agent run. The proxy resolves DNS on the worker and refuses hosts outside the allowlist with `403`, and chains allowed connections through the worker's own `HTTPS_PROXY`/`HTTP_PROXY` when set; it closes when the container's `docker run` exits. Native goal sessions, which spawn `docker run` directly, get the same proxy for the life of that process. No privileged flag or extra capability is used. See [Restricted network mode](../features/execution-safety.md#restricted-network-mode).

Provider connectivity failures in open mode usually come from the host network, DNS, proxy settings, provider availability, or an external firewall. In restricted mode, check the task timeline's **Restricted Network** event for denied hosts first.

## Monitoring And Debugging

Useful signals:

- Task logs in the Web UI
- Worker logs with correlation IDs
- Container exit code
- Agent stdout and stderr
- Session or conversation IDs when available
- Duration, timeout state, token usage, and usage-limit state
- Compute usage per run (wall time, CPU-seconds, peak/average memory, compute cost), sampled from the container cgroup; see [Compute Usage](./coding-agent-integration.md#compute-usage) for `PROPR_COMPUTE_USAGE_SAMPLE_MS` and the `PROPR_COMPUTE_RATES` rate table

For direct Docker inspection:

```bash
docker ps
docker logs <container>
docker inspect <container>
```

## Common Issues

### Authentication Issues

For a direct-login account, check that the managed credential root is mounted and that the agent's generated path is still `~/.propr/agent-credentials/<agent-id>/…`. For reused host credentials, check that the CLI is authenticated and the expected directory is mounted into the agent's container path. For example, Claude Code expects its selected directory at `/home/node/.claude`, while Codex expects its selected directory at `/home/node/.codex`.

### Docker Permission Issues

Check that the deployment user can access Docker and that the launcher or worker can start sibling containers. If a container can start but cannot edit the worktree, inspect bind-mount ownership and the entrypoint diagnostics.

### Network Issues

In the default `open` mode egress is unrestricted: check the host network, DNS, proxy configuration, external firewall rules, and provider status. In `restricted` mode, the task timeline's **Restricted Network** event lists every denied host; add a needed host to `network.allow` in `.propr/workflow.yml` or to the instance `agent_network_allow` setting. A container log line `ProPR restricted network: egress proxy socket ... is missing` means the Docker daemon cannot see the worker's `PROPR_EGRESS_SOCKET_DIR`; mount it at the same path, or set `HOST_PROPR_EGRESS_SOCKET_DIR` to the Docker host path.

### Timeout Issues

Check worker logs, task logs, provider latency, and model routing before increasing timeout values. Persistent timeouts often mean the prompt is too broad, context is missing, or the provider is slow or rate limited.

## Agent-Specific Configuration

### Claude Code

Claude Code uses `Dockerfile.agent`, `scripts/claude-entrypoint.sh`, and the `propr/agent` image. The host credential directory is configured with `CLAUDE_CONFIG_PATH` or the agent config path and is mounted at `/home/node/.claude`.

Common settings:

```bash
AGENT_DOCKER_IMAGE=propr/agent:latest
CLAUDE_CONFIG_PATH=/home/your-user/.claude
CLAUDE_MAX_TURNS=1000
CLAUDE_TIMEOUT_MS=86400000
```

The entrypoint checks for `/home/node/.claude/.credentials.json`, creates expected Claude subdirectories such as `todos`, `projects`, `shell-snapshots`, and `statsig`, and prepares `/home/node/.claude/projects/home-node-workspace` for the mounted workspace.

For implementation tasks, the worker invokes Claude Code with the prompt on stdin:

```bash
claude -p - --no-session-persistence [--model <id>] --max-turns N --output-format stream-json --verbose --dangerously-skip-permissions
```

`--max-turns` comes from `CLAUDE_MAX_TURNS`. The worker captures Claude's stream JSON output, session ID, conversation log, and token usage when available.

### Codex

Codex uses `Dockerfile.agent`, `scripts/codex-entrypoint.sh`, and the `propr/agent` image. The host credential directory is configured with the agent config path, commonly from `HOST_CODEX_DIR`, and is mounted at `/home/node/.codex`.

Common settings:

```bash
HOST_CODEX_DIR=/home/your-user/.codex
CODEX_TIMEOUT_MS=86400000
CODEX_STREAM_TRANSPORT=websocket
CODEX_STREAM_IDLE_TIMEOUT_MS=1800000
CODEX_STREAM_MAX_RETRIES=5
```

The entrypoint checks for `/home/node/.codex/config.toml`, prepares `sessions` and `rules`, and avoids recursively changing bind-mounted workspace ownership. Codex runs as:

```bash
codex exec --ephemeral --json --dangerously-bypass-approvals-and-sandbox --config features.multi_agent=false --skip-git-repo-check --cd /home/node/workspace -
```

Codex 0.169 and later ignore an untrusted workspace's `.codex/config.toml` and project MCP servers. Codex 0.168 and earlier saved trust for `/home/node/workspace` in the mounted `config.toml` on any `--dangerously-bypass-approvals-and-sandbox` run. To keep that behaviour, the entrypoint adds `--trust` to `codex exec` when the installed CLI offers the flag. `--trust` saves the same entry and still respects a workspace the operator has marked `untrusted`. Repository inspection and runs with an exclusive extension MCP catalog pass `--ignore-user-config` and stay untrusted. Goal runs through `codex app-server` need no flag: starting the goal's thread saves the same entry before the repository configuration is read, and a workspace marked `untrusted` stays untrusted.

When a model is selected, ProPR adds `--model <id>`. By default, ProPR selects a WebSocket-capable OpenAI provider with a 30-minute stream idle timeout so long, quiet turns are not pinned to a single HTTP response body. Set `CODEX_STREAM_TRANSPORT=sse` when WebSockets are unavailable or `CODEX_STREAM_TRANSPORT=inherit` to preserve a custom provider from the mounted Codex configuration. Codex emits NDJSON events that ProPR parses into logs, result text, session metadata, and token usage; reconnect notices remain visible without making a later successful turn fail.

### Antigravity

Antigravity uses `Dockerfile.agent`, `scripts/antigravity-entrypoint.sh`, and the `propr/agent` image. The runtime resolves `ANTIGRAVITY_CONFIG_PATH` or the agent config path and mounts the selected host directory at `/home/node/.gemini`. If the configured path ends in `.antigravity` and a sibling `.gemini` directory exists, ProPR uses that `.gemini` directory for credentials.

Common settings:

```bash
HOST_ANTIGRAVITY_DIR=/home/your-user/.gemini
ANTIGRAVITY_CONFIG_PATH=/home/your-user/.gemini
ANTIGRAVITY_TIMEOUT_MS=86400000
```

The entrypoint prepares Antigravity runtime directories under the mounted config path and looks for auth, OAuth, credential, or token files. The agent CLI is `agy`; ProPR passes the selected model with `--model <id>` after translating ProPR model IDs into Antigravity CLI model IDs.

ProPR also passes `--print-timeout` set to the run's timeout (`ANTIGRAVITY_TIMEOUT_MS` for tasks). From Antigravity CLI 1.5.0, a run that hits that deadline exits with code `3`, prints an `AGY_ERROR` line and writes `[agy] print timeout after ...` to stderr. ProPR records such a task as timed out, with the CLI's explanation as the error, and does not accept the partial answer of an analysis run.

### OpenCode

OpenCode uses `Dockerfile.agent`, `scripts/opencode-entrypoint.sh`, and the `propr/agent` image. The primary config mount is commonly `HOST_OPENCODE_XDG_DIR=/home/your-user/.config/opencode`, mounted at `/home/node/.config/opencode`.

Common settings:

```bash
HOST_OPENCODE_XDG_DIR=/home/your-user/.config/opencode
HOST_OPENCODE_DATA_DIR=/home/your-user/.local/share/opencode
OPENCODE_TIMEOUT_MS=86400000
AGENT_DOCKER_IMAGE=propr/agent:latest
```

The entrypoint sets `OPENCODE_CONFIG_DIR=/home/node/.config/opencode` and prepares XDG data and state directories. OpenCode runs in JSON mode through the OpenCode adapter (`scripts/opencode-run.sh` with `--format json`). ProPR passes the selected model with `--model <id>` and parses OpenCode responses back into the shared agent result shape.

#### Host Setup

Install OpenCode on the host and initialize the directories ProPR can mount:

```bash
curl -fsSL https://opencode.ai/install | bash
# or: npm install -g opencode-ai

mkdir -p ~/.config/opencode ~/.local/share/opencode
opencode --version
opencode auth login
```

OpenCode's config location is `~/.config/opencode`; configure OpenCode agents with that path. The built-in free models run without provider login — operators only need credentials for OpenCode Go or any other authenticated provider they configure.

#### Auth Data

OpenCode stores provider auth in `~/.local/share/opencode/auth.json`. When `HOST_OPENCODE_DATA_DIR` is set in the worker environment, ProPR mounts that host directory into OpenCode agent containers at `/home/node/.local/share/opencode`, read-write so the CLI can refresh auth metadata. When it is unset, ProPR infers the matching host data path for default config paths like `/home/your-user/.config/opencode` and mounts it when the directory exists.

Without either data mount, make credentials available another way:

- Pass provider API keys as agent `envVars`.
- Copy `auth.json` under the mounted config tree and point `XDG_DATA_HOME` at it in the agent `envVars` (`XDG_DATA_HOME=/home/node/.config/opencode/xdg-data`). Re-sync the file after changing providers or refreshing OpenCode auth:

```bash
mkdir -p ~/.config/opencode/xdg-data/opencode && cp ~/.local/share/opencode/auth.json ~/.config/opencode/xdg-data/opencode/auth.json
```

By default the container receives `XDG_CONFIG_HOME=/home/node/.config` and `XDG_DATA_HOME=/home/node/.local/share`; the `envVars` override applies only for copied file-based auth. Authentication failures usually mean the configured config path does not point at the host's initialized OpenCode directory, `HOST_OPENCODE_DATA_DIR`/`XDG_DATA_HOME` does not point at mounted auth data, or the selected provider API key is missing or expired.

#### Model-ID Translation

ProPR catalog IDs for OpenCode carry the `opencode-` prefix, for example `opencode-big-pickle`. ProPR converts these back to OpenCode's native `provider/model` syntax at execution time (`opencode-big-pickle` becomes `opencode/big-pickle`) and strips only the internal `opencode:` routing prefix, so provider-qualified model IDs remain intact. The OpenCode model list is dynamic: run `opencode models` on the host after changing auth providers, then register any desired authenticated provider IDs (for example `opencode-openai/gpt-5.5`) on the agent's supported models. ProPR keeps only the built-in free OpenCode models as defaults and does not add authenticated provider models automatically. See [Agents and Models](../features/agents-and-models.md) for the catalog and label formats.

### Mistral Vibe

Mistral Vibe uses `Dockerfile.agent`, `scripts/vibe-entrypoint.sh`, and the `propr/agent` image. The host config directory is configured with `VIBE_CONFIG_PATH` or the agent config path, commonly from `HOST_VIBE_DIR`, and is mounted at `/home/node/.vibe` when usable.

Common settings:

```bash
HOST_VIBE_DIR=/home/your-user/.vibe
VIBE_CONFIG_PATH=/home/your-user/.vibe
VIBE_TIMEOUT_MS=86400000
VIBE_MAX_TURNS=1000
VIBE_ANALYSIS_TIMEOUT_MS=1800000
MISTRAL_API_KEY=...
```

Vibe can use either a valid Vibe config directory or `MISTRAL_API_KEY`. The entrypoint copies config into a per-run runtime home, sets `HOME` and `VIBE_HOME` to that runtime directory, loads `.env` defaults from the Vibe home, and sets `VIBE_ACTIVE_MODEL` when ProPR selects a model.

Implementation prompts are written to a temporary prompt file and passed through the Vibe prompt-file runner so the prompt does not need to appear directly in process arguments. Analysis runs can use read-only config mode and a shorter `VIBE_ANALYSIS_TIMEOUT_MS`.
