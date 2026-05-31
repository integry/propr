# Vibe CLI reference

Mistral Vibe CLI options and commands for agentic code generation.

> **Note:** This reference was written against `mistral-vibe==2.12.1` (pinned in
> `Dockerfile.vibe`). Flags and commands may change between releases. Always
> verify against your installed version with `vibe --help` before treating this
> as authoritative. ProPR allows overriding the default CLI invocation via the
> `VIBE_CLI_ARGS` environment variable.

> **Verified vs inferred:** The global options table below was derived from
> `vibe --help` output for `mistral-vibe==2.12.1`. Auth sub-commands and the
> `--setup` wizard were tested interactively. Headless execution behavior
> (structured JSON output, `--prompt` flag) was verified through ProPR
> integration tests but is not considered stable API by Mistral — pin the CLI
> version and use `VIBE_CLI_ARGS` to override if a future release changes flags.

> For installation, authentication, configuration, and ProPR integration details,
> see the [full Vibe documentation](vibe/index.md).

## Global Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `PROMPT` | string | — | Optional text instruction to start the session (positional) |
| `--prompt` | string | — | Explicit prompt flag (equivalent to positional PROMPT) |
| `--model, -m` | string | `mistral-medium-3.5` | Override the model (e.g., `devstral-2512`) |
| `--setup` | boolean | `false` | Run the interactive setup wizard |
| `--headless` | boolean | `false` | Non-interactive mode for CI/scripting |
| `--timeout` | number | `300000` | Session timeout in milliseconds |
| `--context-dir` | path | `.` | Working directory for file operations |
| `--json` | boolean | `false` | Output structured JSON results |

## ProPR Entrypoint Extensions

The following flags are handled by `scripts/vibe-entrypoint.sh` before the
Vibe CLI is invoked. They are **not** native Vibe CLI flags.

| Flag | Description |
|------|-------------|
| `--prompt-file PATH` | Read prompt text from PATH and pass it to vibe via `--prompt`. Avoids long command-line arguments in process listings. |

## Commands

### `vibe auth login`

Authenticate with Mistral API. Prompts for API key and stores it in
`~/.vibe/credentials.json`.

### `vibe auth logout`

Clear stored credentials.

### `vibe auth status`

Display current authentication state and configured API key (masked).

### `vibe --setup`

Interactive first-run wizard. Guides through:
1. API key configuration
2. Default model selection
3. Workspace preferences

## Supported Models

| ID | Short Alias | Context |
|----|-------------|---------|
| `mistral-medium-3.5` | `medium35` | 256K |
| `devstral-2512` | `devstral2` | 256K |
| `devstral-small-latest` | `devstral-small` | 256K |
