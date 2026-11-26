# Vibe CLI reference

Mistral Vibe CLI options and commands for agentic code generation.

> **Note:** This reference was written against `mistral-vibe==3.1.5` (pinned in
> `Dockerfile.agent`). Flags and commands may change between releases. Always
> verify against your installed version with `vibe --help` before treating this
> as authoritative. ProPR allows overriding the default CLI invocation via the
> `VIBE_CLI_ARGS` environment variable.

> **Verified vs inferred:** The global options table below was derived from
> `vibe --help` output for `mistral-vibe==3.1.5`. Programmatic execution behavior
> (structured output and the `--prompt` flag) is verified through ProPR
> integration tests but is not considered stable API by Mistral — pin the CLI
> version and use `VIBE_CLI_ARGS` to override if a future release changes flags.

> For installation, authentication, configuration, and ProPR integration details,
> see the [full Vibe documentation](vibe/index.md).

## Global Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `PROMPT` | string | — | Optional text instruction to start the session (positional) |
| `--prompt, -p` | string | — | Run once in programmatic mode with this prompt |
| `--output` | `text`, `json`, `streaming` | `text` | Programmatic output format |
| `--prompt-file` | path | — | Read the headless prompt from a file |
| `--model` | alias | configured model | Select a model for a new session |
| `--agent` | string | configured default | Built-in or custom agent/tool approval policy |
| `--auto-approve`, `--yolo` | boolean | `false` | Approve all tool calls |
| `--max-turns` | number | — | Maximum assistant turns in programmatic mode |
| `--max-price` | number | — | Maximum cost in programmatic mode |
| `--max-tokens` | number | — | Maximum total tokens in programmatic mode |
| `--setup` | boolean | `false` | Run the interactive setup wizard |
| `--workdir` | path | current directory | Working directory for file operations |
| `--add-dir` | path | — | Add another trusted working directory |
| `--trust` | boolean | `false` | Trust the working directory for this invocation |
| `--continue`, `-c` | boolean | `false` | Continue the most recent saved session |
| `--resume` | session ID | — | Resume a saved session or open the picker |

ProPR mounts each prompt read-only and passes its path through the native
`--prompt-file` option. For older pinned CLIs without this option, the container
entrypoint supplies the file through its compatibility runner.

## Commands

### `vibe --setup`

Run the interactive API-key and provider setup flow.

## Supported Models

| ID | Short Alias | Context |
|----|-------------|---------|
| `mistral-medium-3.5` | `mistral` | 256K |
| `zai-glm-5-3` | `glm53` | 1M |
| `zai-glm-5-2` | `glm52` | 1M |
