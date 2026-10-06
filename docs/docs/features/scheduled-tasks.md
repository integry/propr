# Scheduled Tasks

A schedule runs the same instruction against a repository on a timetable: a nightly dependency patrol, a weekly flaky-test hunt, a docs drift check. Each run is an ordinary task. ProPR opens a GitHub issue the same way **New Task** and MCP `create_task` do, and the task then follows the normal issue-to-PR flow.

Scheduled runs are **unattended work**, so an instance-wide admission policy decides when they may start (see [Unattended-work admission](#unattended-work-admission)).

## Create a schedule

Open **Settings → Automation → Scheduled tasks** and fill in:

| Field | Meaning |
|---|---|
| **Name** | Shown as "Scheduled: &lt;name&gt;" on every task the schedule creates. Defaults to the first line of the instruction. |
| **Repository** | An enabled repository you can write to. |
| **Cron expression** | Five fields: minute, hour, day of month, month, day of week. `@hourly`, `@daily`, `@weekly`, `@monthly` and `@yearly` also work. |
| **Time zone** | An IANA zone such as `Europe/Riga` or `UTC`. The cron expression is read in this zone. |
| **Instruction** | What the agent should do, as in **New Task**. |
| **Agent / model** | Optional. Defaults to the instance's default agent and model. |
| **Ultrafix**, **Auto-merge**, **Max cost (USD)** | The same options a task submission accepts. |

You become the schedule's **owner**. The issue is opened on your behalf and you receive the schedule's notifications. The owner or an instance administrator can disable, run, edit or delete a schedule.

A schedule can fire at most once every 5 minutes. A cron expression that would fire more often, never fires, or uses an unknown time zone is rejected when you save it. The agent and model are also checked when you save, so a bad selection fails then rather than at 3 a.m.

Examples:

| Cron | Runs |
|---|---|
| `0 2 * * *` | Every night at 02:00 |
| `0 9 * * MON-FRI` | Weekdays at 09:00 |
| `0 3 * * 1` | Mondays at 03:00 |
| `30 4 1 * *` | The 1st of each month at 04:30 |

When both the day-of-month and day-of-week fields are restricted, a day matches either one, as in standard cron.

### Daylight saving time

Runs are computed in the schedule's time zone:

- A time that is skipped when clocks go forward runs once, shifted later by the size of the gap. A daily `30 2 * * *` in `America/New_York` runs at 03:30 on the spring-forward day.
- A time that occurs twice when clocks go back runs once, at its first occurrence.

## When runs happen

The daemon checks for due schedules every 30 seconds (`SCHEDULE_TICK_INTERVAL_MS`; `0` disables scheduling). One daemon at a time holds a Redis lease for the check. Each slot is also claimed in the database under the idempotency key `schedule:<id>:<slot>`, so a slot cannot be dispatched twice even if two checks race.

- **No replay of missed slots.** If the daemon was down when a slot fell due, that slot is skipped once the daemon is back (anything due more than five minutes ago) and the schedule moves on to its next future slot.
- **No first run in the past.** A new schedule, a re-enabled schedule, or a schedule whose timing you change starts from the next slot after now.

## Unattended-work admission

Two instance settings control when unattended work may start. They are under **Settings → Automation → Scheduled tasks** and in the [settings catalog](../operations/settings-locations.md):

| Setting | Default | Meaning |
|---|---|---|
| `unattended_max_concurrent` | `1` | How many scheduled runs may be in progress at once. `0` stops unattended work. |
| `unattended_window` | empty (any time) | A local time window such as `02:00-07:00@Europe/Riga`. A window may cross midnight (`22:00-06:00@UTC`). The end time is exclusive. |

A scheduled run starts only when fewer than `unattended_max_concurrent` scheduled runs are in progress **and**, if a window is set, the current time in the window's zone is inside it. Otherwise the slot is **skipped**. The skip is recorded in the schedule's run history with the reason, and the owner gets an Inbox notification. A skipped slot is not retried later.

**A malformed window blocks unattended work** rather than allowing it. ProPR validates the window when you save it. If a stored value still becomes invalid, for example after an out-of-band edit, Settings shows a warning and every scheduled slot is skipped until you fix it.

Manual runs are exempt, including a schedule's **Run now**, New Task, CLI, MCP and GitHub triggers.

```sh
propr setting update unattended_max_concurrent 2
propr setting update unattended_window 02:00-07:00@Europe/Riga
```

MCP `update_execution_settings` accepts the same two fields.

## Provenance

Tasks created by a schedule carry its `schedule_id` and show **Scheduled: &lt;name&gt;**:

- in the task list and the task details,
- in Inbox notifications about the task,
- in the GitHub issue body, above the "Submitted by" line.

## Failures and automatic pause

A run counts as failed when its task fails, when the task cannot be started (for example because the repository was disabled or the agent was removed), or when no task has started 24 hours after dispatch. A cancelled task counts as neither a success nor a failure. A success resets the count.

After **3 consecutive failed runs**, the schedule pauses itself and notifies its owner. **Run now** re-enables a paused schedule, clears its failure count and starts a run immediately. The schedule then continues from its next future slot.

## Command line and MCP

```sh
# Every night at 02:00 Riga time
propr schedule add --repo acme/api --cron "0 2 * * *" --timezone Europe/Riga \
  --name "Dependency patrol" "Upgrade outdated dependencies and fix any breakage"

propr schedule list
propr schedule run-now <schedule-id>
propr schedule remove <schedule-id>
```

`--timezone` defaults to your local zone.

See the [ProPR CLI reference](./propr-cli.md#scheduled-tasks) for every option.

MCP clients can use `create_schedule`, `list_schedules`, `run_schedule_now` and `delete_schedule`. The REST API is `GET/POST /api/schedules`, `GET/PATCH/DELETE /api/schedules/:id` and `POST /api/schedules/:id/run-now`.
