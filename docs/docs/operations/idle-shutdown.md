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
- scheduled work due **within the idle window**: scheduled automations (including a claimed slot), deferred automation runs, delayed jobs and Ultrafix retries;
- GitHub polling intake, always (see below).

A signal that cannot be read keeps the instance awake, and so does the idle shutdown setting itself: if it cannot be read (for example a malformed stored value), the check does not stop the instance, the idle period starts over, and the status shows the last known setting with the blocker `could not read the idle shutdown setting`. The setting is read again right before stopping. Signals that cannot be read include the API and worker processes themselves: each one registers with the daemon and refreshes its entry every 15 seconds, and each API process publishes its sessions and requests. A registered process whose heartbeat or activity record is missing, older than 45 seconds or malformed blocks idle shutdown (`could not read api:<host>:<pid> …`) until it is confirmed stopped: it removed its entry on a clean shutdown, or the daemon sees on the same host and pid namespace that the pid is gone. `/health` and `/wake` requests are not activity, so platform health checks do not keep it awake; any other request does, including an uptime monitor polling `/api/status`.

Things that wait for a person (an automation run awaiting approval, a follow-up held for an operator) do not keep the instance awake: the person's next action reaches it through the Web UI, MCP or GitHub and wakes it.

:::note Polling intake never idles
In `polling` intake mode the poll timer keeps its own schedule, which a stop would miss, so polling intake always blocks idle shutdown, whatever `POLLING_INTERVAL_MS` is, and the instance never stops. Use the default `routing_websocket` (Connect) intake, or `direct_webhook` behind a proxy that starts the host on a request.
:::

## How it stops

Once the instance has been idle for the whole window, the daemon checks once more and then drains. Every step up to 5 can abort: the daemon then withdraws its request, the API admits requests again, Connect intake reconnects and the idle period starts over. Connect only replays on request, so before it stops Connect intake the daemon records a pending replay in the wake hint file (since `intakeStoppedAt`, with `wokeAt` set so a start is not counted as a wake, and keeping the cursor of a replay still owed). If that record cannot be written, intake stays connected and the drain aborts. An abort after intake was stopped reconnects and asks for the deliveries cached while it was disconnected; a crash mid-drain leaves the record, so the next start asks for them. The replay stays `pending` until Connect acknowledges it. If it is never acknowledged, the next drain carries its cursor and the next start asks again.

1. With Connect intake, sends the **wake hint** (`wake_hint` frame, see below) and waits up to 10 seconds for Connect to acknowledge it. Without an acknowledgement nothing is stopped.
2. Quiesces every producer: records the Connect replay owed from now on (see above), stops Connect intake (deliveries in flight finish and are acknowledged, then the socket closes with code 1000) and asks each API process to stop admitting requests. A request that arrives now gets `503` with `Retry-After: 5`; each API process waits for its requests in flight and confirms.
3. Checks again. Any blocker, or any request since the idle period began (including one turned away in step 2), aborts.
4. Writes the wake hint file, replacing the record from step 2. If it cannot be written (a full or read-only disk), the drain aborts.
5. Records the shutdown and stores a stop request in Redis.
6. Waits until every registered API and worker process has acknowledged the stop request. The request stays stored for the whole drain, so a process that was disconnected when it was announced still finds it when it reconnects. Each runs its normal graceful shutdown (close queues, Socket.IO, Redis) and exits with code 0. **The daemon does not exit until every process has acknowledged** or is confirmed stopped; while it waits it logs the processes it is waiting for.
7. Closes its own timers, Redis and SQLite connections, flushes logs and exits with code 0.

The stop request names the processes registered when it was issued. A process that starts afterwards (for example one restarted while a daemon that died mid-drain left its request stored) ignores it and keeps running.

In the single-process control plane (`propr all-in-one`, the `minimal` profile) the API, worker and inline indexing worker only acknowledge the stop request; the daemon then runs the process's normal shutdown, which closes every component in order and exits with code 0. An indexing worker run separately (`PROPR_INDEXING=separate`) stops on its own as above.

Because the exit code is 0, use a supervisor that restarts only on failure. A supervisor that always restarts (Docker Compose `restart: unless-stopped`, the default in `docker-compose.yml`) starts the process again right away, so idle shutdown saves nothing there.

## The wake hint

Before exiting, the daemon publishes the next due time of scheduled work:

- to **Connect**, as `{ "type": "wake_hint", "reason": "idle_shutdown", "nextDueAt": "<ISO-8601 or null>" }`. Connect must answer `{ "type": "wake_hint_ack" }` on the same connection. That answer is the commitment that Connect will wake the instance when `nextDueAt` is reached or a delivery arrives, and will replay cached deliveries when asked. A relay without this support (the current relay answers unknown frames with an `error` frame) never acknowledges, so **an instance on Connect intake does not stop until the relay supports idle wake** ([propr-routing#335](https://github.com/integry/propr-routing/issues/335)). The blocker reads `could not read Connect idle wake support`; it clears when the relay reconnects;
- to the **wake hint file**, for other supervisors (a systemd timer, a cron job, a wake-on-LAN script):

```json
{
  "version": 1,
  "shutdownAt": "2026-11-24T10:00:00.000Z",
  "reason": "idle for 900s",
  "idleForMs": 900000,
  "nextDueAt": "2026-11-24T14:00:00.000Z",
  "nextDue": [{ "kind": "automation", "dueAt": 1795010400000, "detail": "scheduled automation" }],
  "connectReplay": "pending",
  "intakeStoppedAt": "2026-11-24T09:59:40.000Z"
}
```

`nextDueAt` is `null` when nothing is scheduled; only a request or a delivery needs to wake the instance then. The next start adds `wokeAt` to mark the hint as consumed. `connectReplay` is present only after a stop with Connect intake: `pending` until Connect has acknowledged the replay request, then `accepted`. `intakeStoppedAt` is when the drain disconnected Connect intake. That is before `shutdownAt`, so deliveries Connect cached while the drain finished are included in the replay. When the instance stops again while an earlier replay is still `pending`, the new hint keeps it `pending` and records `replaySince`, the earlier stop's replay start, so the next start asks for everything since then.

## How it wakes

Anything that starts the host starts the control plane:

- **HTTP**: on Fly, a request to the Web UI, API, MCP or webhook URL starts a stopped Machine (`auto_start_machines = true`).
- **Connect wake ping**: Connect sends a request to `POST /wake` when a delivery arrives for a stopped instance. The endpoint is public, answers `202 { "status": "awake" }` at once and has no other effect.
- **Schedule**: Connect, or your own supervisor reading the wake hint file, starts the host when `nextDueAt` is reached.

Expect a cold start of about 5–10 seconds (host start plus Node boot) before work begins. That is fine for jobs that take minutes; a Web UI visit to a stopped instance takes that long to load.

### Recovery after a wake

On start the daemon reads the wake hint file and, when it records an idle stop:

- when `connectReplay` is `pending`, asks Connect for the deliveries cached while it was stopped (`{ "type": "replay", "reason": "idle_wake", "since": "<replaySince, else intakeStoppedAt, else shutdownAt>" }`) and waits for `{ "type": "replay_ack" }`. Only then does it set `connectReplay` to `accepted`. If Connect does not acknowledge (or Connect intake is not running), the obligation stays `pending` and the next start asks again. A connection that drops before the answer is retried on the next connection. Connect keeps deliveries for a disconnected instance: on the free tier the newest 25 for one hour, on paid plans 500 for 24 hours. Delivery IDs are de-duplicated, so a delivery that arrives twice is processed once;
- resumes scheduled work that became due while stopped: the schedule sweeps run at startup, and missed automation slots coalesce into **one** run for the latest slot;
- records the wake: its source (`http`, `connect_ping`, `schedule` or `unknown`) and the cold-start duration (process start to daemon ready).

Delayed jobs whose time passed run as soon as a worker is up; Ultrafix retries are picked up by the first resume sweep.

## Metrics and logs

| Where | What |
|---|---|
| Daemon log `Idle shutdown: stopping the control plane`, then `Idle shutdown: control plane stopped (exit 0)` | shutdown time, reason, idle duration, `nextDueAt`, wake hint file |
| Daemon log `Idle shutdown: waiting for processes to acknowledge the stop request` | processes that have not confirmed the stop yet (the daemon stays up) |
| Daemon log `Woke from idle shutdown` | wake source, cold-start duration, time stopped, scheduled work that became due while stopped |
| Daemon log `Idle shutdown aborted: …` | why the drain stopped: Connect did not acknowledge the wake hint, an API process did not confirm it quiesced, work arrived while draining, or the Connect replay record or the wake hint file could not be written |
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
- **It never stops on Connect intake, with `could not read Connect idle wake support`.** The relay did not acknowledge the wake hint. Stopping would leave nothing to wake the instance or replay its deliveries, so it stays up until the relay supports idle wake.
- **It never stops, with `could not read api:… (no heartbeat …)` or `API activity from … (no current record)`.** A registered process is not reporting. Find out whether it is hung, or restart it. A clean stop removes its entry.
- **The daemon stays up after `Idle shutdown: stopping the control plane`.** A process has not acknowledged the stop request; the log names it.
- **It does not wake for GitHub events.** Connect needs a wake target for the instance; without one, deliveries wait in the Connect cache (within its limits) until something else starts the instance.
