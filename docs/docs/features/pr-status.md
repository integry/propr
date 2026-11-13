---
sidebar_position: 7
sidebar_label: "PR Status"
title: "See whether a ProPR pull request is working, needs you, or is ready"
description: "ProPR computes one status for each of its pull requests and keeps it live as the first line of the pull request body."
---

# PR Status

ProPR computes one status for every pull request it created: is it being worked on, does it need a person, or is it ready to merge? The same answer appears at the top of the pull request and in the MCP tools `get_pull_request`, `list_pull_requests` and `get_work_overview`, so you don't have to read the comment thread to find out.

## States

| State | When |
| --- | --- |
| `working` | A ProPR task for this pull request is queued or running (implementation, follow-up, review, conflict resolution), an Ultrafix loop is active (including while it waits for CI), checks on the current head are still pending, or GitHub is still working out whether the PR conflicts with its base ("Checking for conflicts"). |
| `needs_attention` | Nothing is running, and one of these is true: the last ProPR run on the PR failed; an Ultrafix loop ended without reaching its goal (cycles exhausted, failed, or stopped because CI did not settle); a check on the current head failed; the PR conflicts with its base, or the conflict resolution failed; the latest review score is below the instance Ultrafix rating goal; or the checks could not be read. |
| `ready` | Nothing is running, every check on the current head completed and passed, GitHub has confirmed that the PR does not conflict with its base, and the latest review score (if the PR has been reviewed) meets the instance Ultrafix rating goal. |
| `none` | The pull request is closed or merged, or ProPR did not create it. A pull request someone else opened stays `none` even after ProPR reviews it or runs a follow-up on it. |

A review score alone never makes a pull request `ready`. If Ultrafix reaches its goal on a commit whose checks are still running, the status stays `working`; if one of those checks then fails, it becomes `needs_attention`. Checks listed in the repository's [non-blocking checks](./pr-followup.md) are ignored, as they are everywhere else in ProPR. ProPR reads up to 300 check runs on the head; if a commit has more, it can't confirm that they all passed, so the status is `needs_attention` with "checks could not be read" rather than `ready`. The same goes for ProPR's own records: if the review score, the Ultrafix state or the queued work can't be read, no status is computed. The body keeps its previous line, and MCP returns `proprStatus: null`.

Besides the state, the status has a `detail` object for display: the current activity (implementing, follow-up in progress, review in progress, resolving conflicts, waiting for CI, checking for conflicts), the Ultrafix cycle and maximum while a loop runs, the latest review score and the rating goal, a checks summary (passed, failed and pending counts), the reason for `needs_attention`, and, for epic pull requests, how many of the epic's issues have merged.

## The status line in the pull request body

ProPR keeps a single line as the first thing in the body of every open pull request it created, in every repository:

> **ProPR** 🔨 Follow-up in progress · Ultrafix cycle 3 of 10 · last review 6/10 · checks: 31 passed, 4 pending · updated 09:41 UTC

> **ProPR** ✅ Ready · review 8/10 · checks: 35 passed · updated 10:02 UTC

> **ProPR** ⚠️ Needs you · Ultrafix stopped after 10 cycles at 6/10 · updated 10:15 UTC

How the line behaves:

- A new issue pull request opens with the line already in it. After that, ProPR updates it whenever the status or its detail changes: a follow-up or review starts or finishes, a review score is recorded, an Ultrafix cycle advances or waits for CI, a loop ends, a check run is created or completes, a commit status on the head changes, the PR is pushed to, or conflicts appear.
- The line sits between two hidden HTML comments (`<!-- propr:pr-status -->` and `<!-- /propr:pr-status -->`). ProPR only ever rewrites text between them. Everything else in the body stays exactly as it was, including your edits, the implementation summary, the visual preview section, continuation markers, the epic issue list and `Fixes #` lines. If you move the line further down the body, it is updated where you put it.
- Editing a pull request body adds nothing to the timeline, so the line can change often without filling the conversation. When the only change would be the "updated" time, nothing is sent to GitHub.
- ProPR ignores the `edited` webhooks its own status updates cause, so they never start more work.
- When the pull request is merged or closed, the line is removed.
- GitHub works out whether a pull request conflicts with its base in the background and sends no event when it is done. While it is working, the line reads "Checking for conflicts", and ProPR checks again after about 3, 10, 30 and 60 seconds. If GitHub still hasn't decided after that, the next change updates the line.
- A push to the base branch, for example when another pull request merges into it, can make a pull request conflict without any event on the pull request itself. ProPR then reads every open pull request it created into that branch again, so one that now conflicts doesn't keep reading Ready. Until GitHub reports having compared the pull request with the new tip of the base, ProPR checks again after about 3, 10, 30 and 60 seconds. One push reads up to 300 open pull requests into the branch. ProPR learns about pushes from webhooks, so with polling intake the line catches up on the next change instead.
- When the worker starts, ProPR brings the line up to date on every open pull request it created in the repositories it monitors, including pull requests opened before ProPR had the line. It reads up to 100 repositories and 300 open pull requests in each.
- The line never takes more than 512 characters. New pull request descriptions keep that much room free, so the line still fits when it grows longer than it was at creation. If a person fills the body so close to GitHub's 65,536-character limit that the line doesn't fit, ProPR writes a shorter line with just the state and the time. If even that doesn't fit, ProPR leaves the line out. Your text is never shortened to make room.
- If an update fails, the task, review or loop that caused it carries on as normal. The failure is logged, and the next change tries again. Updates started by a base push or by the worker starting have no next change to rely on, so ProPR retries them after about 3, 10, 30 and 60 seconds.

The line has no setting and can't be turned off. ProPR already owns that part of the body, and the edits leave no timeline entry, so there is nothing to opt out of. Pull requests ProPR did not create never get the line.

## The title setting

The repository setting **Show the PR state as a leading emoji in the pull request title** (`prTitleStatus`) controls the pull request title only. It does not affect the line in the body, which is always written. It is **on by default** and applies to every branch entry of the repository. The title emoji itself arrives in a later release; until then, the setting is stored but changes nothing.

| Where | How |
| --- | --- |
| Web UI | Repositories → repository → Automation → **Show the PR state as a leading emoji in the pull request title** |
| MCP | `update_repository_configuration` with `prTitleStatus: false` or `true`; `get_repository_configuration` reads it |
| CLI | `propr repo toggle owner/repo --pr-title-status off` (or `--pr-title-status <on\|off>` on `propr repo add`) |
| REST | `prTitleStatus` on the repository entries of `POST /api/config/repos` |

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

The status is computed the same way for the body line and the MCP tools.
