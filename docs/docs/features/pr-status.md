---
sidebar_position: 7
sidebar_label: "PR Status"
title: "See whether a ProPR pull request is working, needs you, or is ready"
description: "ProPR computes one status for each of its pull requests, keeps it live as the first line of the pull request body, and shows the state as one emoji at the start of the title."
---

# PR Status

ProPR computes one status for every pull request it created: is it being worked on, does it need a person, or is it ready to merge? The same answer appears at the top of the pull request, as one emoji at the start of its title, and in the MCP tools `get_pull_request`, `list_pull_requests` and `get_work_overview`, so you don't have to read the comment thread to find out.

## States

| State | When |
| --- | --- |
| `working` | A ProPR task for this pull request is queued or running (implementation, follow-up, review, conflict resolution), an Ultrafix loop is active (including while it waits for CI), checks on the current head are still pending and no problem listed under `needs_attention` is known yet, or GitHub is still working out whether the PR conflicts with its base ("Checking for conflicts"). |
| `needs_attention` | No ProPR task, Ultrafix loop or queued job is left, and one of these is true: the last ProPR run on the PR failed; an Ultrafix loop ended without reaching its goal (cycles exhausted, failed, or stopped because CI did not settle); a check on the current head failed; the PR conflicts with its base, or the conflict resolution failed; the latest review score is below the instance Ultrafix rating goal; or the checks could not be read and none of those read is still pending. Checks that are still running don't hide any of these problems. |
| `ready` | Nothing is running, every check on the current head completed and passed, GitHub has confirmed that the PR does not conflict with its base, and the latest review score (if the PR has been reviewed) meets the instance Ultrafix rating goal. |
| `none` | The pull request is closed or merged, or ProPR did not create it. A pull request someone else opened stays `none` even after ProPR reviews it or runs a follow-up on it. |

A review score alone never makes a pull request `ready`. If Ultrafix reaches its goal on a commit whose checks are still running, the status stays `working`; as soon as one of those checks fails, it becomes `needs_attention`, even while the others are still running. Checks listed in the repository's [non-blocking checks](./pr-followup.md) are ignored, as they are everywhere else in ProPR. ProPR reads up to 300 check runs and up to 300 commit statuses on the head; if a commit has more, the ones it read keep their counts, the rest are never counted as passed, and since it can't confirm that they all passed the status is `needs_attention` with "checks could not be read" rather than `ready`. The same goes for ProPR's own records: if the review score, the Ultrafix state or the queued work can't be read, no status is computed. The body keeps its previous line, and MCP returns `proprStatus: null`.

Besides the state, the status has a `detail` object for display: the current activity (implementing, follow-up in progress, review in progress, resolving conflicts, waiting for CI, checking for conflicts), the Ultrafix cycle and maximum while a loop runs, the latest review score and the rating goal, a checks summary (passed, failed and pending counts), the reason for `needs_attention`, and, for epic pull requests, how many of the epic's issues have merged and which sub-PR or issue the line names (see [Epic pull requests](#epic-pull-requests)).

## The status line in the pull request body

ProPR keeps a single line as the first thing in the body of every open pull request it created, in every repository:

> **ProPR** 🔨 Follow-up in progress · Ultrafix cycle 3 of 10 · last review 6/10 · checks: 31 passed, 4 pending · updated 09:41 UTC

> **ProPR** ✅ Ready · review 8/10 · checks: 35 passed · updated 10:02 UTC

> **ProPR** ⚠️ Needs you · Ultrafix stopped after 10 cycles at 6/10 · updated 10:15 UTC

How the line behaves:

- A new issue pull request opens with the line already in it. After that, ProPR updates it whenever the status or its detail changes: a follow-up or review starts or finishes, a review score is recorded, an Ultrafix cycle advances or waits for CI, a loop ends, a check run is created or completes, a commit status on the head changes, the PR is pushed to, or conflicts appear.
- The line sits between two hidden HTML comments (`<!-- propr:pr-status -->` and `<!-- /propr:pr-status -->`). ProPR only ever rewrites text between them. Everything else in the body stays exactly as it was, including your edits, the implementation summary, the visual preview section, continuation markers, the epic issue list and `Fixes #` lines. If you move the line further down the body, it is updated where you put it.
- Editing a pull request body adds nothing to the timeline, so the line can change often without filling the conversation. When the only change would be the "updated" time, nothing is sent to GitHub.
- ProPR ignores the `edited` webhooks its own status updates cause, so they never start more work. It recognises them by the line it recorded writing, not by the shape of the edit: if a person deletes the line or types a status of their own, ProPR writes the current status back, and that edit starts no other work either.
- When the pull request is merged or closed, the line is removed.
- GitHub works out whether a pull request conflicts with its base in the background and sends no event when it is done. While it is working, the line reads "Checking for conflicts", and ProPR checks again after about 3, 10, 30 and 60 seconds. If GitHub still hasn't decided after that, the next change updates the line.
- A push to the base branch, for example when another pull request merges into it, can make a pull request conflict without any event on the pull request itself. ProPR then reads every open pull request it created into that branch again, so one that now conflicts doesn't keep reading Ready. Until GitHub reports having compared the pull request with the new tip of the base, ProPR checks again after about 3, 10, 30 and 60 seconds. ProPR reads the open pull requests into the branch in batches of up to 300. Each batch starts where the previous one stopped, once the previous batch's updates have started, until every open pull request into the branch has been read. If the branch is pushed again while ProPR is still reading, it reads the rest for the new tip, then reads the pull requests it had already covered again. ProPR learns about pushes from webhooks, so with polling intake the line catches up on the next change instead.
- When the worker starts, ProPR brings the line up to date on every open pull request it created in the repositories it monitors, including pull requests opened before ProPR had the line. It works in batches of up to 100 repositories and 300 open pull requests per repository. Each batch starts where the previous one stopped, so every monitored repository and every open pull request is reached.
- The line never takes more than 512 characters. New pull request descriptions keep that much room free, so the line still fits when it grows longer than it was at creation. If a person fills the body so close to GitHub's 65,536-character limit that the line doesn't fit, ProPR writes a shorter line with just the state and the time. If even that doesn't fit, ProPR leaves the line out. Your text is never shortened to make room.
- If an update fails, the task, review or loop that caused it carries on as normal. The failure is logged, and the next change tries again. Updates started by a base push or by the worker starting have no next change to rely on, so ProPR retries them after about 3, 10, 30 and 60 seconds; that includes an update that could only write "checks could not be read" because GitHub rejected a check read. A commit with more checks than ProPR reads is not retried: reading again would not lift that limit.

The line has no setting and can't be turned off. ProPR already owns that part of the body, and the edits leave no timeline entry, so there is nothing to opt out of. Pull requests ProPR did not create never get the line.

## The status in the pull request title

GitHub's pull request list shows only titles, labels and a check icon, so ProPR also puts the state at the very start of the title of each open pull request it created:

| State | Title |
| --- | --- |
| `working` | `🔨 [3475 by Claude Opus 5.5] Let an automation run when a plan issue is blocked` |
| `needs_attention` | `⚠️⑥ [3475 by Claude Opus 5.5] …`, with the latest review score (① to ⑩) when there is one |
| `ready` | `✅⑧ [3510 by Claude Opus 5.5] Apply library extensions automatically…`, with the latest review score when there is one |

The slot is one emoji, the score beside ⚠️ and ✅, then a single space and the title exactly as it was. A `none` pull request has no slot.

Every title change adds a "changed the title" entry to the timeline, so the title changes far less often than the body line:

- A new pull request is created with `🔨` already in its title, so creation costs no rename.
- The title changes only when the state changes, or when the score beside ⚠️ or ✅ changes. Activity inside `working` (a review starting, the next Ultrafix cycle, waiting for CI) never renames the pull request; that detail is in the body line.
- ProPR writes ⚠️ or ✅ only once the state has held for about 30 seconds and nothing for the pull request is queued or about to start. The short gap between an Ultrafix review and its fix, or between a failed check and its CI follow-up, costs no rename. Going back to `🔨` (for example when you post a follow-up on a `✅⑧` pull request) is immediate.
- No change is sent when the title is already right. When ProPR changes both the body line and the title, it does so in one update.
- ProPR only ever replaces the slot it recognises at the start of the title. Your edits to the rest of the title are kept. If you remove the slot, it stays off until the state changes. ProPR also leaves the title alone when adding the slot would take it past GitHub's 256-character limit.
- When the pull request is merged or closed, ProPR removes the slot: one final rename, so closed pull request lists and release notes stay clean.
- ProPR ignores the `edited` webhooks its own renames cause, so they start no work and no further update.

The emoji never reaches anything derived from the title. ProPR's merges (the MCP `merge_pull_request` tool, ProPR's own merge after checks pass, and native auto-merge) pass an explicit commit title without the slot: the title plus ` (#N)` for squash merges. Task titles such as `Fix PR #N: …`, notifications, `[Epic]` detection and the web UI read the title without the slot.

### The title setting

The repository setting **Show the PR state as a leading emoji in the pull request title** (`prTitleStatus`) controls the title slot only. It doesn't affect the line in the body, which is always written. It is **on by default** and applies to every branch entry of the repository. With it off, titles are created and left exactly as they are. Turning it off removes the slot from open pull requests on their next change.

| Where | How |
| --- | --- |
| Web UI | Repositories → repository → Automation → **Show the PR state as a leading emoji in the pull request title** |
| MCP | `update_repository_configuration` with `prTitleStatus: false` or `true`; `get_repository_configuration` reads it |
| CLI | `propr repo toggle owner/repo --pr-title-status off` (or `--pr-title-status <on\|off>` on `propr repo add`) |
| REST | `prTitleStatus` on the repository entries of `POST /api/config/repos` |

## Epic pull requests

An epic pull request collects the sub-PRs of a plan: its own branch only receives merges. Its status follows the epic instead of a single PR's work, and shows how many of the plan's issues are merged into the epic branch. The counts are the ones the epic progress comment uses: every open or merged sub-PR into the epic branch, plus planned issues without a sub-PR yet; issues closed without a merge are left out.

| State | When |
| --- | --- |
| `working` | Not every issue is merged, and a sub-PR or an issue of the epic is being worked on (a sub-PR whose own status is `working`, or an issue that started and has no sub-PR yet), ProPR is working on the epic PR itself, or the plan's queue is about to start its next issue. |
| `needs_attention` | Not every issue is merged and nothing is running: a sub-PR needs you, a sub-PR is `ready` and waits to be merged into the epic branch, the plan's queue is paused, the epic PR conflicts with its base, or nothing is left to start. Also when every issue is merged but a check on the epic PR's head failed or it conflicts with its base. |
| `ready` | Every issue is merged into the epic branch, every check on the epic PR's current head completed and passed, and it does not conflict with its base. |

A sub-PR that is `ready` but not merged yet makes the epic `needs_attention`, so the list of pull requests shows that a merge is waiting on you. An epic shows no review score.

The body line leads with the progress, then says what is running or what waits on you:

> **ProPR** 🔨 3 of 5 issues merged · #3475 in progress (Ultrafix cycle 4 of 10, last review 6/10) · updated 09:41 UTC

> **ProPR** ⚠️ 3 of 5 issues merged · #3523 (issue #3475) waits to be merged into the epic branch · updated 09:41 UTC

> **ProPR** ✅ 5 of 5 issues merged · checks: 12 passed · updated 10:02 UTC

With `prTitleStatus` on, the title slot is followed by `merged/total`, for example `🔨 3/5 [Epic] Scheduler primitives` or `✅ 5/5 [Epic] Scheduler primitives`. A new epic PR is created with `🔨 0/N` (or the count its first merge reached) and with the line already in its body. The title is renamed when a sub-PR merges into the epic branch (the count changes) and when the state changes, never for activity inside a state, and the 30-second hold before ⚠️ or ✅ applies as for any pull request: while the queue is about to start the next issue, the epic stays `🔨` and is not renamed. With the setting off, epic titles stay exactly as they are; the line in the body is still written. `[Epic]` detection reads the title without the slot and count.

When ProPR rewrites the epic body (its issue list and `Fixes #` lines), it keeps the status line. The epic PR's status is updated when a sub-PR into the epic branch opens, changes status, merges or closes, and when an issue of the plan starts or finishes.

### What the epic progress comment says now

Independently of `prTitleStatus`, the epic progress comment ("N out of M PRs merged", the progress bar and "Merged child PRs") also says what is happening, below "Merged child PRs":

```
Merged child PRs: #3490, #3504, #3507, #3515, #3518

In progress: #3523 (issue #3475, Let an automation run when a plan issue is blocked) - review 6/10, Ultrafix cycle 5 of 10

Up next: none
```

- **In progress** lists every open sub-PR into the epic branch as `#PR (issue #N, title)`, followed by its status in a few words (for example "review 6/10, Ultrafix cycle 3 of 10" or "ready to merge"), and every plan issue that started but has no sub-PR yet as `#issue (title)`. It is left out when nothing is in progress.
- **Up next** lists the plan issues that have not started, in queue order. Once the last issue is in progress it reads "none"; when nothing is in progress or up next, both lines are left out.

Titles come from the epic PR's issue list. The comment is updated in the same update as the epic's status line: when a sub-PR into the epic branch opens, changes status or merges, and when an issue starts. Nothing is sent to GitHub when the rendered comment is unchanged. The comment itself is still created by the first merge into the epic branch, as before.

## Read the status through MCP

`get_pull_request` returns `proprStatus` for the pull request. `list_pull_requests` adds `proprStatus` to each result, and `get_work_overview` adds it to each item's `pullRequest`. Closed and merged pull requests read `{ "state": "none" }` without a GitHub lookup. To keep GitHub traffic bounded, each list call computes the status for at most 20 open pull requests: the rest read `null`, and `statusTruncated` is `true`. `proprStatus` is also `null` when the status could not be computed. The pull request itself is still returned.

```json
{
  "state": "needs_attention",
  "detail": {
    "activity": null,
    "ultrafix": null,
    "ultrafixStopped": null,
    "reviewScore": 8,
    "ratingGoal": 7,
    "checks": { "passed": 34, "failed": 1, "pending": 0 },
    "reason": "check_failed",
    "failedChecks": ["unit tests"],
    "epic": null
  }
}
```

The status is computed the same way for the body line and the MCP tools. For an epic pull request, `detail.epic` holds `merged`, `total` and `focus` (the sub-PR or issue the line names, with the sub-PR's own status), and the epic reasons are `epic_child_needs_attention`, `epic_child_ready`, `epic_queue_paused` and `epic_idle`. Reading an epic's status also reads the status of up to 10 of its open sub-PRs.
