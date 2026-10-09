---
sidebar_position: 7
title: Task Assignment
---

# Task Assignment

Assignment answers "whose is this?" for ProPR work. A task is assigned through the GitHub issue or pull request behind it, so ProPR and GitHub always agree: assigning someone in ProPR assigns them on GitHub, and an assignment made on GitHub shows up in ProPR. **GitHub is the source of truth.** ProPR keeps only a cached copy so the Tasks screen can show and filter assignees without one GitHub call per row.

Two optional automations build on it, both **off by default**:

- The **assignment gate** limits who can start follow-up work on an assigned pull request. See [The assignment gate](#the-assignment-gate).
- **Automatic pull request assignment** assigns a ProPR pull request when work on it completes. See [Automatic Pull Request Assignment](./pr-followup.md#automatic-pull-request-assignment).

## What a task is assigned through

| Task | Assigned through |
|---|---|
| Implementation task before it has a pull request | Its source issue |
| Implementation task with a pull request | Its pull request |
| Pull request follow-up, `/review`, `/fix`, `/ultrafix` and other PR tasks | The pull request |
| Goal task, or any task with neither an issue nor a pull request | Nothing: it cannot be assigned |

GitHub treats pull requests as issues for assignment, so the same rules apply to both. GitHub allows at most 10 assignees, and only users with access to the repository can be assigned.

## The Tasks screen

The Tasks screen has an **Assignees** column showing the avatars of everyone assigned to each task. A grouped row shows everyone assigned across its runs.

The **Assignee** filter, next to the status and repository filters, narrows the list:

| Option | `?assignee=` value | Shows |
|---|---|---|
| All assignees | `all` (or omitted) | Every task |
| Assigned to me | `me` | Tasks assigned to you. Offered only when you are signed in |
| Unassigned | `unassigned` | Tasks with nobody assigned |
| One or more people, under **People** | Their logins, comma-separated, for example `octocat,hubot` | Tasks assigned to any of them |

**People** lists you and everyone assigned to a task you have seen in the list since opening the page. Tick as many as you need: each one adds to the filter rather than replacing it. To filter by someone who is not listed, type their GitHub login into **Find or add a GitHub login** and press Enter. A filter can name up to 20 people.

The filter is kept in the page URL, so a link such as `/tasks?assignee=me` opens your own queue. Logins may carry an optional leading `@`. A login that is spelled like a keyword (a user called `me`) is written as `@me`. `me` is resolved from your session on the server, so changing the URL cannot show another user's queue under "me". The filter runs before paging, so the page count and total always match what is shown.

The list shows the assignment ProPR last saw. ProPR refreshes it whenever it assigns someone, whenever a task's detail page is opened and whenever the assignment gate reads it. A change made only on GitHub appears on the list after one of those.

## Changing assignment

The task detail page reads the live assignment from GitHub and shows it in the header, next to the commit, or **Unassigned**. On a phone it is in the expanded summary.

To change it, select **Assign** (or the edit button next to the current assignees), tick the people who should be assigned and save. The picker lists the repository's assignable users, with the current assignees first, and has a filter for long lists. Saving assigns and unassigns on GitHub, then shows what GitHub actually applied. If GitHub refuses someone, usually because they cannot access the repository, the page names them and keeps the rest.

Anyone signed in to ProPR can see assignment. **Changing it requires write access to the repository on GitHub**, which is the same bar GitHub uses for assignment. Without it, the page keeps the read-only display, tells you why once, and stops offering the editor for that task. For a goal task or another task that cannot be assigned, the control is not shown at all.

Assignment can be read and changed through the API (`GET` and `PUT /api/task/{taskId}/assignees`) and filtered from the CLI with [`propr task list --assignee`](./propr-cli.md#tasks) and from MCP with `list_tasks` (`assignee`), which take the same values as the URL.

## Creator attribution

Goals, plans, automations and to-dos show who created them. The creator appears as a small avatar and `@login` on each row's metadata line on the Goals, Plans, Automations and To-Dos lists, and in the goal detail header.

Every item whose creator is known shows it, including on lists where every item has the same creator. These lists are scoped to the signed-in user, so that is the usual case. Items with no known creator, such as those created before attribution existed, show nothing.

The creator is who created the item in ProPR. It is not an assignment and does not affect who may act on the item.

## The assignment gate

On a team, anyone the [GitHub user whitelist](./pr-commands.md#who-can-trigger-commands) allows can start follow-up work on any pull request by commenting. With the assignment gate on, an assigned pull request takes follow-up instructions only from the people assigned to it.

- **An unassigned pull request is unaffected.** With nobody assigned, every allowed author can start follow-ups as before.
- The gate checks the pull request's live assignees on GitHub when a comment would start work: a natural follow-up comment that passes the label and keyword rules, or a slash command such as `/fix`, `/review` or `/ultrafix`. Ordinary discussion that would not start work is never checked.
- It runs after the whitelist, blacklist and bot checks. It only narrows who may act and never admits a comment those checks rejected.
- **ProPR's own system comments are never gated.** Automatic failed-CI follow-ups and the system `/ultrafix` comments that drive a loop are recognised as ProPR's and always proceed.
- **It fails closed.** If ProPR cannot read the assignees from GitHub, the comment is refused and logged, and no explanation is posted, because the author did nothing wrong.
- **A refused author receives one explanatory comment** on the pull request, mentioning them, that says only assignees can start follow-up work and asks them to get assigned and comment again. It is posted at most once per author per pull request in 7 days, so a long conversation does not fill up with notices. Their later comments are still refused, but silently.
- ProPR's own logins are never sent that comment. If its login is in the whitelist, an ordinary comment it posts can reach the gate and be refused, which is logged without a notice addressed to itself.
- A refused comment is not queued, claimed or billed, and it is dropped for good: assigning the author or switching the gate off later does not start work from it. With webhook delivery the comment is never seen again, and with polling intake ProPR remembers refused comments for 30 days so later polls skip them. Once the author is assigned, their next comment works normally.

Refusals are logged at `info` as `Follow-up comment refused by the assignment gate` with the repository, pull request, comment, author and reason:

| Reason | Meaning |
|---|---|
| `author_not_assigned` | The pull request has assignees and the author is not one of them. The author is told once. |
| `assignment_unavailable` | The assignees could not be read from GitHub, so the gate stayed closed. No comment is posted. |

## Configuration

Every option below is **off by default**.

| Setting | Where | Values |
|---|---|---|
| Assignment gate (instance) | Settings → Automation → General configuration → **Follow-ups Only From Assigned Users**, MCP `update_execution_settings` (`followup_requires_assignment`), `propr setting update followup_requires_assignment <true\|false>` | on / off (default off) |
| Automatic pull request assignment (repository) | Repositories → repository → Automation → **Assign the pull request when ProPR finishes**, MCP `update_repository_configuration` (`autoAssignPullRequests`), `propr repo add\|toggle owner/repo --auto-assign <on\|off>` | on / off (default off) |
| Default assignee (repository) | The **Assignee** field under that option, MCP `update_repository_configuration` (`autoAssignDefaultAssignee`), `propr repo add\|toggle owner/repo --auto-assign-to <login\|none>` | A GitHub login, or empty for the source issue author (default empty) |
| Review request (repository) | **Also request a review from the assignee** under that option, MCP `update_repository_configuration` (`autoAssignRequestReview`), `propr repo add\|toggle owner/repo --auto-assign-review <on\|off>` | on / off (default off) |

The gate is instance-wide and applies to every repository. The three repository options are repository-wide: every branch entry of a monitored repository shares them, and a client that does not send a field never changes it. `none` (or `null` through MCP, or an empty **Assignee** field) clears the default assignee so the source issue author is assigned again. The default assignee and the review request have no effect while automatic assignment is off. `propr repo list` shows the repository options as `Off` or, for example, `On (@octocat, review)`.

What the repository options do, and every reason ProPR may decline to assign, is described in [Automatic Pull Request Assignment](./pr-followup.md#automatic-pull-request-assignment). Every setting's location is also listed in [Where Each Setting Lives](../operations/settings-locations.md).
