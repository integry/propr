---
sidebar_label: "Idle shutdown"
title: "Stop the control plane when idle and wake it on demand"
description: "Opt-in idle shutdown for small or metered hosts: what counts as idle, how the control plane drains and exits, the wake hint, Connect wake pings, recovery after a wake, and Fly and systemd setup."
---
# Idle shutdown

On a small or metered host the control plane can stop when there is nothing to do and start again when something needs it. A 1 GB Fly Machine that runs all month costs more than one that is awake about four hours a day, and the same applies to a home server or a laptop that you want to sleep.

**Idle shutdown is off by default.** Without it the control plane runs continuously, exactly as before.

**It needs the single-process control plane**: `propr all-in-one` (the `minimal` profile, or `node dist/src/allInOne.js` under your own supervisor) with the indexing worker inline (`PROPR_INDEXING=inline`, the default) or off. With separate processes (the default multi-container `full` profile, `PROPR_INDEXING=separate`, or more API or worker processes) the instance never stops, and the status names why (blocker `separate_processes`). When a stop is called off (see [How it stops](#how-it-stops)), the process exits with code 1 so that the supervisor starts it again, and only the components inside that process restart with it. A separate process that had already exited with code 0 would stay stopped.

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
- GitHub polling intake, always (see below);
- a daemon that runs as its own process, and any API, worker or indexing worker process outside the all-in-one process, always (see above).

A signal that cannot be read keeps the instance awake, and so does the idle shutdown setting itself: if it cannot be read (for example a malformed stored value), the check does not stop the instance, the idle period starts over, and the status shows the last known setting with the blocker `could not read the idle shutdown setting`. The setting is read again right before stopping. Signals that cannot be read include the API and worker processes themselves: each one registers with the daemon and refreshes its entry every 15 seconds, and each API process publishes its sessions and requests. A registered process whose heartbeat or activity record is missing, older than 45 seconds or malformed blocks idle shutdown (`could not read api:<host>:<pid> …`) until it is confirmed stopped: it removed its entry on a clean shutdown, or the daemon sees on the same host and pid namespace that the pid is gone. `/health` and `/wake` requests are not activity, so platform health checks do not keep it awake; any other request does, including an uptime monitor polling `/api/status`.

Things that wait for a person (an automation run awaiting approval, a follow-up held for an operator) do not keep the instance awake: the person's next action reaches it through the Web UI, MCP or GitHub and wakes it.

:::note Polling intake never idles
In `polling` intake mode the poll timer keeps its own schedule, which a stop would miss, so polling intake always blocks idle shutdown, whatever `POLLING_INTERVAL_MS` is, and the instance never stops. Use the default `routing_websocket` (Connect) intake, or `direct_webhook` behind a proxy that starts the host on a request.
:::

## How it stops

Once the instance has been idle for the whole window, the daemon checks once more and then drains. Every step until the stop request is stored in step 5 can abort: the daemon then withdraws its request, the API admits requests again, Connect intake reconnects, the daemon's own sweeps resume and the idle period starts over. Connect only replays on request, so before it stops Connect intake the daemon records a pending replay in the wake hint file (since `intakeStoppedAt`, with `wokeAt` set so a start is not counted as a wake, and keeping the cursor of a replay still owed). If that record cannot be written, intake stays connected and the drain aborts. An abort after intake was stopped reconnects and asks for the deliveries cached while it was disconnected; a crash mid-drain leaves the record, so the next start asks for them. The replay stays `pending` until Connect acknowledges it. If it is never acknowledged, the next drain carries its cursor and the next start asks again.

1. With Connect intake, sends the **wake hint** (`wake_hint` frame, see below) and waits up to 10 seconds for Connect to acknowledge it. Without an acknowledgement nothing is stopped.
2. Quiesces every producer: pauses the daemon's own sweeps that queue work (scheduled automations and agent runs, Ultrafix retries, auto-merge, merge-conflict and recovery sweeps; a sweep that is running finishes first, and one still running after 30 seconds aborts the drain), records the Connect replay owed from now on (see above), stops Connect intake (deliveries in flight finish and are acknowledged, then the socket closes with code 1000) and asks each API process to stop admitting requests. A request that arrives now gets `503` with `Retry-After: 5`; each API process waits for its requests in flight and confirms.
3. Checks again. Any blocker, or any request since the idle period began (including one turned away in step 2), aborts. So does scheduled work due so soon that the rest of the stop (see steps 6 and 7) might not finish before it.
4. Writes the wake hint file, replacing the record from step 2. If it cannot be written (a full or read-only disk), the drain aborts.
5. Stores a stop request in Redis for the API, worker and inline indexing worker, then records the shutdown. A process outside the all-in-one process that registered while draining aborts the drain here, before anything is asked to stop. So does API activity since step 3, read again right before the stop request is stored: a request the quiesced API turned away while the hint was written (that client retries in 5 seconds), or a Web UI session that opened. So does a wake arranged for scheduled work that is now too close for the rest of the stop.
6. Waits until each of them has acknowledged the stop request; they only acknowledge it and keep running until the shutdown in step 7. The request stays stored for the whole drain, so a component whose Redis connection was down when it was announced still finds it when it reconnects. **The process does not exit with code 0 until every component has acknowledged**; while it waits the daemon logs the ones it is waiting for. With nothing scheduled it waits up to 2 minutes, then calls the stop **off** (see below), so Redis going away cannot leave the instance quiesced and unable to serve; the last check for work in step 7 gets the same bound. With scheduled work, also the stop must be over before the wake arranged for it (the `nextDueAt` Connect accepted, or the one in the wake hint file): an acknowledgement not yet read 60 seconds before then (the time steps 6 and 7 may still take) calls the stop **off** (see below), even when it is read a moment later.
7. Checks once more for work: a job queued meanwhile (or work that cannot be read), or scheduled work due before the arranged wake, would be left behind, so the stop is called off. So is API activity since step 5 (a request turned away, or activity that cannot be read): the restart serves the client's retry. So is a check that is not over 30 seconds before the arranged wake. Otherwise the process runs its normal shutdown, the same one SIGTERM runs, which closes every component in order and exits with code 0. It is bounded: a component still starting (for example a worker waiting for an agent image that is not ready) gets 10 seconds, then the components that did start are closed without it. The whole shutdown gets 30 seconds, after which the process logs the step it was still closing and exits with code 0. With scheduled work it must also be over by the arranged wake: a shutdown still running then exits with **code 1** instead, because that wake reached a running process and the supervisor must start it for that work.

A stop that is called off does not end as an idle stop: the daemon withdraws the stop request, marks the wake hint so the next start is not counted as a wake (the Connect replay it owes stays `pending`), and the process shuts down with **code 1**. The on-failure supervisor that idle shutdown needs anyway starts the control plane again at once, every component with it; that start runs the scheduled work that is due and asks Connect for the deliveries it cached. The daemon logs `Idle shutdown called off: …` with the reason.

The stop request names the components registered when it was issued. One that starts afterwards (for example in a process restarted while a daemon that died mid-drain left its request stored) ignores it and keeps running.

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
- **Schedule**: Connect, or your own scheduler reading the wake hint file, starts the host when `nextDueAt` is reached. The file alone wakes nothing: without Connect intake the instance stops with scheduled work only when you set `PROPR_IDLE_SCHEDULED_WAKE=external` to say that such a scheduler runs. Otherwise any scheduled work keeps it running (blocker `scheduled_work`, `… nothing would wake the stopped instance for it`). `propr deploy fly` with direct webhook intake installs no such scheduler.

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
| Daemon log `Idle shutdown: stopping the control plane`, then `Idle shutdown: closing every component of this process (exit 0)` and `all-in-one: shutdown complete (exit 0)` | shutdown time, reason, idle duration, `nextDueAt`, wake hint file, and `exitBy`, the arranged wake the process must have exited by |
| Daemon log `Idle shutdown: waiting for processes to acknowledge the stop request` | processes that have not confirmed the stop yet, and `callOffAt` when scheduled work bounds the wait (the daemon stays up until every one confirms or the wait ends) |
| Daemon log `Idle shutdown called off: …`, exit code 1 | why the stop could not end as an idle stop: a component did not acknowledge it within 2 minutes or in time for the wake arranged for the scheduled work, the last check for work was not over in time, work arrived while the control plane was stopping, or the API saw activity while the control plane was stopping |
| Log `all-in-one: still shutting down when the wake arranged for the idle stop came …`, exit code 1 | the shutdown was still running when the arranged wake came, and the step it was closing |
| Daemon log `Woke from idle shutdown` | wake source, cold-start duration, time stopped, scheduled work that became due while stopped |
| Daemon log `Idle shutdown aborted: …` | why the drain stopped: Connect did not acknowledge the wake hint, a daemon sweep did not finish its run in progress, an API process did not confirm it quiesced, work arrived while draining, the API saw activity while draining (a request turned away after the check in step 3), scheduled work is due too soon, a process outside the all-in-one process registered while draining, or the Connect replay record or the wake hint file could not be written |
| `GET /api/status` → `idleShutdown`, `GET /api/admin/idle-shutdown`, `propr check`, Settings | live blockers, `idleSince`, `shutdownAt`, `nextDueAt`, `lastShutdown`, `lastWake` |

## Fly

The Machine runs the all-in-one control plane (the app image's `node dist/src/allInOne.js`). Use `propr deploy fly --idle-shutdown` (see [Deploy to Fly](./deploy-fly.md#idle-shutdown)): it generates the settings below and creates the stop token.

On a Fly Machine an exit alone does not stop the Machine. The `propr deploy fly` Machine also runs Redis (and optionally cloudflared and a Docker daemon) as containers of the same Machine, and they keep it `started` after the app exits. It is then unreachable and still billed, and the Fly proxy never starts it again, because it only starts a *stopped* Machine. So, on a Fly Machine (`FLY_MACHINE_ID` set), the idle stop asks the Machines API to stop the whole Machine before it exits 0. The request is `POST /v1/apps/$FLY_APP_NAME/machines/$FLY_MACHINE_ID/stop` to the Machine's private `_api.internal:4280` endpoint. It uses an app-scoped deploy token from the `PROPR_FLY_MACHINE_STOP_TOKEN` secret. A stop that the API refuses or does not answer within 10 seconds exits with **code 1** instead, so the restart policy starts the app again and the Machine stays reachable. A Machine without the token never stops idle: the blocker reads `could not read a way to stop this Fly Machine (PROPR_FLY_MACHINE_STOP_TOKEN not set …)`.

For a hand-written `fly.toml`, create the token with `fly tokens create deploy --app <app>` and set it with `fly secrets set PROPR_FLY_MACHINE_STOP_TOKEN=<token>`. In a multi-container Machine, also list the secret in the app container's `secrets`. Then add:

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
  # Idle stop: the app stops the whole Machine, then exits 0; leave it stopped.
  policy = "on-failure"
```

Point the Connect wake target at the Machine's public URL plus `/wake`.

## systemd

Run the all-in-one control plane (`node dist/src/allInOne.js`) as one unit with `Restart=on-failure`, so an idle exit (code 0) leaves the unit stopped, and start it again with socket activation, a timer reading `nextDueAt` from the wake hint file (set `PROPR_IDLE_SCHEDULED_WAKE=external` so the instance stops with scheduled work; without Connect intake it otherwise stays up), or wake-on-LAN. Separate units for the daemon, API and worker never stop idle (see the requirement at the top of this page).

```ini
[Service]
Restart=on-failure
```

## Troubleshooting

- **It never stops.** Open Settings → Maintenance → Idle shutdown or run `propr check`; the blocker list names what keeps it awake. Common causes are polling intake, an open browser tab, an uptime monitor calling the API, or a stuck follow-up handoff (see [Maintenance](./maintenance.md)).
- **It restarts right after stopping.** The supervisor restarts on success. Use `on-failure`.
- **A Fly Machine stays `started` after `Idle shutdown`, and `/health` does not answer.** The app exited but the Machine did not stop. ProPR stops the whole Machine through the Machines API first. Look for `all-in-one: the host did not accept the idle stop` in `fly logs`: the token in `PROPR_FLY_MACHINE_STOP_TOKEN` is missing, expired or for another app. Create a new one with `fly tokens create deploy --app <app>`, or redeploy with `propr deploy fly --idle-shutdown`.
- **It never stops on Connect intake, with `could not read Connect idle wake support`.** The relay did not acknowledge the wake hint. Stopping would leave nothing to wake the instance or replay its deliveries, so it stays up until the relay supports idle wake.
- **It never stops, with `the daemon runs as its own process` or `… runs outside the all-in-one process`.** Idle shutdown needs the single-process control plane with the indexing worker inline or off. Run `propr all-in-one` (the `minimal` profile) and set `PROPR_INDEXING=inline` or `off`.
- **It never stops, with `could not read api:… (no heartbeat …)` or `API activity from … (no current record)`.** A registered process is not reporting. Find out whether it is hung, or restart it. A clean stop removes its entry.
- **The daemon stays up after `Idle shutdown: stopping the control plane`.** A component has not acknowledged the stop request; the log names it. With scheduled work, the daemon calls the stop off before that work is due and the process exits with code 1 (`Idle shutdown called off: …`), and the supervisor starts it again.
- **It does not wake for GitHub events.** Connect needs a wake target for the instance; without one, deliveries wait in the Connect cache (within its limits) until something else starts the instance.
