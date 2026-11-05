# ProPR Vibe Integration Notes

Vibe is Mistral's agentic coding assistant that brings Mistral models to your
terminal. Use it to write, refactor, and review code with full
project context.

> **Scope:** This file documents ProPR-specific integration behavior — how
> ProPR installs, configures, and invokes the Vibe CLI. It is **not**
> authoritative upstream documentation. Settings and config paths below were
> observed against `mistral-vibe==2.25.8` (the version pinned in
> `Dockerfile.agent`) and may differ in other releases. Always verify against
> your installed version with `vibe --help`.

> **Verified behavior:** Installation, setup, model selection, and
> programmatic output have been checked against the pinned version.
> Config file layout (`~/.vibe/`) and settings keys are inferred from observed
> CLI behavior and may differ across versions. ProPR's entrypoint adds its own
> flags (e.g., `--prompt-file`) — see
> [vibe-cli.md](../vibe-cli.md#propr-entrypoint-extensions) for details.

## Install

Install from PyPI with uv:

```bash
uv tool install mistral-vibe==2.25.8
```

## Get started

- **[Quickstart](#quickstart):** Your first session with Vibe.
- **[Authentication](#authentication):** Setup instructions for API key
  configuration.
- **[Models](#models):** Available models and selection.
- **[Configuration](#configuration):** Customization and settings.

## Quickstart

After installing, run the interactive setup wizard:

```bash
vibe --setup
```

Or jump straight into a session:

```bash
vibe
```

Vibe will prompt for a Mistral API key on first run if one isn't already
configured.

## Authentication

### Set API Key

```bash
vibe --setup
```

You'll be prompted to enter your Mistral API key. Obtain one from
[console.mistral.ai](https://console.mistral.ai).

### Environment Variable

Alternatively, set the `MISTRAL_API_KEY` environment variable:

```bash
export MISTRAL_API_KEY=your-api-key-here
```

## Models

Vibe 2.25.8 ships one hosted model and a local llama.cpp option. ProPR also supplies presets for Mistral-hosted GLM 5.3 and GLM 5.2.
Mistral Medium remains the default.

| Model ID | Name | Context Window |
|----------|------|----------------|
| `mistral-medium-3.5` | Mistral Medium 3.5 | 256K |
| `zai-glm-5-3` | GLM 5.3 | 1M |
| `zai-glm-5-2` | GLM 5.2 | 1M |
| `local` | Devstral (local) | Configured locally |

### Select a model

```bash
vibe
```

Use `/model` interactively, or set the active model in `~/.vibe/config.toml`:

```toml
active_model = "mistral-medium-3.5"
```

## Configuration

> **Note:** The directory layout and settings keys below are inferred from
> observed CLI behavior and may change between Vibe releases. Refer to the
> official Mistral Vibe documentation for the current contract.

Vibe configuration lives in `~/.vibe/`:

```
~/.vibe/
  config.toml        # Model preferences and defaults
  .env               # API key fallback when a system keyring is unavailable
  sessions/          # Session history
  logs/              # Runtime logs
```

### Settings reference (inferred)

| Key | Default | Description |
|-----|---------|-------------|
| `active_model` | `mistral-medium-3.5` | Model alias for new sessions |
| `default_agent` | `accept-edits` | Agent/tool approval policy |

## ProPR Integration

To add a Vibe agent to ProPR:

### Via the UI

1. Go to **AI Agents** page
2. Click **Add Agent**
3. Select **vibe** as the agent type
4. Choose models (defaults to all Vibe models)
5. Save

### Via the CLI

```bash
propr agent add my-vibe -t vibe -m mistral-medium-3.5 -d mistral-medium-3.5
```

### Docker Configuration

The default Docker image is `propr/agent:latest`. The container mounts
`~/.vibe` from the host for credential access.

### Environment Variables

When running inside a ProPR Docker container, ensure the following are available:

```bash
MISTRAL_API_KEY=your-api-key
```

Or mount the credentials directory:

```bash
docker run -e PROPR_AGENT_TYPE=vibe -v ~/.vibe:/home/node/.vibe propr/agent:latest
```


## Research and runtime verification (2026-09-29)

- [PyPI](https://pypi.org/project/mistral-vibe/2.25.8/) lists 2.25.8 as the current release; all ProPR Vibe build and runtime defaults pin it.
- The released wheel's `vibe/core/config/vibe_schema.py` bundles `mistral-medium-3.5` (API name `mistral-vibe-cli-latest`) and `local`. It does not bundle GLM presets.
- Mistral documents [GLM 5.3](https://docs.mistral.ai/models/zai-glm-5-3) and [GLM 5.2](https://docs.mistral.ai/models/zai-glm-5-2), both with 1M context. They are Mistral-hosted third-party models in public preview.
- ProPR supplies the selected GLM preset through Vibe's nested `VIBE_MODELS__<model-id>` environment setting and selects it with `VIBE_ACTIVE_MODEL`. Vibe merges it with the existing configuration. Execution and read-only analysis use the same mechanism; host configuration is not modified.
- The released CLI's `--help` does not expose the `--model` option mentioned in the online configuration guide. Use ProPR selection or configured model aliases, rather than relying on that flag.
- `test/vibeAgent.test.ts` includes an optional contract check using the installed package, enabled by `PROPR_VIBE_PYTHON`. It verifies actual configuration resolution without inference calls. Live API inference requires an authorized Mistral account and is not covered by that offline check.
