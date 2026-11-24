---
sidebar_label: "Idle shutdown"
title: "Stop the control plane when idle and wake it on demand"
description: "Opt-in idle shutdown for small or metered hosts: what counts as idle, how the control plane drains and exits, the wake hint, Connect wake pings, recovery after a wake, and Fly and systemd setup."
---
# Idle shutdown

On a small or metered host the control plane can stop when there is nothing to do and start again when something needs it. A 1 GB Fly Machine that runs all month costs more than one that is awake about four hours a day, and the same applies to a home server or a laptop that you want to sleep.

**Idle shutdown is off by default.** Without it the control plane runs continuously, exactly as before.

## Turn it on

Either set it in `.env`:

```bash
PROPR_IDLE_SHUTDOWN=on
PROPR_IDLE_SHUTDOWN_AFTER=15m
```

or, with both variables unset, use **Settings → Maintenance → Idle shutdown** (instance administrators). A value set in the environment wins and the Web UI shows it read-only. The daemon re-reads the setting every 30 seconds, so a change from the Web UI needs no restart.

| Setting | Values | Default |
|---|---|---|
| `PROPR_IDLE_SHUTDOWN` | `on` or `off` | `off` |
| `PROPR_IDLE_SHUTDOWN_AFTER` | `1m` to `24h`, for example `90s`, `15m`, `1h30m` (a bare number is minutes) | `15m` |
| `PROPR_IDLE_WAKE_HINT_FILE` | path | `<DATA_DIR>/idle-wake-hint.json` |

An invalid `PROPR_IDLE_SHUTDOWN` value keeps idle shutdown off, and an invalid window falls back to the default; both are reported by `propr check` and in the Web UI.

`propr check` shows the effective setting and, when the stack is running, what currently keeps the instance awake, the last idle shutdown and the last wake. The same data is in the `idleShutdown` field of `GET /api/status` and at `GET /api/admin/idle-shutdown`.

## What counts as idle

The daemon checks every 30 seconds. The instance is idle only when all of these are quiet:

- jobs waiting, prioritized, paused or running in **any** BullMQ queue;
- agent runs (on any runtime) that are queued, running or acting;
- open Web UI sessions (Socket.IO) and in-flight MCP or other HTTP requests, as reported by every API process; the last request also restarts the idle period;
- follow-up handoffs still owned by a worker;
- Connect deliveries received but not yet acknowledged;
- running goals;
- Ultrafix loops waiting for CI or holding a claimed step;
- scheduled work due **within the idle window**: scheduled automations (including a claimed slot), deferred automation runs, delayed jobs, Ultrafix retries, and GitHub polling.

A signal that cannot be read keeps the instance awake. `/health` and `/wake` requests are not activity, so platform health checks do not keep it awake; any other request does, including an uptime monitor polling `/api/status`.

Things that wait for a person (an automation run awaiting approval, a follow-up held for an operator) do not keep the instance awake: the person's next action reaches it through the Web UI, MCP or GitHub and wakes it.

:::note Polling intake never idles
In `polling` intake mode the next poll is always less than one window away, so the instance never stops. Use the default `routing_websocket` (Connect) intake, or `direct_webhook` behind a proxy that starts the host on a request.
:::

## How it stops

Once the instance has been idle for the whole window, the daemon checks once more and then drains:

1. Sends the **wake hint** to Connect (`wake_hint` frame, see below) while the socket is still open.
2. Stops Connect intake: deliveries in flight finish and are acknowledged, then the socket closes normally (code 1000).
3. Checks again. If a delivery that arrived meanwhile queued work, it reconnects and stays up.
4. Writes the wake hint file and the shutdown record.
5. Tells the API and workers to shut down; each runs its normal graceful shutdown (stop accepting work, close queues, Socket.IO, Redis) and exits with code 0.
6. Closes its own timers, Redis and SQLite connections, flushes logs and exits with code 0.

Because the exit code is 0, use a supervisor that restarts only on failure. A supervisor that always restarts (Docker Compose `restart: unless-stopped`, the default in `docker-compose.yml`) starts the process again right away, so idle shutdown saves nothing there.

## The wake hint

Before exiting, the daemon publishes the next due time of scheduled work:

- to **Connect**, as `{ "type": "wake_hint", "reason": "idle_shutdown", "nextDueAt": "<ISO-8601 or null>" }`, so Connect can wake the instance when it is due ([propr-routing#335](https://github.com/integry/propr-routing/issues/335));
- to the **wake hint file**, for other supervisors (a systemd timer, a cron job, a wake-on-LAN script):

```json
{
  "version": 1,
  "shutdownAt": "2026-11-24T10:00:00.000Z",
  "reason": "idle for 900s",
  "idleForMs": 900000,
  "nextDueAt": "2026-11-24T14:00:00.000Z",
  "nextDue": [{ "kind": "automation", "dueAt": 1795010400000, "detail": "scheduled automation" }]
}
```

`nextDueAt` is `null` when nothing is scheduled; only a request or a delivery needs to wake the instance then. The next start adds `wokeAt` to mark the hint as consumed.

## How it wakes

Anything that starts the host starts the control plane:

- **HTTP**: on Fly, a request to the Web UI, API, MCP or webhook URL starts a stopped Machine (`auto_start_machines = true`).
- **Connect wake ping**: Connect sends a request to `POST /wake` when a delivery arrives for a stopped instance. The endpoint is public, answers `202 { "status": "awake" }` at once and has no other effect.
- **Schedule**: Connect, or your own supervisor reading the wake hint file, starts the host when `nextDueAt` is reached.

Expect a cold start of about 5–10 seconds (host start plus Node boot) before work begins. That is fine for jobs that take minutes; a Web UI visit to a stopped instance takes that long to load.

### Recovery after a wake

On start the daemon reads the wake hint file and, when it records an idle stop:

- reconnects to Connect and asks once for the deliveries cached while it was stopped (`{ "type": "replay", "reason": "idle_wake", "since": "<shutdownAt>" }`). Connect keeps deliveries for a disconnected instance: on the free tier the newest 25 for one hour, on paid plans 500 for 24 hours. The current relay replays cached deliveries through `POST /v1/replay` one at a time; automatic replay on reconnect is added by propr-routing#335. ProPR handles both: it asks for the replay, and delivery IDs are de-duplicated, so a delivery that arrives twice is processed once;
- resumes scheduled work that became due while stopped: the schedule sweeps run at startup, and missed automation slots coalesce into **one** run for the latest slot;
- records the wake: its source (`http`, `connect_ping`, `schedule` or `unknown`) and the cold-start duration (process start to daemon ready).

Delayed jobs whose time passed run as soon as a worker is up; Ultrafix retries are picked up by the first resume sweep.

## Metrics and logs

| Where | What |
|---|---|
| Daemon log `Idle shutdown: stopping the control plane (exit 0)` | shutdown time, reason, idle duration, `nextDueAt`, wake hint file |
| Daemon log `Woke from idle shutdown` | wake source, cold-start duration, time stopped, scheduled work that became due while stopped |
| Daemon log `Idle shutdown aborted: work arrived while draining` | what arrived during the drain |
| `GET /api/status` → `idleShutdown`, `GET /api/admin/idle-shutdown`, `propr check`, Settings | live blockers, `idleSince`, `shutdownAt`, `nextDueAt`, `lastShutdown`, `lastWake` |

## Fly

`propr deploy fly` generates these settings; for a hand-written `fly.toml`:

```toml
[env]
  PROPR_IDLE_SHUTDOWN = "on"
  PROPR_IDLE_SHUTDOWN_AFTER = "15m"

[http_service]
  internal_port = 4000
  # Fly proxy autostop is traffic-based and would stop the Machine during an
  # agent run that has no HTTP traffic. ProPR decides when to stop instead.
  auto_stop_machines = "off"
  # A request to the UI, API, MCP or webhook URL starts a stopped Machine.
  auto_start_machines = true
  min_machines_running = 0

[[restart]]
  # Exit code 0 is an idle stop: leave the Machine stopped.
  policy = "on-failure"
```

Point the Connect wake target at the Machine's public URL plus `/wake`.

## systemd

Run the control plane with `Restart=on-failure` so an idle exit (code 0) leaves the unit stopped, and start it again with socket activation, a timer reading `nextDueAt` from the wake hint file, or wake-on-LAN:

```ini
[Service]
Restart=on-failure
```

## Troubleshooting

- **It never stops.** Open Settings → Maintenance → Idle shutdown or run `propr check`; the blocker list names what keeps it awake. Common causes are polling intake, an open browser tab, an uptime monitor calling the API, or a stuck follow-up handoff (see [Maintenance](./maintenance.md)).
- **It restarts right after stopping.** The supervisor restarts on success. Use `on-failure`.
- **It does not wake for GitHub events.** Connect needs a wake target for the instance; without one, deliveries wait in the Connect cache (within its limits) until something else starts the instance.
