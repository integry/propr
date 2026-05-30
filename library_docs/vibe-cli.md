# Vibe CLI reference

Mistral Vibe CLI options and commands for agentic code generation.

> For installation, authentication, configuration, and ProPR integration details,
> see the [full Vibe documentation](vibe/index.md).

## Global Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `PROMPT` | string | — | Optional text instruction to start the session |
| `--model, -m` | string | `mistral-medium-3.5` | Override the model (e.g., `devstral-2512`) |
| `--setup` | boolean | `false` | Run the interactive setup wizard |
| `--headless` | boolean | `false` | Non-interactive mode for CI/scripting |
| `--timeout` | number | `300000` | Session timeout in milliseconds |
| `--context-dir` | path | `.` | Working directory for file operations |
| `--json` | boolean | `false` | Output structured JSON results |

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
