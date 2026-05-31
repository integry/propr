# Mistral Vibe CLI documentation

Vibe is Mistral's agentic coding assistant that brings Devstral and Mistral Medium
models to your terminal. Use it to write, refactor, and review code with full
project context.

> **Note:** This documentation reflects the Vibe CLI at the time of integration.
> CLI flags and commands may change between releases. Verify against your installed
> version with `vibe --help`.

## Install

Install from npm (see [mistral-vibe on npmjs.com](https://www.npmjs.com/package/mistral-vibe)):

```bash
npm install -g mistral-vibe
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

Vibe stores credentials in `~/.vibe/credentials.json`.

### Set API Key

```bash
vibe auth login
```

You'll be prompted to enter your Mistral API key. Obtain one from
[console.mistral.ai](https://console.mistral.ai).

### Environment Variable

Alternatively, set the `MISTRAL_API_KEY` environment variable:

```bash
export MISTRAL_API_KEY=your-api-key-here
```

### Verify Authentication

```bash
vibe auth status
```

### Reset Credentials

To clear stored credentials and re-authenticate:

```bash
vibe auth logout
vibe auth login
```

Or remove the credentials file directly:

```bash
rm ~/.vibe/credentials.json
```

## Models

Vibe supports the following models:

| Model ID | Name | Context Window |
|----------|------|----------------|
| `mistral-medium-3.5` | Mistral Medium 3.5 | 256K |
| `devstral-2512` | Devstral 2 | 256K |
| `devstral-small-latest` | Devstral Small 2 | 256K |

### Select a model

```bash
vibe --model devstral-2512
```

Or set a default model in `~/.vibe/settings.json`:

```json
{
  "model": "devstral-2512"
}
```

## Configuration

Vibe configuration lives in `~/.vibe/`:

```
~/.vibe/
  credentials.json   # API key and auth state
  settings.json      # Model preferences and defaults
  history/           # Session history
```

### Settings reference

| Key | Default | Description |
|-----|---------|-------------|
| `model` | `mistral-medium-3.5` | Default model for new sessions |
| `contextWindow` | `256000` | Max tokens for context |
| `theme` | `auto` | Terminal color theme (auto, dark, light) |
| `telemetry` | `true` | Send anonymous usage data |

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
propr agent add my-vibe -t vibe -m devstral-small-latest
propr agent add vibe-prod -t vibe -m mistral-medium-3.5,devstral-2512 -d mistral-medium-3.5
```

### Docker Configuration

The default Docker image is `propr/agent-vibe:latest`. The container mounts
`~/.vibe` from the host for credential access.

### Environment Variables

When running inside a ProPR Docker container, ensure the following are available:

```bash
MISTRAL_API_KEY=your-api-key
```

Or mount the credentials directory:

```bash
docker run -v ~/.vibe:/home/node/.vibe propr/agent-vibe:latest
```
