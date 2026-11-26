---
sidebar_position: 6
---

# Agent Runtime Reference

The worker selects the agent’s configured runtime, then the instance default (`PROPR_AGENT_RUNTIME`), then Docker. Choose a runtime that supports the provider and the repository’s network policy.

| Capability | Docker (`docker`) | Sprites (`sprites`) | Fly Machines (`fly-machines`) |
| --- | --- | --- | --- |
| Coding agents | Claude Code, Codex, Antigravity, OpenCode, Mistral Vibe | Claude Code, Codex, Antigravity | Claude Code, Codex |
| Workspace | Host worktree or clone | Clone with scoped token | Clone with scoped token |
| Isolation and lifetime | Container per run on the operator’s daemon | One run per leased Sprite, restored to a clean checkpoint before reuse | Fresh Machine per run, destroyed after result retrieval |
| Restricted network | Worker allowlist proxy | Sprite DNS allowlist | Restricted runs refused |
| Agent extensions | Supported | Unsupported | Unsupported |
| Capacity | Host CPU, RAM and worker concurrency | Redis-backed pool, default two Sprites | Available Machine slots in the agent app’s organization |

For the run contract see [Coding Agent Integration](./coding-agent-integration.md). For a control plane that delegates all agent work to Fly, follow [Run ProPR on Fly](../tutorials/setup-fly.md).

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

Agent runs go through the runtime seam described in [Coding Agent Integration](./coding-agent-integration.md#runtime-seam). Docker is the default runtime (`PROPR_AGENT_RUNTIME=docker`). The container shape below is how `DockerRuntime` renders each provider's `AgentRunSpec`. With `PROPR_WORKSPACE_TRANSPORT=clone`, the worktree and git mounts are left out. The container clones the task base with a short-lived repository-scoped token and returns its result through a temporary `refs/propr/runs/<runId>/result` ref, falling back to a bundle. It also runs without `--rm` so the worker can read the result files before removing it. See [Workspace Transport](./coding-agent-integration.md#workspace-transport).

## Fly Machines

Set `PROPR_AGENT_RUNTIME=fly-machines` on the worker or `runtime: fly-machines` on a Claude Code or Codex agent. Each task gets a new Machine in `PROPR_FLY_APP`. Set `PROPR_FLY_API_TOKEN` to a deploy token scoped to that app, or supply it in `FLY_API_TOKEN`. Use a dedicated agent app in the control plane’s Fly organization.

Build the unified agent image from the repository root with `fly deploy --remote-only --build-only --push --dockerfile Dockerfile.agent -a <agent-app>`. On an app with no releases, a remote build can push only by digest. Copy the manifest digest from the build output’s `pushing manifest … @sha256:` line and set `PROPR_FLY_IMAGE=registry.fly.io/<agent-app>@sha256:<digest>` on the worker. The selected image supplies both provider CLI versions.

`PROPR_FLY_REGION` selects a region. Fly chooses the placement when it is unset. `PROPR_FLY_MACHINE_SIZE` accepts `shared-cpu-<n>x` or `performance-<n>x` and defaults to `shared-cpu-2x`. `PROPR_FLY_MACHINE_MEMORY_MB` defaults to 2048. `PROPR_FLY_BOOT_TIMEOUT` sets the time allowed for creation, image pull and guest readiness in seconds (default 300).

Runs use a writable clone workspace and receive per-run credential copies. The root launcher keeps the workspace token separate and drops to `node` for the provider. Only declared refreshed credential files return to the worker. Extension runs, host bind mounts and restricted-network runs are refused. A Fly-hosted control plane exposes MCP at `http://api.process.<control-plane-app>.internal:<DASHBOARD_API_PORT>/api/mcp` (default port 4000). Set `PROPR_FLY_MCP_URL` to override the endpoint, including for a custom API process group. Elsewhere set `PROPR_AGENT_MCP_URL` without a pinned Docker network or set `API_PUBLIC_URL`. MCP uses the per-run grant token.

With an active cost cap, the worker reads new stdout bytes while the Machine runs so the shared cost guard can stop the agent. If a capture read fails, the worker retries from the last validated byte. Read failures lasting 15 seconds or a record over 16 MiB stop a capped run with an accounting error. After exit, the worker reads the remaining stdout and scans stderr for workflow reports. The shared result retains up to 1 MiB per stream. For streams collected only for results and workflow reports, reads are capped at 16 MiB per stream. For a larger capture the worker scans the retained tail and reports truncation. A truncated prefix that could contain required workflow records fails the run. Fly logs provide a best-effort live display and may omit lines. A missing capture or exit status fails the run.

With pending credentials, a SIGKILL request gives the provider at least five seconds to exit on SIGTERM before forced recovery. A graceful stop allows the clone transport to finish its snapshot. The worker copies any fallback bundle to a private temporary directory before destroying the Machine. If settlement rejects after collection, the error identifies the local recovery directory. The bundle survives release so it can be recovered manually. If workspace application fails, the clone transport reports the recovery location. If bundle retrieval fails, the worker reports the Fly app, Machine ID and guest directory. After the task exits, `PROPR_FLY_CREDENTIAL_RETENTION_SECONDS` sets the recovery window for both fallback bundles and pending credentials (default 900 seconds, or 15 minutes). When the window expires, the guest exits and Fly destroys the Machine. Any uncollected bundle is lost. A guest waiting only for credential write-back exits early on acknowledgement. If credential export or write-back fails, the worker reports the Machine and provider directory for recovery. Recover `/root/propr-run/workspace/result.bundle` from that Machine and destroy it after verifying the recovered copy.

The Free plan allows three Machines, including stopped Machines and the control plane. Size worker concurrency for the slots available across the organization. Run Machines use `restart: no` and `auto_destroy: true`. The worker requests destruction as soon as it finishes retrieval. If deletion fails after collection, the worker logs the Machine ID and retries in the background while returning the collected result.

To verify a deployment, set `PROPR_FLY_LIVE_TOKEN`, `PROPR_FLY_LIVE_APP` and `PROPR_FLY_IMAGE`, then run `npx tsx --test test/flyMachinesRuntime.live.test.ts`. The suite starts one Machine at a time and exercises task completion, graceful stop, bundle retrieval and destruction.

## Fly Sprites

The Node 22 worker pins `@fly/sprites` to 0.2.5. Upstream declares Node 24 or newer. CI smoke-tests the pinned SDK on Node 22, and the live runtime suite checks service compatibility before merge. Sprites refuses runs that require extensions.

Set `PROPR_AGENT_RUNTIME=sprites` on the worker, or set `runtime: sprites` on an individual Claude Code, Codex, or Antigravity agent. Supply an organization token in the worker’s `PROPR_SPRITES_TOKEN` environment variable (`SPRITES_TOKEN` is also accepted). The worker defaults `SPRITES_CLIENT_SIGNALS` to `0` unless the operator sets it. Runs use the clone workspace transport. Restricted runs use the Sprite's DNS allowlist, which the worker applies before the run and clears after restoring the checkpoint. Runs reach ProPR MCP as described in [ProPR MCP from Sprites](#propr-mcp-from-sprites). See [Restricted mode on Fly Sprites](../features/execution-safety.md#restricted-mode-on-fly-sprites).

### ProPR MCP from Sprites

Automation runs (and every other run with a ProPR MCP grant) reach ProPR MCP from the Sprite in one of two ways. The worker picks one before it requests the run's grant. `PROPR_SPRITES_MCP_TRANSPORT` sets the preference:

- `auto` (the default) follows the order below: a public or explicit URL when one exists, otherwise the forward.
- `forward` always uses the SSH reverse forward, even when `PROPR_SPRITES_MCP_URL`, a public `PROPR_AGENT_MCP_URL` or `API_PUBLIC_URL` is set. ProPR MCP then never has to be reachable from the internet: the Sprite reaches it only through the worker's outbound connection. This does not disable or hide a public MCP endpoint: if the API is publicly routed with MCP enabled, OAuth clients can still reach it there. A run is refused rather than falling back to a URL when the forward is turned off (`PROPR_SPRITES_MCP_FORWARD=0`) or `PROPR_INTERNAL_API_URL` is unusable. Any other value refuses Sprites runs that need ProPR MCP, so a typo never silently picks a public URL.

With `auto`:

1. **A public or explicit URL, used directly.** That is `PROPR_SPRITES_MCP_URL` when set (for example a public ProPR origin or a gateway in front of the API). Otherwise it is a public HTTPS `PROPR_AGENT_MCP_URL` (without `PROPR_AGENT_DOCKER_NETWORK`) or `API_PUBLIC_URL` + `/api/mcp`. This covers ProPR hosted on Fly and Plus installations with the hosted UI tunnel. A public HTTPS URL is preferred when you have one: it needs no sshd in the Sprite and no worker-held connection.
2. **Otherwise, a per-run SSH reverse forward (`ssh-reverse-forward`).** This is for self-hosted instances behind NAT with no public URL. The worker already connects out to the Sprite, and the forward carries MCP back over that path, so nothing is exposed publicly:
   - For each run, the worker generates an ephemeral ed25519 client key and an sshd host key, in memory only. Neither is logged or kept after the run.
   - Before the agent starts, the worker starts an sshd in the Sprite. It is bound to `127.0.0.1:39022` only and authorizes just that key for the `propr-mcp` user (`restrict,port-forwarding,permitlisten="127.0.0.1:39080"`). Password, keyboard-interactive and host-based auth are off, and so are sessions, shells, TTYs, agent, X11, tunnel and local forwarding.
   - The worker reaches that sshd only through the Sprites API proxy (`proxyPort`), checks the host key it generated, and asks for one remote listener on `127.0.0.1:39080`. Each connection to that listener is relayed to the internal API host and port in `PROPR_INTERNAL_API_URL` (default `http://api:4000`), and only there. A connection to the API that does not complete within 10 seconds is refused, and closing the forward also closes connections still being set up.
   - The relay passes raw bytes, so requests reach the API with the agent's `Host: 127.0.0.1:39080`. That is why `PROPR_INTERNAL_API_URL` must be a plain `http://` URL on a loopback or private address (an IP in 127/8, 10/8, 172.16/12, 192.168/16, 100.64/10, 169.254/16, `::1` or `fc00::/7`), `localhost`, a single-label name such as the Compose service `api`, or a `.internal`/`.local` name. There the `Host` header does not route requests. An `https://` or public target, where a vhost- or SNI-routed server would answer 404 or 421, refuses the forward with a message saying what to set.
   - The agent's ProPR MCP config names `http://127.0.0.1:39080/api/mcp`, and it still has to present its per-run grant token. The runtime selects the forward from that URL itself, not from a separate flag that every rebuilt tool policy would have to copy. A Sprites run whose ProPR MCP URL is some other loopback address (for example `http://127.0.0.1:4000`) is refused with an explicit error, because nothing inside the Sprite listens there. Responses are relayed as plain byte streams, so streamed and SSE responses work. The address is loopback, so a restricted Sprite's network policy gets no MCP host entry.
   - The forward is torn down with the run: after success, failure, cancellation or timeout, and when a lost connection cannot be reattached. The worker asks the Sprite to stop the sshd in the background, without holding the run's slot for it; the Sprite reset to its clean checkpoint stops it anyway and removes the keys. If the forward drops mid-run, the worker reconnects. Before each attempt it ends the `propr-mcp` user's stale sessions over the Sprites exec API (`mcp-forward.sh reset-sessions`) and waits until `127.0.0.1:39080` is free: after a half-open proxy path the old session would otherwise keep the listener and every new forward would fail with "address in use". sshd itself drops a silent client after 10 seconds (`ClientAliveInterval 5`, `ClientAliveCountMax 2`). The worker keeps trying for at least five attempts with backoff and at least 30 seconds, three times that timeout. If every attempt fails, the run fails with a `MCP_TRANSPORT_LOST` error instead of leaving tool calls hanging.
   - The task log records the transport (`ProPR MCP transport: ssh-reverse-forward`).

   Provisioning installs `openssh-server` when the Sprite base image lacks it. It keeps the packaged system sshd from starting or running at boot and creates the shell-less `propr-mcp` user. Set `PROPR_SPRITES_MCP_FORWARD=0` (or `false`, `off`, `no`) to turn the forward off. The value is parsed strictly: anything other than true/false values (`1`/`0`, `true`/`false`, `on`/`off`, `yes`/`no`), such as `disabled` or `none`, refuses Sprites runs that need ProPR MCP with `Invalid PROPR_SPRITES_MCP_FORWARD`, so a misspelling never leaves the forward on.
3. **Otherwise the run is refused** before a grant is issued (`MCP_NETWORK_UNAVAILABLE`), with what to configure. This happens when the forward is off and no public URL is set, or when `PROPR_INTERNAL_API_URL` is not a plain `http://host:port[/path]` URL on a loopback, private or internal address.

`get_agent_run_admission` and `propr admission` show the transport the preference selects.

Fly Machines runs reach MCP over Fly's private network instead and never use the forward.

Workers sharing the installation’s Redis database share one Sprite pool limit. Set `PROPR_SPRITES_MAX` on every worker (default 2; the Free plan allows 3). Use the same Sprites organization on all workers. Each new machine reserves capacity before creation. At capacity, a run waits for a clean Sprite for up to `PROPR_SPRITES_QUEUE_TIMEOUT` minutes (default 10). Idle machines can be released to make room on another worker.

Workers persist the deployment marker under the shared `DATA_DIR` and rebuild missing Redis inventory from the provider before admitting capacity. For the inventory format upgrade, stop the previous workers together and retain Redis until the new worker has saved the existing deployment marker. Installations sharing a Redis database must set distinct `PROPR_INSTANCE_ID` values, consistent across each installation’s API and workers. Workers renew leases every five seconds. After a crash, leases expire after three minutes, and the machine continues to count toward capacity until deletion is confirmed. On startup and every five minutes, workers check the deployment’s machines and remove unleased ones older than `PROPR_SPRITES_ORPHAN_AGE` (minutes, default 30). View counts in `propr status`, Settings → Agent runtime packages, or the `get_agent_run_admission` MCP tool. Run compute usage reports capacity wait separately as `queueMs` and includes the provisioning and checkpoint restore times for the clean Sprite supplied to that run. A warm checkout reports zero provisioning time.


The worker creates a privately named Sprite for each concurrent run and reuses restored Sprites within its process. Provisioning installs the versions pinned in `Dockerfile.agent` and takes a clean checkpoint before uploading any run data. The clone transport holds its repository token separately while the setup hook and provider entrypoint run as the unprivileged `node` user. The worker reads provider credentials after acquiring the Sprite, immediately before uploading the run payload. The agent timeout starts at launch. Each provisioning attempt has a separate 21-minute deadline. Each CLI uses a writable copy of its read-only source. The worker collects only declared refreshable files through the launcher export and commits them through the broker.

If the launch connection drops, the worker attempts to reattach once to observe process exit. The pinned SDK exposes no output resume offset. A reattached run reports incomplete output after workspace retrieval, and its workflow reports are marked unobserved.

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
