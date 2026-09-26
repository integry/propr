# Agent Tank Usage Tracking

[Agent Tank](https://agenttank.io) monitors the usage limits of your AI coding agent CLIs. ProPR integrates with it to show live provider capacity in the Web UI and to record per-call usage deltas alongside every LLM log entry.

Agent Tank is open source ([github.com/integry/agent-tank](https://github.com/integry/agent-tank)) and runs entirely on your own machine — nothing is sent anywhere. The integration is **off by default**; if you never turn it on, ProPR works exactly the same, you just don't get the capacity bars.

This page covers what Agent Tank tracks, the three integration modes, and what you see once it is enabled.

## What Agent Tank Tracks

Agent Tank is for **subscription-based** coding agents whose CLI exposes session or rate-limit information — for example Claude Code Pro/Max, Antigravity CLI on a supported plan, and ChatGPT Codex. It reads the limits the CLI already reports.

It is **not** an API-spend tracker. For pay-as-you-go API key billing or per-request cost, use the provider's own billing dashboard, or ProPR's [LLM Log](./metrics.md), which records cost per call.

| Provider | How Agent Tank reads it | Metrics surfaced in ProPR |
|---|---|---|
| Claude (`claude`) | Runs the CLI's `/usage` command, or the Anthropic OAuth usage API in `--claude-api` mode | Current session, weekly (all models), and per-model weekly windows (Sonnet/Opus/Haiku) |
| Codex (`codex`) | JSON-RPC `account/rateLimits/read`, falling back to `/status` | 5-hour session limit and weekly limit |
| Antigravity (`agy`) | Runs the CLI's `/usage` command | Per-model quota availability and reset windows |

OpenCode and Vibe are not tracked: neither CLI exposes a subscription usage endpoint for Agent Tank to read.

### How It Gets The Data

Agent Tank reads usage directly from the CLI tools you already have installed. It launches each CLI in a pseudo-terminal, runs the tool's built-in usage command, and parses the output. Nothing leaves your machine. Specifically, it does **not**:

- scrape provider websites
- read browser cookies or depend on a logged-in browser session
- MITM or inspect network traffic
- send usage data to any remote service
- rely on log-file heuristics

This matters for ProPR: the usage numbers in the sidebar come from the same `/usage` output you would see if you ran the CLI yourself; no estimation is involved.

## The Three Integration Modes

The integration is a single setting with three states. Choose it in **Settings → LLM Usage Tracking**, with `propr tank`, or via the `AGENT_TANK_MODE` environment variable.

| Mode | What it does | When to use it |
|---|---|---|
| `disabled` | **Default.** Nothing is contacted or started. No usage tracking at all. | You don't want capacity bars. |
| `bundled` | ProPR runs the Agent Tank CLI **inside the `propr/agent` image** on demand, against your configured agent credentials. | Almost everyone. No host install, no daemon, no networking. |
| `external` | ProPR talks HTTP to an Agent Tank daemon **you** run yourself. | You already run Agent Tank, want its web dashboard, or want to track credentials ProPR doesn't manage. |

Upgrades are transparent: an installation that had the integration enabled before bundled mode existed loads as `external` with exactly the URL it had, and a disabled one stays disabled.

### Bundled Mode (Recommended)

The `propr/agent` image already contains `claude`, `codex`, and `agy`, and ProPR already knows where each configured agent's credentials live. Bundled mode uses both: for each refresh it starts a short-lived container from the same agent image your tasks run in, mounts every enabled agent's credential directory **read-only** at the path that agent's runtime uses, and runs `agent-tank --once --json`.

That means:

- **Nothing to install.** No `npm install -g agent-tank`, no daemon to keep alive, no second copy of the agent CLIs.
- **No networking.** There is no HTTP endpoint and therefore no `localhost` vs `host.docker.internal` mistake to make.
- **Same credentials as your runs.** Bundled Agent Tank inspects exactly the directories the agents themselves use, so the numbers describe the accounts doing the work. The mounts are read-only, so a usage probe can never modify or corrupt them.
- **A cached snapshot, not a live daemon.** Starting a container and driving `/usage` through a pseudo-terminal takes time, so ProPR caches the result and refreshes out of band. The per-LLM-call probes only ever read that cache; the sidebar's refresh button forces a fresh run.

Enable it with:

```bash
propr tank bundled
```

Bundled mode reports the providers it can see. An agent with no credentials mounted, or a provider Agent Tank does not support, is simply left out.

### External Mode

Use this when you run Agent Tank yourself. Install and start it on the host that runs your agent CLIs:

```bash
npm install -g agent-tank   # or run it directly with: npx agent-tank
agent-tank                  # auto-discovers installed CLIs, serves dashboard + API
```

By default it serves the dashboard and HTTP API at `http://127.0.0.1:3456` and, when Docker is available, also binds the Docker bridge gateway addresses so containers on the same host can reach it (see [Networking](#networking-propr-to-an-external-agent-tank) below). Building it compiles the native `node-pty` module, so the host needs Node.js 18+, Python 3.8+, and C/C++ build tools — see the [Agent Tank README](https://github.com/integry/agent-tank#installation-notes) if the build fails.

You need at least one supported CLI installed, authenticated, and on the `PATH` **of the host running Agent Tank**. In a normal ProPR install those CLIs live inside `propr/agent` rather than on the host, which is the friction bundled mode removes.

Common flags:

```bash
agent-tank --claude --codex     # monitor only specific agents
agent-tank --port 8080          # custom port
agent-tank --background         # detach and keep running after the terminal closes
agent-tank --no-docker          # bind localhost only (skip Docker bridge binding)
agent-tank --claude-api         # use the Anthropic OAuth usage API for Claude (faster refresh)
```

Then point ProPR at it:

```bash
propr tank external --url http://host.docker.internal:3456
```

#### Networking: ProPR To An External Agent Tank

ProPR's shipped default URL is `http://0.0.0.0:3456`; the `propr tank` CLI client defaults to `http://127.0.0.1:3456`. The default only reaches Agent Tank when the ProPR backend runs directly on the host (a source checkout running `npm run daemon`/`npm run worker`). In the standard install the backend runs in Docker, where `0.0.0.0` and `localhost` resolve to the container itself — set the URL to `http://host.docker.internal:3456` there, which is exactly what the detection banner offers to do for you.

Change the URL in two situations:

- **Agent Tank runs on another host.** Point the setting at that host's address, and start Agent Tank with `--host 0.0.0.0` so it listens beyond localhost.
- **ProPR reaches Agent Tank across a Docker network.** From inside a container, `localhost` refers to the container itself. Use `http://host.docker.internal:3456` to reach an Agent Tank on the container's host — this is the URL the detection banner probes — or the service name when Agent Tank runs as a service on the same Docker network.

Agent Tank's own bind addresses support the container case: by default it listens on `127.0.0.1` plus, when Docker is available, the **private** Docker bridge gateway addresses, so same-host containers can reach it without it being exposed on a public interface. `--no-docker` restricts it to localhost, which Docker containers cannot reach.

This whole section is why bundled mode exists — none of it applies there.

## Choosing The Mode

There are three ways to set it. All write the same backend setting.

**Detection banner (easiest).** While tracking is off, the dashboard and LLM Log page show a dismissible banner offering to turn it on in one click. If a daemon is already answering at `http://host.docker.internal:3456` the banner offers `external` pointed at it; otherwise it offers `bundled`.

**Settings → LLM Usage Tracking.** Pick one of the three modes. The **Daemon URL** field only appears for `external`, because an external URL means nothing in the other two. The section shows a live status indicator so you can confirm the mode works before relying on it.

**CLI (`propr tank`).** Configure it on a running stack from the terminal:

```bash
propr tank                                          # show the current mode (plus URL, for external)
propr tank bundled                                  # run Agent Tank inside the agent image
propr tank external --url http://127.0.0.1:3456     # use your own daemon
propr tank off                                      # disable
```

`propr tank on` still works as a deprecated alias for `propr tank external` — that is what it has always meant — and prints a note saying so.

Because this is a backend setting rather than a stack container, `propr tank` talks to the running ProPR backend — start the stack first (`propr start`).

## Environment Variables

- `AGENT_TANK_MODE` — `disabled`, `bundled`, or `external`. Only used when **no** setting has been saved yet, so headless deployments can configure the stack entirely from `.env`. A saved setting always wins.
- `AGENT_TANK_URL` — fallback service URL when none is saved. Applies to `external` mode only.
- `AGENT_TANK_BUNDLED_TIMEOUT_MS` — how long a bundled refresh container may run before it is abandoned (default `120000`).
- `AGENT_TANK_BUNDLED_CACHE_TTL_MS` — how long a bundled snapshot stays fresh before the next refresh starts a container (default `60000`).
- `ANALYSIS_AGENT_TANK_TIMEOUT_MS` — per-request timeout for the pre/post-call usage probes (kept short so tracking never slows a task).

## What You See Once Enabled

- **Sidebar usage bars.** A per-provider Usage section shows each provider's windows (Claude session/weekly, Codex 5-hour/weekly, Antigravity per-model) as color-coded bars with reset countdowns, refreshed every 60 seconds, with a manual refresh button.
- **Per-call usage deltas.** Around each agent run ProPR snapshots usage before and after the call, computes the delta per metric, and stores it next to the [LLM Log](./metrics.md) entry. The task detail context strip shows a compact session/weekly delta chip for the run.
- **Capacity in your metrics.** Provider capacity pressure becomes a first-class signal alongside cost and cycle time — see [Metrics](./metrics.md).

In bundled mode the deltas come from cached snapshots, so a call that finishes between two refreshes records no delta rather than a guessed one.

{/* SCREENSHOT PLACEHOLDER (P3 — needs a running Agent Tank instance; interim: the site's ui-agent-tank.png): Capture the sidebar Usage section with Agent Tank enabled, showing provider rows (for example Claude and Codex) with colored usage bars and percentages, and one provider expanded to show its session and weekly metrics. Requires a running Agent Tank instance configured in Settings. */}

## Best-Effort By Design

The integration never blocks a task. If Agent Tank is disabled, unreachable, slow, or — in bundled mode — the agent image is missing or the container fails:

- the pre/post-call usage probes are skipped or time out quietly,
- the LLM call runs and completes normally with no usage delta recorded, and
- the sidebar Usage section hides itself.

So a missing Agent Tank degrades to "no capacity bars," and the work itself completes normally.

## Troubleshooting

- **Sidebar is empty in bundled mode.** Confirm the agent image is built and at least one enabled agent is authenticated. `docker run --rm propr/agent:latest agent-tank --version` proves the image ships the CLI; a task that runs successfully proves the credentials are mounted.
- **Sidebar is empty / "unreachable" in external mode.** Confirm Agent Tank is running (`http://127.0.0.1:3456` in a browser) and that the URL ProPR uses is reachable *from inside the container* — typically `http://host.docker.internal:3456`, since `localhost` there resolves to the container itself. Avoid `--no-docker` when ProPR runs in Docker. Bundled mode sidesteps all of this.
- **No agents found by Agent Tank.** At least one supported CLI (`claude`, `agy`, or `codex`) must be installed and authenticated. In bundled mode that means an enabled ProPR agent of that type with a readable credential directory; in external mode, a CLI on the `PATH` of the host running Agent Tank.
- **`Timeout waiting for usage data`.** Make sure the CLI works and is authenticated on its own (no pending trust/auth/update prompts). For Claude, try `--claude-api` in external mode.

For deeper operational context, see [Metrics](./metrics.md).
