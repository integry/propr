---
sidebar_position: 5
sidebar_label: "Coding Agent Integration"
title: "Coding agent integration: OpenCode, Codex, and more"
description: "Learn how ProPR integrates coding CLIs through shared Docker execution, credentials, model routing, and runtime contracts."
---

# Coding Agent Integration

ProPR runs Claude Code, Codex, Antigravity, OpenCode, and Mistral Vibe through one shared coding-agent integration pattern. The agent name changes the CLI, image, credential mount, and model catalog, but the architectural contract stays the same: ProPR routes a job to an enabled agent, starts that agent in a Docker runtime, gives it a bounded prompt, parses its output, and then the worker finalizes the result.

The [Agent Runtime Reference](./agent-runtime.md) covers runtime and agent-specific details that do not belong in the common contract.

## Integration Contract

<div className="propr-flow" aria-label="Coding agent integration architecture">
  <div className="propr-flow__row">
    <div className="propr-flow__node">
      <span className="propr-flow__title">Agent Registry</span>
      <span className="propr-flow__detail">Loads enabled agent configs and capabilities</span>
    </div>
    <div className="propr-flow__arrow">→</div>
    <div className="propr-flow__node">
      <span className="propr-flow__title">Model Routing</span>
      <span className="propr-flow__detail">Maps labels and commands to an agent/model pair</span>
    </div>
    <div className="propr-flow__arrow">→</div>
    <div className="propr-flow__node">
      <span className="propr-flow__title">Docker Runtime</span>
      <span className="propr-flow__detail">Runs the selected CLI in an isolated worktree</span>
    </div>
    <div className="propr-flow__arrow">→</div>
    <div className="propr-flow__node">
      <span className="propr-flow__title">Worker Finalization</span>
      <span className="propr-flow__detail">Commits, pushes, opens PRs, and records state</span>
    </div>
  </div>
</div>

The contract keeps deterministic ProPR responsibilities outside the agent. Agents edit files in the prepared workspace. The worker owns repository setup, branch management, commits, pull requests, task state, and GitHub comments.

## Registry And Model Routing

Enabled agents are stored as normal ProPR agent configs with a type, alias, Docker image, credential path, supported models, default model, and optional environment variables. The registry uses those configs to create the implementation class for the selected agent type.

Routing happens before the worker starts the runtime. Labels such as `llm-claude-fable52`, `llm-codex-astra`, `llm-opencode-big-pickle`, or dynamic slash-command selections resolve to a concrete agent and model. The worker then passes that model to the selected implementation, while the implementation translates ProPR model IDs into whatever the underlying CLI expects.

See [Agents and Models](../features/agents-and-models.md) for label formats, aliases, defaults, and multi-model work splitting.

## Docker Runtime

Every supported coding agent uses the unified Debian/glibc `propr/agent` image and a type-specific entrypoint. Docker makes the task worktree available at `/home/node/workspace`, using a bind mount by default, and mounts any required host credential directories into the container. The [Agent Runtime Reference](./agent-runtime.md) holds the canonical table of entrypoints and credential mounts.

The runtime receives GitHub credentials, selected model settings, timeout settings, and any agent-specific environment variables. Containers run independently so concurrent jobs can use different agents and models without sharing mutable checkouts.

### Runtime Seam

Providers do not build `docker run` argv. Each implementation describes its run as an `AgentRunSpec` (`packages/core/src/agents/runtime/types.ts`): the image and agent type, entrypoint and CLI arguments, environment variables, the workspace, credential and git mounts, resources (memory, CPUs, PIDs, init process), network mode, the MCP grant from the run's tool policy, labels, and the repository setup wrapper. The spec builders are `buildClaudeRunSpec`, `buildCodexRunSpec`, `buildAntigravityRunSpec`, `buildOpenCodeRunSpec`, and the Vibe agent's `buildRunSpec`.

An `AgentRuntime` starts a spec and returns a handle with `stdout`/`stderr` streams, `wait()`, `stop(signal, timeout)`, `inspect()`, and `isAlive()`. The streams carry output from the moment they are first read, and each holds at most 1 MiB for a reader that falls behind: the agent is not slowed to match its reader, so further output is dropped until the reader catches up, and the stream then reports how many bytes were lost. The run's result keeps the executor's own capture regardless. `stop()` resolves only once the launch has settled: a launch still in preparation (network policy, admission, container create) is cancelled rather than treated as stopped because no container exists yet. Runtimes declare capability flags (`supportsBindMounts`, `supportsRestrictedNetwork` with `restrictedNetworkEnforcement` saying how, `supportsMcpPrivateNetwork`, `supportsMcpReachableUrl`, `reattach`), and a spec that needs a missing capability is refused before launch with an `AgentRuntimeCapabilityError` (see [Runtime capability checks](./agent-run-admission.md#runtime-capability-checks)). Dispatch also attaches the runtime-neutral `network.policy`: `open`, or `restricted` with the complete host/port allowlist, which non-Docker runtimes enforce. The effective network requirement is resolved before dispatch: when the run's policy (or, outside any run policy, the enforced instance policy) is restricted, the spec carries it as `network.restriction`, and a runtime without `supportsRestrictedNetwork` is refused. A spec that already carries its own `network.restriction` keeps it: dispatch refuses the run when the applying policy differs, whatever the runtime and even with a network exemption, instead of overwriting the spec's allowlist. The Docker runtime enforces `network.restriction` from the spec itself: it runs the launch under that policy, so the executor replaces the container's network with the egress proxy even when no run policy is active, and a caller's network exemption does not open such a spec. A restriction that differs from the policy applying at launch (an enclosing restricted run, or the enforced instance policy) is refused instead of replacing it. `runtime/registry.ts` selects the runtime from the agent's `runtime` setting, then `PROPR_AGENT_RUNTIME`, then `docker`. An unknown name fails the run.

`DockerRuntime` is the default runtime. It renders a spec to the same argv ProPR used before the seam (`renderDockerRunArgs`), and golden tests compare that argv with the earlier builders for every provider. The Docker executor recognizes agent runs by the spec they carry, not by matching argv, for admission, the spend cap, the native-log gate, container detection, and extension launches. Helper containers that still pass raw `docker run` argv (capability probes, package verification) are admitted as containers, as before. Native goal transports still spawn the rendered argv directly because they need an interactive stdin channel, so they resolve the runtime selection before every launch and refuse any runtime other than `docker` (including unknown names).

`SpritesRuntime` (`PROPR_AGENT_RUNTIME=sprites`, or an agent's `runtime: "sprites"`) runs Claude Code, Codex and Antigravity on Fly Sprites through `@fly/sprites`. It declares no bind mounts and offers only the clone workspace transport. Instead of host binds it accepts credential stores, which the broker copies over the Sprites filesystem API, small read-only files, which it uploads, and log or scratch directories, which start empty on the Sprite (`AgentRuntime.unsupportedMount`). Every other bind is refused before launch. It sets `reattach`, and `attach()` follows a run another worker process started. See [Fly Sprites Runtime](./agent-runtime.md#fly-sprites-runtime).

Credential mounts in a spec are tagged with their provider store (`credentialStore`). Before a runtime with bind mounts starts the spec, `runAgent` asks the credential broker (`packages/core/src/agents/credentials/`) to stage a per-run copy of the files listed in that provider's manifest (`providerManifests.ts`). It then points the mount at the copy. When the run settles, refreshed token files are written back to the canonical store under a lock, and the newer copy wins. Specs that resume provider sessions from the store mark the mount `perRun: false` and keep the direct mount. `PROPR_AGENT_CREDENTIAL_BROKER=legacy` restores direct mounts everywhere. In clone mode, any provider credential mounts still require access to their host paths. A remote runtime can use `CredentialBroker.materialize()` to get the files to send and `commit()` with the files it gets back.

### Workspace Transport

How the task workspace reaches a run is a `WorkspaceTransport` (`packages/core/src/git/workspaceTransport.ts`), selected per run by `AgentRunSpec.workspace.mode`, then `PROPR_WORKSPACE_TRANSPORT` (`bind` or `clone`), then `bind` on a runtime that can bind-mount and `clone` on one that cannot. Runtimes list the transports they support in the `workspaceTransports` capability; `DockerRuntime` supports both and keeps `bind` as its default.

- `bind` (default): the worker worktree under `/tmp/git-processor/worktrees` is bind-mounted at `/home/node/workspace`, together with the git metadata, so both sides need identical paths.
- `clone`: for a runtime (or a Docker host such as a remote `DOCKER_HOST`) that cannot see the worker's paths. The worker refuses a dirty worktree, publishes its HEAD to `refs/propr/runs/<runId>/base`, and mints an installation token scoped to the one repository (`contents: write`). A read-only workspace (repository analysis) is refused in clone mode before anything is published: a sandbox checkout cannot match the bind transport's read-only mount, since file modes do not stop an agent running as root and the agent could replace the checkout in its own home directory, so read-only runs need the bind transport. The spec loses its workspace and git mounts and gains a wrapper that runs outside the repository setup wrapper. Removing the variable does not erase the wrapper's initial environment (`/proc/<pid>/environ`) or its memory, which any process with the same user ID can read, so the user ID is the token's boundary: the worker refuses a clone-mode run that does not start as root (`user` `0` or `root`) before publishing anything or minting a token, and the wrapper refuses to run anything, before any credentialed operation, unless it is root with `su-exec` and an unprivileged `node` user. The setup hook (dropped by the repository setup and workflow wrappers), the agent (dropped by its provider entrypoint, which does so only when it has a command to run, so a clone-mode run without one is refused; a run with an explicit entrypoint and no setup wrapper is started as `node` by the wrapper itself) and the workspace snapshot (dropped by the wrapper) all run as `node`. The wrapper removes the token from its environment before anything else starts, fetches the base into a private bare repository only it owns, clones the base commit from there onto the task branch, and runs the setup hook and agent as a child, forwarding stdin and termination signals. When the agent exits, the wrapper snapshots the workspace as one commit under the agent's own identity (`node`, as the setup hook runs): the agent's HEAD, every non-ignored change, and `.propr/previews`. The snapshot crosses into the private repository as a bundle, and the wrapper pushes it from there to `refs/propr/runs/<runId>/result`. Credentialed git commands run only in that private repository, against the fixed remote URL, with global configuration and git's program-selecting environment variables ignored, so configuration the setup hook or agent writes to the workspace `.git` or `~/.gitconfig` (remotes, `url.*.insteadOf`, `core.sshCommand`, credential helpers, filters) never reaches the token. If the push fails, it writes a git bundle that the worker reads back through the runtime file API (`AgentRunHandle.readFile`; Docker keeps the stopped container until `release()` and copies the file out with `docker cp`). The token is sent through the launch environment, never in argv or the spec. Git only receives it as an `http.extraheader` in the environment of the wrapper's own git commands, so it is never written to disk.

In clone mode the worker still owns commits and PRs. It fetches the result into the existing worktree and lays the snapshot over it as uncommitted changes, leaving its branch and HEAD unchanged. The one exception is an agent that owns git, such as an orchestrated goal with writable git metadata: its commits move the branch first. The usual commit, PR, review and follow-up flow then continues unchanged. After every run, whether it succeeded, failed or was aborted, the worker revokes the token. It also deletes the temporary refs and releases the kept run, except for a copy that is the last recoverable one for a returned result that was not applied. If the worker could not retrieve the result, for example because its fetch failed after the sandbox pushed, it keeps `refs/propr/runs/<runId>/result` and does not release the run (Docker removes an unreleased container after 10 minutes). When the sandbox left a bundle, or its status could not be read, the run may hold the only copy: the worker retains it (`AgentRunHandle.retain()`, which cancels Docker's automatic removal) before reading the bundle, and a run whose bundle could not be retrieved stays until it is released explicitly. If the worker retrieved the result but could not apply it, for example because the worktree moved, it keeps the snapshot on the local `refs/propr/runs/<runId>` ref in the worktree and discards the sandbox copies. The error and a cleanup warning name what was kept. An aborted run applies nothing. That includes a run cancelled after it exited, while its result is being returned: the worker checks the run's cancellation (the caller's signal and the execution's ownership) before retrieving and again right before changing the worktree, and reports the cancellation instead of the run's result. A result it already retrieved stays on the local `refs/propr/runs/<runId>` ref. A run that exits non-zero still returns its partial work. Native goal sessions launch Docker directly and refuse any transport other than `bind`.

See [Isolated And Safe Execution](../features/execution-safety.md) for the execution boundary and [Agent Runtime Reference](./agent-runtime.md) for concrete runtime configuration and debugging details across all agent entrypoints.

## Prompt Boundary

The worker builds a prompt from the job context and passes it to the selected agent. The exact prompt varies by job type, but it normally includes:

- The issue, plan, pull request comment, or review command that triggered the run
- Relevant comments and review feedback
- Repository, branch, and worktree context
- Scope constraints and expected behavior
- Direction to modify files rather than perform git or GitHub finalization

This boundary is stable across agents. The CLI can inspect and edit the workspace; ProPR remains responsible for final repository and GitHub operations.

## Output Parsing

Agent implementations capture standard output, standard error, exit code, duration, and any structured output the CLI can provide. Some agents produce stream or JSON output; others require adapter-specific parsing. The implementation normalizes the result enough for the worker to record logs, show status in the Web UI, detect failures, and continue to finalization.

OpenCode is an example of an agent with its own output adapter: it runs in JSON mode and `openCodeUtils` maps OpenCode responses back into ProPR's expected result shape. Claude Code uses its own CLI flags and stream output handling. Both fit behind the same worker contract.

## Worker Finalization

After the agent exits, the worker inspects the prepared worktree and finalizes the job:

- Detects changed files
- Creates a commit when there are changes
- Pushes the task branch
- Opens or updates a pull request
- Links the result back to the source issue or task
- Posts status comments and updates task state

If the agent made no changes, the worker records that outcome instead of creating an empty commit. See [Worker Architecture](./worker.md) and [Worker Runtime Reference](./worker-runtime.md) for the full job lifecycle.

## Agent-Specific Details

Use the generic integration contract first, then branch into agent details only when you need setup or runtime behavior for a specific CLI:

- [Agent Runtime Reference](./agent-runtime.md): shared container settings, network behavior, timeouts, debugging, and per-agent runtime notes.
- [Claude Code Runtime Details](./agent-runtime.md#claude-code): Claude Code container settings, CLI invocation, timeouts, and troubleshooting.
- [OpenCode Runtime Details](./agent-runtime.md#opencode): OpenCode host setup, auth-data handling, model-ID translation, and JSON execution mode.
- [Agents and Models](../features/agents-and-models.md): supported model labels and credential setup across all agents.

## Related Pages

- [Agents and Models](../features/agents-and-models.md)
- [Worker Architecture](./worker.md)
- [Worker Runtime Reference](./worker-runtime.md)
- [Isolated And Safe Execution](../features/execution-safety.md)
- [Agent Runtime Reference](./agent-runtime.md)
- [Claude Code Runtime Details](./agent-runtime.md#claude-code)
