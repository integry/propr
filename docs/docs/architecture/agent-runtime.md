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

Agent runs go through the runtime seam described in [Coding Agent Integration](./coding-agent-integration.md#runtime-seam). Docker is the default runtime (`PROPR_AGENT_RUNTIME=docker`); [Fly Sprites](#fly-sprites-runtime) is the other built-in one (`PROPR_AGENT_RUNTIME=sprites`, or an agent's **Runtime** setting). The container shape below is how `DockerRuntime` renders each provider's `AgentRunSpec`. With `PROPR_WORKSPACE_TRANSPORT=clone`, the worktree and git mounts are left out. The container clones the task base with a short-lived repository-scoped token and returns its result through a temporary `refs/propr/runs/<runId>/result` ref, falling back to a bundle. It also runs without `--rm` so the worker can read the result files before removing it. See [Workspace Transport](./coding-agent-integration.md#workspace-transport).

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

## Fly Sprites Runtime

[Fly Sprites](https://fly.io/sprites/) are persistent microVMs, billed only for CPU and memory while they are active. ProPR can run Claude Code, Codex and Antigravity agents on them instead of in local Docker containers. A Sprite cannot boot the `propr/agent` image, and Docker inside a Sprite is unreliable, so the runtime drives the agent CLIs on the Sprite directly. Select it for every agent with `PROPR_AGENT_RUNTIME=sprites` on the worker, or per agent with **Settings → Agents → Edit → Runtime → Fly Sprites** (the agent config's `runtime: "sprites"`).

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PROPR_SPRITES_TOKEN` (or `SPRITES_TOKEN`) | required | Org-scoped Sprites API token. It is a secret: it is never logged and never reaches a run. |
| `PROPR_SPRITES_NAME_PREFIX` | `propr` | Prefix of the Sprite names (`<prefix>-<worker>-<slot>`). |
| `PROPR_SPRITES_REGION` | Sprites default | Region new Sprites are created in. |
| `PROPR_SPRITES_RAM_MB`, `PROPR_SPRITES_CPUS` | Sprites default | Size of new Sprites. |
| `PROPR_SPRITES_MAX_SPRITES` | `4` | Sprites one worker runs at once (one run per Sprite). |
| `PROPR_SPRITES_RESTORE_CHECKPOINT` | `true` | Restore each Sprite to its clean post-setup checkpoint when a run is released. With `false`, release removes the run's data instead (see [How A Run Executes](#how-a-run-executes)). |
| `PROPR_SPRITES_KEEP_AWAKE_INTERVAL_MS` | `30000` | Interval of the keep-awake renewal during a run. |
| `PROPR_SPRITES_WORKER_ID` | hash of `FLY_MACHINE_ID` or the host name | Stable worker identity in Sprite names, so a restarted worker finds its own Sprites. Set it per process when several ProPR processes on one host run agents; a Sprite whose launcher belongs to another process is skipped. |
| `PROPR_SPRITES_API_URL` | `https://api.sprites.dev` | Sprites API endpoint. |
| `SPRITES_CLIENT_SIGNALS` | `0` | The SDK's usage-attribution headers. ProPR sets `0` unless the operator set the variable. |

Sprites runs always use the [clone workspace transport](./coding-agent-integration.md#workspace-transport): the worker's worktree never leaves the worker, and the result comes back through the temporary result ref (or the bundle fallback, read through the Sprites filesystem API). Restricted network mode is not enforced on Sprites, so restricted runs are refused before launch. ProPR MCP is reached at its reachable URL with the per-run token. Native goal sessions still need Docker. Runs that rely on a provider session persisting in their credential store between launches (goal runs, which resume by session id and so get the store directly instead of a per-run copy) are refused before launch too: a Sprite receives only the manifest's files and is restored to its clean checkpoint before every run, so the session would be missing. A Sprite runs only the CLI versions its setup pins (the `Dockerfile.agent` defaults): an enabled agent that selects Fly Sprites (itself or through `PROPR_AGENT_RUNTIME`) with any other CLI version is refused when its configuration is saved, and its runs are refused before launch, instead of running the pinned version. Use the default CLI version on Sprites, or the Docker runtime for other versions. When no enabled agent selects Docker, the worker skips agent image preparation, image liveness checks, and the Docker part of the worktree sweep, so a Sprites-only worker needs no Docker daemon. This holds whether Sprites is selected through `PROPR_AGENT_RUNTIME` or by each agent's own **Runtime** setting. Worktree reclamation reads the configured agents only when Docker cannot be reached, and keeps requiring Docker when any enabled agent selects it or the agent configuration cannot be read. Agent runtime packages (extra apt packages) apply only to the Docker image.

### How A Run Executes

1. **Sprite.** The worker takes a free Sprite slot of its own and creates the Sprite in the configured region if it does not exist yet. It skips a Sprite that is running another process's launcher, and a quarantined Sprite that holds credentials awaiting recovery (step 7). The run's deadline (`timeout`) starts when the run is requested, so time spent waiting for a slot, setting up or preparing the Sprite counts against it. A run whose deadline passes before it starts settles as timed out and never starts a session on the Sprite.
2. **Setup.** The first time a Sprite sees a setup revision, the runtime uploads `scripts/sprites-agent-setup.sh` with the entrypoint scripts and runs it as root. It creates an unprivileged `node` user with `/home/node` (never in sudoers), provides `su-exec`/`gosu` (when the Sprite has neither, a shim over `setpriv` that, like them, sets `HOME` to the target user's home), and installs the Claude Code, Codex and Antigravity CLIs at the versions `Dockerfile.agent` pins under `/opt/propr` (ahead of the Sprite's own, older CLIs). The Sprite's Node comes from an nvm shim in `/.sprite/bin`, which sudo's `secure_path` drops, so setup links the real `node`, `npm` and `npx` into `/usr/local/bin` for root and the `node` user. Because Sprites ship npm 12, which blocks install scripts by default, each pinned CLI is installed with `--allow-scripts=<package>` so Claude Code's postinstall can fetch its native binary. It also installs the entrypoint scripts in the root-owned `/opt/propr/entrypoints` rather than at `/home/node/<agent>-entrypoint.sh` as in the image: `node` owns `/home/node`, and the repository setup hook runs as `node` before root runs the provider entrypoint, so it could replace a script there. The installed copies refer to each other there, and the directory the entrypoints put first on root's `PATH` for the `gh` wrapper is the root-owned `/opt/propr/gh-bin` instead of `/home/node/bin`. Setup fails unless `node` can modify none of the files root runs (entrypoints, `su-exec`, `gosu`, the `gh` wrapper, the CLI directory) nor any directory above them. It also installs the `gh` wrapper and the image's git configuration, written to `/home/node/.gitconfig` with an explicit `HOME` (setup runs with root's). The Sprite is then checkpointed. The revision hashes the setup files and the pins, so changing either provisions Sprites again. Setup only runs on a filesystem no run has used since its baseline: a Sprite provisioned for an earlier revision is first restored to that revision's clean checkpoint (unless its release already did), so the new checkpoint never captures an earlier run's workspace or credentials. A used Sprite with no such checkpoint (or one provisioned for the current revision whose checkpoint is missing) is deleted and created again instead. With `PROPR_SPRITES_RESTORE_CHECKPOINT=false` nothing is checkpointed, and setup runs on the Sprite as it is.
3. **Restore.** A Sprite is restored to that clean checkpoint when the previous run is released (step 7), and the worker then marks it clean in its run directory, which the agent cannot write to. A run that finds the mark consumes it and starts without a restore. A run that finds no mark (for example after a worker crash, or when the restore at release failed) restores the checkpoint first. Either way, nothing from an earlier run or account remains.
4. **Credential sync.** The credential broker copies only the provider manifest's files (for example `.credentials.json`, `settings.json`, `CLAUDE.md` for Claude, or `auth.json`, `config.toml` for Codex). It reads them from the canonical store only once the run holds its Sprite (not while it queues for one), so the copy is current when the run starts. It uploads them through the filesystem API with mode `0600` into a per-run directory that only the Sprite user can read, after first recording there the run's baseline (a hash of each refreshable token it received). Each file keeps its canonical modification time. The root launcher installs them at `/home/node/.claude`, `/home/node/.codex` or `/home/node/.gemini-source` (Antigravity, whose entrypoint copies the token into its disposable HOME `/tmp/propr-antigravity-home`) for the `node` user. The Sprite's own `~/.claude` and `~/.codex` under `/home/sprite` are never touched.
5. **Run.** A detachable session starts the launcher with `sudo`. The launcher runs the spec's entrypoint, repository-setup wrapper, clone wrapper and CLI arguments as `docker run --user 0:0` would, with the image's entrypoint paths mapped to their `/opt/propr/entrypoints` copies. A root-started run whose entrypoint or provider entrypoint is still a file the agent user could replace (under `/home`, `/tmp` or another agent-writable location, or a relative path) is refused. Its `PATH` holds only root-owned directories (`/home/node/.local/bin` is left out), because root resolves the entrypoints' commands through it after the setup hook ran. The provider entrypoint drops to `node` before the CLI starts. The prompt arrives on stdin from a file, and only the spec's environment is passed. The command runs in its own session (`setsid`), and every process it starts inherits `PROPR_SPRITES_RUN=<run directory>`. With the `node` user's UID, which only runs use, they are the run's process boundary, like a container's. A process can leave the session and clear its environment (`setsid env -i ...`), but it cannot stop being `node`. When the command exits, the launcher kills whatever is still running inside the boundary, including background jobs and daemons that started a session of their own. Before it installs a run's credentials, it also kills any `node` process left from an earlier run, and refuses to start the run if one survives. With `PROPR_SPRITES_RESTORE_CHECKPOINT=false`, what an earlier run left is still on the Sprite, including symlinks it planted (for example `/tmp/claude-logs` pointing at `/opt/propr/bin`). So before root creates, owns, installs or removes any of the run's paths (log and scratch directories, credential and file copies, the workspace, and the cleanup after release), it removes every symlink, and every non-directory where a directory belongs, below the path's top-level directory. `mkdir -p`, `chown`, `install` and `rm -rf` then act on real directories and never follow a link to a file root executes.
6. **Output.** stdout and stderr go to separate log files on the Sprite. The worker follows each file with a plain exec of `tail --pid`. After a dropped connection it reconnects from the bytes it already received, so output is neither lost nor repeated. A worker restart can reattach to the run (`SpritesRuntime.attach`) and recover the complete output. The reattached worker reads the run's baseline back from the run directory, so a token the run returned unchanged stays unchanged and never replaces a newer canonical one. If the baseline cannot be read, the returned tokens are kept for recovery (`baseline-unknown`) rather than written back.
7. **Finish.** The launcher copies refreshed token files and the workspace result files back into the run directory and records the exit status. It returns a token only when every path component below `/home/node`, `/tmp` or `/run` is a real directory and the token a regular file. A symlink the agent planted (for example `/home/node/.codex` pointing at the Sprite user's `/home/sprite/.codex`) counts as a failed export, so root never returns a file from outside the run's store. Nothing is returned when a process of the run survived `SIGKILL`, since a survivor could still swap a checked path. The result directory is not copied when it is a symlink, and symlinks inside it are dropped. It checks every step of the token copy: only when all of them succeeded does it record `credentials-exported` and delete every credential copy. Otherwise it keeps the live copies and records no export. Antigravity's CLI refreshes its token in the disposable HOME, and its entrypoint copies the token back to `/home/node/.gemini-source` only when it exits. So for Antigravity the launcher returns the disposable HOME's copy (`/tmp/propr-antigravity-home/.gemini`) whenever it exists, with the same path checks, and falls back to the store's copy only when there is none. A run killed (on timeout or cancellation) before that sync still returns its refreshed token. A symlink on that path counts as a failed export, and the disposable HOME is then kept with the other live copies. The launcher removes a disposable HOME an earlier run left before every run, so it never returns another run's token. Refreshed tokens are written back to the canonical store under its lock, the same way as for Docker runs. The worker writes back only after the launcher recorded its exit status and its `credentials-exported` record, because only then does a missing returned file mean that nothing refreshed. A run whose output connection was lost while its launcher was still stopping is waited for, and its processes are killed after a grace period so the launcher can finish. The worker writes a `credentials-retained` marker into the run directory when it uploads the credentials, and removes it only after a successful write-back, so a worker that stops mid-run leaves the Sprite quarantined (see below) rather than restorable over a rotated token. If the export cannot be confirmed (the Sprite paused under the run, or the launcher did not finish), the marker records `export-unconfirmed`. If the launcher finished but could not return every token, it records `export-failed`. Either way the live credential copies under `/home/node` stay where they are instead of being removed. If the write-back fails, the copy stays in the Sprite's run directory, the worker logs where it is, and it writes a `credentials-retained` marker into that directory. The marker quarantines the Sprite for every worker process: it is not restored and gets no other run until an operator copies each newer token file back to its canonical store and deletes the run directory. If the marker cannot be written, the worker keeps the Sprite out of use until it restarts. Once the worker has the workspace result, it releases the run. It first kills the run's process boundary and its launcher and checks that none of them is left. If some survive, the worker keeps the Sprite out of use until it restarts. Then it restores the Sprite to its clean checkpoint, which removes the clone workspace (with `.git`), `/tmp/propr-workspace-result` (with `result.bundle`), Antigravity's disposable HOME and the run directory. If restoring is off or fails, it removes those paths and every credential target as root instead. A run directory that holds a refreshed token the worker could not write back is kept, and a Sprite holding one is not restored. Then the worker frees the Sprite. A run that fails before it starts (during setup or the upload) is cleaned up and freed the same way, exactly once, and only after any preparation still running on the Sprite has finished. An idle Sprite goes cold and stops billing.

### Keep-Awake And Cold Pauses

The output followers keep a connection open for the whole run, and the worker also runs a cheap command on the Sprite every `PROPR_SPRITES_KEEP_AWAKE_INTERVAL_MS`. If the renewal or an output connection fails, the worker checks the Sprite state. A Sprite that went `cold` (or paused, stopped or suspended) under the run fails it with `SpritesRunInterruptedError` and a message naming the Sprite and the run. The run never hangs: an output connection that cannot be reestablished after 5 attempts, or a launcher that ended without an exit status (for example a Sprite restored under it), fails the same way. The deadline, cancellation, the spend cap and the activity watchdog stop the run through its launcher: `TERM` first, which the launcher forwards to the run's session, then `KILL` after 10 seconds for every process of the run's boundary. A stopped run settles within 45 seconds of the stop request even when neither request reaches the Sprite: the worker then closes the output connections and fails the run with `SpritesRunInterruptedError`, the credential copies stay under the recovery obligation, and the Sprite stays out of use until its processes are verifiably killed. `release()` cleans up after such a run once it settled, even when `stop()` gave up waiting for it.

### Startup Overhead

Each run logs one `Sprites run startup overhead` line with these timings (milliseconds), and `Sprites run workspace cloned` once the clone finished:

| Field | Measures |
| --- | --- |
| `queueMs` | Waiting for a free Sprite of this worker (all `PROPR_SPRITES_MAX_SPRITES` busy). |
| `wakeMs`, `created` | Getting the Sprite awake, or creating it (`created: true`), plus reading its setup stamp. |
| `setupMs` | First-time provisioning with its checkpoint. It only appears when a Sprite is new or the setup revision changed. It is dominated by the `npm install` of the pinned CLIs. |
| `restoreMs` | Restoring the clean checkpoint before a run. It only appears when the Sprite was not already restored at the previous release. The restore at release is logged separately (`Restored the Sprite to its clean checkpoint after the run`). |
| `credentialSyncMs` | Uploading the run files and the per-run credential copy. |
| `totalMs` | From the run request until the launcher started. |
| `cloneMs` | From the launcher start to the clone transport's "cloned" line: the authenticated fetch and checkout inside the Sprite. |
| `credentialWriteBackMs` | After the run: reading refreshed tokens back and writing them to the canonical stores. |

A warm, provisioned Sprite released cleanly pays `wakeMs + credentialSyncMs` before the agent starts (plus `restoreMs` when it was not restored at release), plus `cloneMs` for the repository. A cold Sprite adds its wake-up to `wakeMs`. A new Sprite or a new setup revision adds `setupMs` once. To measure a deployment, read these log lines, or run the live integration test (`PROPR_SPRITES_LIVE_TOKEN=... npx tsx --test test/spritesRuntime.live.test.ts`), which prints them for a real Sprite.

The Sprite image has no `bc` and no GNU `time`, so the launcher and setup script use neither. Timings are measured on the worker.
