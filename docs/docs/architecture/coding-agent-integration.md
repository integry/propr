---
sidebar_position: 5
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

Routing happens before the worker starts the runtime. Labels such as `llm-claude-sonnet46`, `llm-codex-gpt55`, `llm-opencode-minimax-m3-free`, or dynamic slash-command selections resolve to a concrete agent and model. The worker then passes that model to the selected implementation, while the implementation translates ProPR model IDs into whatever the underlying CLI expects.

See [Agents and Models](../features/agents-and-models.md) for label formats, aliases, defaults, and multi-model work splitting.

## Docker Runtime

Every supported coding agent uses the same containerized runtime shape: an agent image with ProPR's common tooling, an entrypoint script, the task worktree mounted at `/home/node/workspace`, and the required host credential directory mounted into the container. Most images build on the Debian/glibc `propr/agent-base` runtime while preserving the same runtime contract. The [Agent Runtime Reference](./agent-runtime.md) holds the canonical table of images, Dockerfiles, entrypoints, and credential mounts.

The runtime receives GitHub credentials, selected model settings, timeout settings, and any agent-specific environment variables. Containers run independently so concurrent jobs can use different agents and models without sharing mutable checkouts.

See [Isolated And Safe Execution](../features/execution-safety.md) for the execution boundary and [Agent Runtime Reference](./agent-runtime.md) for concrete runtime configuration and debugging details across all agent images.

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
