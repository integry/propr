---
sidebar_position: 6
---

# Agent Runtime Reference

This is the canonical runtime reference for ProPR coding agents. It covers the shared Docker execution model used by Claude Code, Codex, Antigravity, OpenCode, Mistral Vibe, and Pi. For the higher-level integration contract, routing model, and worker responsibilities, see [Coding Agent Integration](./coding-agent-integration.md).

## Runtime Model

Every coding agent runs in a Docker container so ProPR can control runtime dependencies, workspace mounts, credential mounts, timeouts, logging, and resource boundaries. The agent implementation changes the CLI command, image, credential directory, and output parser, but the container shape is shared:

- A task worktree mounted at `/home/node/workspace`
- Agent credentials mounted from a ProPR-managed per-agent directory or a configured existing host directory
- GitHub credentials passed through `GH_TOKEN` and `GITHUB_TOKEN`
- Agent, model, timeout, and task metadata passed as environment variables or CLI flags
- `--security-opt no-new-privileges`, `--cap-add CHOWN` (Vibe and Pi omit it), and Docker's default `bridge` network; the repository setup hook runs without sudo privileges before the agent entrypoint
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
| Pi | `propr/agent` | `Dockerfile.agent` | `scripts/pi-entrypoint.sh` | `HOST_PI_DIR` (`~/.pi/agent`) | `/root/propr-pi-source` (task and analysis source), `/home/node/.pi/agent` (login) |

## Container Configuration

The worker launches the unified agent image with a prepared worktree, a generated container name, the selected type's credential mount, and any agent-level environment variables. Containers are removed after execution with `--rm`, run with stdin enabled, and use `/home/node/workspace` as the working directory.

Docker starts an init process as PID 1 with `--init`. It reaps orphaned children, forwards signals to the entrypoint, and returns its exit status. When the entrypoint execs the agent CLI, the CLI receives those signals directly.

Most entrypoints start as root so they can prepare runtime directories or fix container-local ownership, then drop to the `node` user before running the CLI. Entrypoints also mark Git directories as safe, install the `gh` wrapper when present, and emit diagnostics that are captured with the task logs.

The Antigravity and OpenCode entrypoints keep running as root after the task returns, so they can write refreshed credentials and the transcript back to host mounts. The task could change anything `node` owns, so these steps run through the shared `scripts/privileged-post-task.sh` helper. Each step gets a fixed `PATH` (`/usr/sbin:/usr/bin:/sbin:/bin`) and an emptied environment, and calls binaries by absolute path. Task files count as data only: `scripts/task-file-transfer.py` reads them as `node` and refuses symlinks, hard links and files over a size limit. It then replaces the host file atomically, without following symlinks. The entrypoints and the helper are installed root-owned, so the task cannot rewrite them while they run. `scripts/smoke-test-entrypoint-privileges.sh` checks this against the built image.

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
| Pi | `PI_TIMEOUT_MS` | `86400000` (24 hours) | Not used | N/A |

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

For direct Docker inspection:

```bash
docker ps
docker logs <container>
docker inspect <container>
```

## Common Issues

### Authentication Issues

For a direct-login account, check that the managed credential root is mounted and that the agent's generated path is still `~/.propr/agent-credentials/<agent-id>/…`. For reused host credentials, check that the CLI is authenticated and the expected directory is mounted into the agent's container path. For example, Claude Code expects its selected directory at `/home/node/.claude`, while Codex expects its selected directory at `/home/node/.codex`. For an Antigravity login kept in the OS keyring, see [Antigravity troubleshooting](#troubleshooting-run-agy-to-log-in-although-you-are-signed-in).

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

The entrypoint prepares Antigravity runtime directories under the mounted config path and looks for auth, OAuth, credential, or token files. Disposable runs copy only `antigravity-cli/antigravity-oauth-token` and `antigravity-cli/settings.json` from it. When the run ends, those files are copied back to the mounted directory, so a refreshed Google token is kept. This also happens when ProPR stops the container (cancel, cost cap, watchdog or deadline): the entrypoint forwards the stop signal to `agy`, waits for it to exit, copies the files back, and exits with `143`. Goal runs mount the host directory as the runtime home, so `agy` updates the token in place. The agent CLI is `agy`; ProPR passes the selected model with `--model <id>` after translating ProPR model IDs into Antigravity CLI model IDs.

ProPR also passes `--print-timeout` set to the run's timeout (`ANTIGRAVITY_TIMEOUT_MS` for tasks). From Antigravity CLI 1.5.0, a run that hits that deadline exits with code `3`, prints an `AGY_ERROR` line and writes `[agy] print timeout after ...` to stderr. ProPR records such a task as timed out, with the CLI's explanation as the error, and does not accept the partial answer of an analysis run.

#### Troubleshooting: "Run 'agy' to log in" although you are signed in

On macOS and on a Linux desktop with a Secret Service keyring (gnome-keyring, KWallet), `agy` 1.5.x saves its sign-in token in the OS keyring. It writes only a marker, `~/.config/antigravity/credential-user-scope`, and no `~/.gemini/antigravity-cli/antigravity-oauth-token`. Agent containers have no keyring, so a task that reuses that `~/.gemini` stops after a few seconds with `Error: authentication required. Run 'agy' to log in, then retry.`, even though `agy models` works on the host.

ProPR reports this case with an actionable reason instead:

- The Settings agent card, `propr check` (`Agent login: antigravity (file token)`), `propr check agents` and the MCP `get_agent_configuration` tool (`credentialStates`) report the agent as not ready when its credential directory has no file token. The check looks only for the file; it never reads the token or the keyring. If the worker can see the host home, the message names the keyring marker it found.
- A task that fails because the entrypoint found no auth file, or because `agy` printed `authentication required`, carries the same reason. The raw CLI output stays in the task logs.

Fix it in one of two ways:

1. Sign in once on the host with file storage forced. This writes the file token next to your keyring login, which keeps working:

   ```bash
   AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1 agy
   ```

2. Use ProPR's managed login (**Log in to a new account** in Settings, or `propr agent login antigravity`). It runs `agy` inside a container with no keyring, so it always writes the file token.

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
curl -fsSL https://opencode.ai/v2/install | bash
# or: npm install -g @opencode/cli

mkdir -p ~/.config/opencode ~/.local/share/opencode
opencode --version
opencode auth login
```

OpenCode's config location is `~/.config/opencode`; configure OpenCode agents with that path. The built-in free models run without provider login — operators only need credentials for OpenCode Go or any other authenticated provider they configure.

#### Auth Data

OpenCode 2 stores credentials in `~/.local/share/opencode/opencode.db`. Set `HOST_OPENCODE_DATA_DIR` to the host data directory when it differs from the sibling of the configured `~/.config/opencode` directory. Managed accounts use their own data directory.

Task and analysis containers import credential rows into a disposable database. Changes to refreshed credentials are written back only when the stored value still matches the original. ProPR tells the store formats apart by the database schema, not by how many credentials it holds. A host database with a `credential` table and series 2 tables (such as `session_v2`) is the host store, even when it is empty: OpenCode 2 `auth logout` never edits `auth.json`, so ProPR drops anything the disposable database imported from a leftover `auth.json` and never writes to that file. Otherwise the host is on series 1: it has only `auth.json`, an `opencode.db` without a `credential` table, or a series 1 database whose `credential` table series 1 never reads. In that case the run uses the credentials OpenCode imports from `auth.json`, and ProPR leaves the host database unchanged and never creates one. OAuth refreshes are written back to `auth.json` instead, in the series 1 format and keeping the file mode. An entry is only updated if the host still holds the value the run started with. The write-back also runs when ProPR stops the container: the entrypoint forwards the stop signal through `opencode-run`, which passes it on to OpenCode and waits for it to exit; only then does the entrypoint write back once, and exits with `143`. The sync is capped at a few seconds so the container exits before Docker's stop timeout, and a skipped or failed sync is logged as a warning. Provider API keys can be supplied through agent environment variables.

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

Implementation prompts are written to a temporary prompt file and passed to Vibe with its native `--prompt-file` option so the prompt does not need to appear directly in process arguments. Analysis runs can use read-only config mode and a shorter `VIBE_ANALYSIS_TIMEOUT_MS`.

### Pi

Pi uses `Dockerfile.agent` and the `propr/agent` image. The `pi-cli` build stage installs `@earendil-works/pi-coding-agent` at `PI_CLI_VERSION` (1.6.1 by default) and checks that `pi --help` lists every flag ProPR passes. `scripts/agent-entrypoint.sh` hands a container started with `PROPR_AGENT_TYPE=pi` (or a `pi` command) to `scripts/pi-entrypoint.sh`.

Common settings:

```bash
HOST_PI_DIR=/home/your-user/.pi/agent
PI_CONFIG_PATH=/home/your-user/.pi/agent
PI_TIMEOUT_MS=86400000
PI_ANALYSIS_TIMEOUT_MS=1800000
```

Pi models are stored as `pi-<provider>/<model>` (for example `pi-anthropic/claude-sonnet-5-5`) and run as `pi -p --mode json --model <provider>/<model> --no-approve`, with the prompt on stdin. Provider API keys such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY` and `GEMINI_API_KEY` reach Pi through the agent's environment variables. They are passed through the Docker client's environment, so they never appear in the container's argument list.

#### Credential Mount And Disposable Agent Directory

For task and analysis runs the host Pi agent directory (an existing `~/.pi/agent`, `HOST_PI_DIR`/`PI_CONFIG_PATH`, or a managed `~/.propr/agent-credentials/<agent-id>/.pi/agent`) is mounted read-write under the root-only `/root` directory at `/root/propr-pi-source` (`PROPR_PI_SOURCE_DIR`). The entrypoint can write back OAuth refreshes through this mount. Pi and repository hooks run as `node` and cannot traverse it. The source cannot overlap another writable bind mount. With API keys alone, Pi runs without a source mount.

The mounted directory is only a source. Each run gets a fresh, owner-only disposable agent directory at `/tmp/propr-pi-home/agent` (`PI_CODING_AGENT_DIR`), with its sessions under `sessions/`. The entrypoint imports only `auth.json`, `settings.json`, `models.json`, `AGENTS.md`, `SYSTEM.md` and `APPEND_SYSTEM.md`. Host `sessions/`, `extensions/` and `mcp.json` are never copied, and ProPR writes its own `mcp.json` from `PROPR_PI_MCP_CONFIG` when it needs MCP servers. Sessions, extensions and package installs from a run therefore never reach the host. The entrypoint refuses a runtime home that overlaps the host directory in either direction. Pi's update check, install telemetry and startup catalog fetches are turned off (`PI_SKIP_VERSION_CHECK=1`, `PI_TELEMETRY=0`, `PI_OFFLINE=1`), and the restricted-network allowlist omits `pi.dev`. `--no-approve` keeps repository-provided `.pi/` extensions, settings and prompts from loading; `AGENTS.md` and `CLAUDE.md` context files still load.

The Pi CLI and reads of disposable credentials run as `node`. The credential synchronizer uses the entrypoint's privileges to update the host store, including private directories owned by a different UID. It writes a temporary file in the same directory with the original owner, group and mode, then renames it over `auth.json`. It never runs a recursive `chown`, and it refuses a symlinked `auth.json` (such a file is still imported, but refreshes are not written back).

The task can rewrite everything `node` owns: `/home/node` itself (so it can replace `/home/node/bin` entirely), the disposable Pi home and the workspace. So once the task exits, the entrypoint's remaining root steps (credential write-back and goal session restriction) run with a fixed `PATH=/usr/sbin:/usr/bin:/sbin:/bin` from `/`, and they call every binary by absolute path. They never source or execute anything from a task-writable location. Files the task could have written count only as data: they are read as `node` with `O_NOFOLLOW`, capped at 1 MiB and accepted only as a JSON object. After the run, `node` itself restricts goal session modes; root does not walk the tree the task just wrote.

#### Goal Sessions

Goal runs keep their sessions outside the disposable directory. The worker creates an owner-only host directory per goal, `/tmp/git-processor/pi-goal-sessions/<goal-id>` (`PI_GOAL_SESSIONS_PATH` overrides the root), and mounts it read-write at `/home/node/.propr-pi-goal-session` with `PROPR_PI_GOAL_SESSION_DIR` set. The entrypoint refuses a goal session directory inside the disposable home or the host Pi directory, chowns it to `node` and makes it and its files owner-only before Pi starts. After Pi exits, including after a stop, `node` makes it owner-only again, and root hands the directory itself (not recursively, through a descriptor opened before the run) back to its previous owner. The worker, whatever its UID, can then list the saved sessions and delete them with the goal; the session files stay owned by `node` (mode `0600`), so the worker never reads them. A store the worker cannot access fails with a permission error that names the directory. Pi runs with `--session-dir` on that directory and either `--session-id <id>` (a new goal session under the ID ProPR assigned) or `--session <file>` (the exact saved file of a resumed goal). The worker checks that the saved file exists before resuming, because Pi otherwise starts an empty session at a missing path. Deleting the goal removes the directory.

#### Refresh Write-Back Rules

After the run, `scripts/pi-credentials.py` writes OAuth token refreshes from the disposable `auth.json` back to the host `auth.json`:

- Only OAuth entries (`"type": "oauth"`) that Pi changed during the run are written. API-key entries are never rewritten, and nothing is written when no OAuth entry changed.
- Each provider entry is a compare-and-swap: it is written only while the host entry still equals what was imported, so a host login, logout or refresh during the run wins.
- A login made inside a run is never written back, because it is not a refresh of an imported entry. Use a managed login or `pi auth login` on the host instead.
- The write is atomic, under Pi's own `auth.json.lock` (the proper-lockfile lock Pi takes, stale after 30 seconds), through an owner-only temporary file. The replacement keeps the original file's UID, GID, and mode.
- A symlinked `auth.json` is imported (only when its target is inside the mounted credential source) but never written back, wherever it points. Refreshes then stay in the disposable copy, so the host login goes stale once the provider rotates its refresh token; the entrypoint logs a warning. Keep `auth.json` a regular file in the Pi directory.
- The sync also runs when the container is stopped mid-run: the entrypoint forwards `SIGTERM`, `SIGINT` and `SIGHUP` to Pi, waits for it to exit, and then syncs before exiting with Pi's status.

#### Managed Login

A managed login (Settings → Agents, or `propr agent login`) runs `pi auth login <provider> --no-browser` in a login container, or `pi auth login <provider> --api-key` to save an API key. `--no-browser` uses the provider's headless flow: a device code, a code to paste back, or the final redirect URL pasted into the terminal. The container sets `PROPR_PI_LOGIN=1`, which makes the entrypoint point `PI_CODING_AGENT_DIR` straight at the mounted credential directory instead of a disposable copy, so Pi writes `<agent-dir>/auth.json` directly. ProPR-managed directories (`PROPR_MANAGED_CREDENTIALS=1`) are chowned to `node` first. An existing host directory is never chowned and must already be writable by UID 1000. The provider defaults to the provider of the agent's default model.

#### Health Check

The agent health check runs `pi auth check --provider <provider> --json --no-refresh` in the agent image with no network and a read-only mount of the credential directory, with the agent's provider API keys in its environment. The provider is taken from the health-check model. Exit codes 0, 1 and 2 mean `ready`, `not_ready` and `invalid`. `not_ready` and `invalid` are reported as sign-in required with Pi's reason (for example `credentials_not_configured`). `--no-refresh` means the check never refreshes or rewrites OAuth tokens.
