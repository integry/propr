# Agent Tank Usage Tracking

[Agent Tank](https://agenttank.io) is a separate, optional local tool that monitors the usage limits of your AI coding agent CLIs. ProPR integrates with it to show live provider capacity in the Web UI and to record per-call usage deltas alongside every LLM log entry.

Agent Tank is open source ([github.com/integry/agent-tank](https://github.com/integry/agent-tank)) and runs entirely on your own machine. It is **not** part of the ProPR stack — you install and run it yourself, then point ProPR at it. If you never enable it, ProPR works exactly the same; you just don't get the capacity bars.

This page covers what Agent Tank is, how to run it, how to connect ProPR to it (including the Docker networking that makes the connection work), and what you see once it is enabled.

## What Agent Tank Tracks

Agent Tank is for **subscription-based** coding agents whose CLI exposes session or rate-limit information — for example Claude Code Pro/Max, Antigravity CLI on a supported plan, and ChatGPT Codex. It reads the limits the CLI already reports.

It is **not** an API-spend tracker. For pay-as-you-go API key billing or per-request cost, use the provider's own billing dashboard, or ProPR's [LLM Log](./metrics.md), which records cost per call.

| Provider | How Agent Tank reads it | Metrics surfaced in ProPR |
|---|---|---|
| Claude (`claude`) | Runs the CLI's `/usage` command, or the Anthropic OAuth usage API in `--claude-api` mode | Current session, weekly (all models), and per-model weekly windows (Sonnet/Opus/Haiku) |
| Codex (`codex`) | JSON-RPC `account/rateLimits/read`, falling back to `/status` | 5-hour session limit and weekly limit |
| Antigravity (`agy`) | Runs the CLI's `/usage` command | Per-model quota availability and reset windows |

### How It Gets The Data

Agent Tank reads usage directly from the CLI tools you already have installed. It launches each CLI locally in a pseudo-terminal, runs the tool's built-in usage command, and parses the output into a unified dashboard and JSON API. Nothing leaves your machine. Specifically, it does **not**:

- scrape provider websites
- read browser cookies or depend on a logged-in browser session
- MITM or inspect network traffic
- send usage data to any remote service
- rely on log-file heuristics

This matters for ProPR: the usage numbers in the sidebar come from the same `/usage` output you would see if you ran the CLI yourself; no estimation is involved.

## Run Agent Tank

Install and start it on the host that runs your agent CLIs (usually the same host as the ProPR stack):

```bash
npm install -g agent-tank   # or run it directly with: npx agent-tank
agent-tank                  # auto-discovers installed CLIs, serves dashboard + API
```

By default it serves the dashboard and HTTP API at `http://127.0.0.1:3456` and, when Docker is available, also binds the Docker bridge gateway addresses so containers on the same host can reach it (see [Networking](#networking-propr-to-agent-tank) below). Building it compiles the native `node-pty` module, so the host needs Node.js 18+, Python 3.8+, and C/C++ build tools — see the [Agent Tank README](https://github.com/integry/agent-tank#installation-notes) if the build fails.

You need at least one supported CLI installed, authenticated, and on the `PATH`. For Claude, `/usage` requires Claude Code 2.0+.

Common flags:

```bash
agent-tank --claude --codex     # monitor only specific agents
agent-tank --port 8080          # custom port
agent-tank --background         # detach and keep running after the terminal closes
agent-tank --no-docker          # bind localhost only (skip Docker bridge binding)
agent-tank --claude-api         # use the Anthropic OAuth usage API for Claude (faster refresh)
```

To keep Agent Tank running alongside the ProPR stack, start it with `--background` (or run it under your own process manager). See the [Agent Tank README](https://github.com/integry/agent-tank) for the full option, environment-variable, and config-file reference.

## Connect ProPR To Agent Tank

There are three ways to turn the integration on. All three write the same backend setting (`enabled` plus a service `url`).

**Detection banner (easiest).** When ProPR detects a running Agent Tank instance at the Docker-internal default (`http://host.docker.internal:3456`) and the integration is off, the dashboard and LLM Log page show a dismissible banner offering to enable it in one click.

**Settings → LLM Usage Tracking.** Toggle *Enable Agent Tank Integration* and set the service URL. The section shows a live connectivity indicator (green "connected" / red with the error) so you can confirm ProPR can reach the service before relying on it.

**CLI (`propr tank`).** Toggle it on a running stack from the terminal:

```bash
propr tank                                    # show the current setting (on/off + URL)
propr tank on                                 # enable using the saved/default URL
propr tank on --url http://127.0.0.1:3456     # enable with a specific URL
propr tank off                                # disable
```

Because Agent Tank is an external service rather than a stack container, `propr tank` talks to the running ProPR backend — start the stack first (`propr start`).

### Networking: ProPR To Agent Tank

ProPR's shipped default URL is `http://0.0.0.0:3456`; the `propr tank` CLI client defaults to `http://127.0.0.1:3456`. The default only reaches Agent Tank when the ProPR backend runs directly on the host (a source checkout running `npm run daemon`/`npm run worker`). In the standard install the backend runs in Docker, where `0.0.0.0` and `localhost` resolve to the container itself — set the URL to `http://host.docker.internal:3456` there, which is exactly what the detection banner offers to do for you.

Change the URL in two situations:

- **Agent Tank runs on another host.** Point the setting at that host's address, and start Agent Tank with `--host 0.0.0.0` so it listens beyond localhost.
- **ProPR reaches Agent Tank across a Docker network.** From inside a container, `localhost` refers to the container itself. Use `http://host.docker.internal:3456` to reach an Agent Tank on the container's host — this is the URL the detection banner probes — or the service name when Agent Tank runs as a service on the same Docker network.

Agent Tank's own bind addresses support the container case: by default it listens on `127.0.0.1` plus, when Docker is available, the **private** Docker bridge gateway addresses, so same-host containers can reach it without it being exposed on a public interface. `--no-docker` restricts it to localhost, which Docker containers cannot reach.

Two environment variables tune the backend integration:

- `AGENT_TANK_URL` — fallback service URL used when no URL is saved in settings.
- `ANALYSIS_AGENT_TANK_TIMEOUT_MS` — per-request timeout for the pre/post-call usage probes (kept short so tracking never slows a task).

## What You See Once Enabled

- **Sidebar usage bars.** A per-provider Usage section shows each provider's windows (Claude session/weekly, Codex 5-hour/weekly, Antigravity per-model) as color-coded bars with reset countdowns, refreshed every 60 seconds, with a manual refresh button.
- **Per-call usage deltas.** Around each agent run ProPR snapshots usage before and after the call, computes the delta per metric, and stores it next to the [LLM Log](./metrics.md) entry. The task detail context strip shows a compact session/weekly delta chip for the run.
- **Capacity in your metrics.** Provider capacity pressure becomes a first-class signal alongside cost and cycle time — see [Metrics](./metrics.md).

{/* SCREENSHOT PLACEHOLDER (P3 — needs a running Agent Tank instance; interim: the site's ui-agent-tank.png): Capture the sidebar Usage section with Agent Tank enabled, showing provider rows (for example Claude and Codex) with colored usage bars and percentages, and one provider expanded to show its session and weekly metrics. Requires a running Agent Tank instance configured in Settings. */}

## Best-Effort By Design

The integration never blocks a task. If Agent Tank is disabled, unreachable, or slow:

- the pre/post-call usage probes are skipped or time out quietly,
- the LLM call runs and completes normally with no usage delta recorded, and
- the sidebar Usage section hides itself.

So a missing or stopped Agent Tank instance degrades to "no capacity bars," and the work itself completes normally.

## Troubleshooting

- **Sidebar is empty / "not connected" in Settings.** Confirm Agent Tank is running (`http://127.0.0.1:3456` in a browser) and that the URL ProPR uses is reachable *from inside the container* — typically `http://host.docker.internal:3456`, since `localhost` there resolves to the container itself. Avoid `--no-docker` when ProPR runs in Docker.
- **No agents found by Agent Tank.** At least one supported CLI (`claude`, `agy`, or `codex`) must be installed, authenticated, and on the `PATH` of the host running Agent Tank. Check with `claude --version` etc.
- **`Timeout waiting for usage data`.** Make sure the CLI works and is authenticated on its own (no pending trust/auth/update prompts). For Claude, try `--claude-api`.

For deeper operational context, see [Metrics](./metrics.md).
