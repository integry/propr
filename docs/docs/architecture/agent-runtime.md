---
sidebar_position: 6
---

# Agent Runtime Reference

This is the canonical runtime reference for ProPR coding agents. It covers the shared Docker execution model used by Claude Code, Codex, Antigravity, OpenCode, and Mistral Vibe. For the higher-level integration contract, routing model, and worker responsibilities, see [Coding Agent Integration](./coding-agent-integration.md).

## Runtime Model

Every coding agent runs in a Docker container so ProPR can control runtime dependencies, workspace mounts, credential mounts, timeouts, logging, and resource boundaries. The agent implementation changes the CLI command, image, credential directory, and output parser, but the container shape is shared:

- A task worktree mounted at `/home/node/workspace`
- Agent credentials from a ProPR-managed per-agent directory or a configured existing host directory. Task and analysis runs get a per-run copy holding only the provider's credential and config files, and refreshed tokens are written back after the run (see [Per-run credential copies](../features/execution-safety.md#per-run-credential-copies)).
- GitHub credentials passed through `GH_TOKEN` and `GITHUB_TOKEN`
- Agent, model, timeout, and task metadata passed as environment variables or CLI flags
- `--security-opt no-new-privileges`, `--cap-add CHOWN` (Vibe omits it), and Docker's default `bridge` network; the repository setup hook runs without sudo privileges before the agent entrypoint
- Memory, CPU, and process limits from `AGENT_CONTAINER_MEMORY_LIMIT` (default `6g`), `AGENT_CONTAINER_CPU_LIMIT` (default: available CPUs, capped at 4), and `AGENT_CONTAINER_PIDS_LIMIT` (default `512`)
- For every agent except Vibe, the host's `/tmp/git-processor` directory (all clones and worktrees) mounted at the same path so git works in the linked worktree
- Structured stdout, stderr, exit code, duration, session ID, and token usage capture when the CLI exposes those fields

All agents run from the unified Debian/glibc `propr/agent` image. Its internal base stage includes Node.js 22, Git and repository tooling, a scoped `gh` wrapper, and entrypoint support used by the worker. The image uses Node.js 22 to satisfy current agent CLI engine requirements. Independent CLI build stages preserve Docker cache reuse when one configured version changes.

This table maps each agent type to the unified image, its type-specific entrypoint, and its credential mount; other pages link here instead of repeating it.

| Agent | Image | Dockerfile | Entrypoint | Existing host credential mount | Container credential path |
| --- | --- | --- | --- | --- | --- |
| Claude Code | `propr/agent` | `Dockerfile.agent` | `scripts/claude-entrypoint.sh` | `HOST_CLAUDE_DIR` (`~/.claude`) | `/home/node/.claude` |
| Codex | `propr/agent` | `Dockerfile.agent` | `scripts/codex-entrypoint.sh` | `HOST_CODEX_DIR` (`~/.codex`) | `/home/node/.codex` |
| Antigravity | `propr/agent` | `Dockerfile.agent` | `scripts/antigravity-entrypoint.sh` | `HOST_ANTIGRAVITY_DIR` (`~/.gemini`) | `/home/node/.gemini` |
| OpenCode | `propr/agent` | `Dockerfile.agent` | `scripts/opencode-entrypoint.sh` | `HOST_OPENCODE_XDG_DIR` (`~/.config/opencode`) plus `HOST_OPENCODE_DATA_DIR` | `/home/node/.config/opencode` |
| Mistral Vibe | `propr/agent` | `Dockerfile.agent` | `scripts/vibe-entrypoint.sh` | `HOST_VIBE_DIR` (`~/.vibe`) | `/home/node/.vibe` |

Agent runs go through the runtime seam described in [Coding Agent Integration](./coding-agent-integration.md#runtime-seam). Docker is the default runtime (`PROPR_AGENT_RUNTIME=docker`); [Fly Sprites](#sprites-runtime) is the other built-in one (`PROPR_AGENT_RUNTIME=sprites`, or `runtime: sprites` on one agent). The container shape below is how `DockerRuntime` renders each provider's `AgentRunSpec`. With `PROPR_WORKSPACE_TRANSPORT=clone`, the worktree and git mounts are left out. The container clones the task base with a short-lived repository-scoped token and returns its result through a temporary `refs/propr/runs/<runId>/result` ref, falling back to a bundle. It also runs without `--rm` so the worker can read the result files before removing it. See [Workspace Transport](./coding-agent-integration.md#workspace-transport).

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

## Sprites Runtime

`PROPR_AGENT_RUNTIME=sprites` runs Claude Code, Codex and Antigravity task and analysis runs on [Fly Sprites](https://sprites.dev) instead of local containers. An agent can also select it alone with `"runtime": "sprites"` in its configuration (`docker` and `sprites` are the accepted values; unset follows `PROPR_AGENT_RUNTIME`). OpenCode and Mistral Vibe agents, native goal sessions, runs that resume a provider session from the credential store, restricted network mode and private-network MCP grants are refused on Sprites before anything is launched; they need the Docker runtime.

A Sprite cannot bind-mount worker paths, so a Sprites run always uses the [clone workspace transport](./coding-agent-integration.md#workspace-transport) and the credential broker's per-run copies. The worker needs `PROPR_SPRITES_TOKEN` (an org-scoped Sprites token), `Dockerfile.agent` and `scripts/` at `PROPR_ROOT`, and the `@fly/sprites` package.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PROPR_SPRITES_TOKEN` | required | Org-scoped Sprites API token. `SPRITES_TOKEN` is accepted as a fallback. |
| `PROPR_SPRITES_MAX_SPRITES` | `4` | Sprites this worker keeps, which is also how many Sprites runs it has at once. |
| `PROPR_SPRITES_NAME_PREFIX` | `propr` | Sprites are named `<prefix>-<worker id>-<slot>`. |
| `PROPR_SPRITES_WORKER_ID` | hash of the Fly Machine id or host name | Keeps one worker's Sprites apart from another's. Set it when two workers share a host name. |
| `PROPR_SPRITES_REGION`, `PROPR_SPRITES_RAM_MB`, `PROPR_SPRITES_CPUS` | Sprites defaults | Applied when a Sprite is created. |
| `PROPR_SPRITES_STATE_DIR` | `<managed credentials dir>/.propr-sprites` | Where the worker records each Sprite's clean checkpoint and holds its per-Sprite lock. Keep it on persistent storage. The lock is an operating-system file lock on `<sprite>.lock` (taken through SQLite), released by the kernel when the worker process exits; the lock files themselves stay in place and must not be removed or opened by other tools while a worker runs. |
| `PROPR_SPRITES_API_URL` | Sprites API | Alternative API endpoint. |
| `SPRITES_CLIENT_SIGNALS` | `0` | The SDK's usage-attribution headers. ProPR switches them off unless you set this variable yourself. |

### One Run Per Sprite, From A Clean Checkpoint

A Sprite is persistent, so isolation between runs comes from its checkpoint, not from cleaning up:

1. On first use the worker creates the Sprite, uploads `scripts/sprites-agent-setup.sh` with the provider entrypoints and the launcher, and runs it as root. Setup creates the unprivileged `node` user (no sudo; checked by reading `sudo -l -U node`, whose exit status is 0 on a Sprite either way, by group membership and by trying `sudo -n` as `node`), links `node`, `npm` and `npx` onto root's `PATH`, and installs the CLIs at exactly the versions `Dockerfile.agent` pins (`CLAUDE_CLI_VERSION`, `CODEX_CLI_VERSION`, `ANTIGRAVITY_CLI_VERSION` with its `ANTIGRAVITY_CLI_RELEASE_ID` and `ANTIGRAVITY_CLI_SHA512`). An agent configured for another CLI version is refused on Sprites.
2. The worker takes a checkpoint and records its id in `PROPR_SPRITES_STATE_DIR`. This is the only state a run ever starts on.
3. A Sprite runs one agent run at a time. When the run ends, however it ended (success, failure, timeout, cancellation), the worker writes refreshed credentials back, reads the workspace result, has the launcher empty `/tmp` (see below), and restores the checkpoint. This starts as soon as the run ends and does not wait for the caller.
4. If the restore fails, `/tmp` cannot be emptied, or the run's processes cannot be confirmed dead, the Sprite is destroyed and a new one is created and provisioned. That includes a run whose launcher exited but reported that processes of the agent user survived its kill. A Sprite that could be neither restored nor replaced is replaced before its next run.
5. The run's timeout starts when the run is requested. Waiting for a free Sprite, provisioning or restoring it, and uploading the payload count against it; a run whose timeout passes before its launch is reported as timed out and never started.
6. What a worker process remembers about a Sprite is only trusted while it holds the Sprite's lock. If another worker process with the same worker ID held the Sprite in between, the Sprite's identity, setup revision and checkpoint are checked again (restore, or destroy and provision) before the next run.

A Sprite's checkpoint does not cover `/tmp`: it is a separate disk, and a restore leaves its content in place (the home directories, `/var/tmp` and the rest of the root filesystem are reset). Two things keep it from carrying one run into the next:

- Nothing run-scoped is put there. The run's `TMPDIR` is `/var/lib/propr/run`, a sticky world-writable directory on the checkpointed root, so the clone wrapper's private repository and the agent's temporary files go there. Antigravity's disposable HOME is `/var/lib/propr/run/antigravity-home` (the image uses `/tmp/propr-antigravity-home`). The clone wrapper's result directory is `/opt/propr/run/result`. A directory the run is given under `/tmp` (the `/tmp/claude-logs` log bind) is created under `/var/lib/propr/mounts` and only linked from `/tmp`.
- Before every restore, once no process of the `node` user is left, the launcher (`launcher.sh scrub`) deletes everything under `/tmp` as root without following symlinks or crossing into another filesystem. A Sprite whose `/tmp` could not be emptied is destroyed instead of restored.

There is no setting that skips the scrub or the restore. The workspace, the result bundle, logs, scratch directories, provider tokens and the agent's HOME (including Antigravity's disposable HOME) therefore cannot reach the next run. A worker that restarts does not trust what it finds: it restores each Sprite from the recorded checkpoint before the first run, and it destroys a Sprite it has no matching record for (a new setup revision, a lost state directory). It never picks a checkpoint by its comment on a Sprite that has run an agent.

### Privilege And Credential Boundary

- The launcher (`scripts/sprites-launcher.sh`, installed root-owned at `/opt/propr/launcher.sh`) is root only to install the run's files, which it does before anything of the run starts, and to start the clone wrapper. It refuses a Sprite that is not at its clean checkpoint.
- The provider entrypoint never runs as root on a Sprite. The setup wrapper execs an `<agent>-as-agent` shim that drops to `node` first, so the entrypoint's own `chown`, `mkdir` and copy steps run unprivileged. Antigravity's root-side sync of its state files back to the source directory does not happen on Sprites.
- Everything that runs as root resolves commands through root-owned directories only; the `node` user gets its own `PATH` from the shim.
- A credential store the CLI refreshes in place (`/home/node/.claude`, `/home/node/.codex`) is owned by `node`. A store the entrypoint only copies from (Antigravity's `/home/node/.gemini-source`) is readable but not writable by `node`, like a read-only bind.
- Refreshed tokens leave the Sprite only through the launcher's export directory. After every process of the `node` user is gone, the launcher reads each refreshable file as `node` (a planted symlink can only yield what `node` may read) into a root-owned directory. The worker then accepts plain regular files only, never follows a symlink, refuses anything over 1 MiB, and passes the files to `CredentialBroker.commit()`. A write-back that fails keeps the tokens in a retained directory under the credential run root on the worker, as on Docker.
- The Sprites org token is never part of a run: variables that name it, and any variable whose value contains it, are withheld from the run's environment, and it is removed from error messages before they are logged.
- The run's payload (command, environment, prompt, credential copies) is uploaded as one archive into `/opt/propr/run`, which `node` can neither read nor enter.

### What Differs From Docker

- Log binds (`/tmp/claude-logs`) and tmpfs mounts become empty directories on the Sprite (those under `/tmp` are links to a directory on the checkpointed root); nothing in them returns to the worker. Read-only file binds up to 1 MiB (the `.claude.json` seed) are copied in. Any other host mount refuses the run.
- Antigravity's transient transcript is not returned, as in Docker's clone mode.
- Memory, CPU and PID limits come from the Sprite's size, not from `AGENT_CONTAINER_*`. Agent-run admission limits do not apply; `PROPR_SPRITES_MAX_SPRITES` bounds concurrency instead.
- The worker still prepares the `propr/agent` image for agents on Docker; a Sprites agent does not use it.

Startup time is logged per run (`Sprites run started`, with `queueMs`, `wakeMs`, `provisionMs`, `restoreMs`, `credentialSyncMs` and `totalMs`), and the restore after the run as `Sprite returned to its clean checkpoint after the run`. A first run that provisions takes about 30 seconds; a warm run pays only the wake and the single payload upload, because the restore already ran when the previous run ended.

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
