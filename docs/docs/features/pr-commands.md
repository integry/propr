---
sidebar_position: 13
title: PR Comment Commands
---

# PR Comment Commands

Most PR refinement needs only a plain comment. If you want ProPR to make a normal change, write a regular GitHub PR comment with the instruction and any screenshots or context — ProPR picks it up and starts follow-up work. See [PR Follow-up](./pr-followup.md) for how that loop works.

Slash commands are for specific actions: AI review, applying AI review feedback, model routing, branch updates, and automated correction loops. This page is the full reference for every command.

## Works On Any Pull Request

You can run `/review`, `/fix`, and the others on any eligible pull request — including ones opened by a teammate, another agent, or yourself outside ProPR — as long as you are an allowed author. A slash command from an allowed author is processed directly and does not require the PR to carry a processing label; the exception is `/merge`, which only runs on PRs that carry one.

To **take over an existing PR** for ongoing work (so that natural follow-up comments are picked up alongside commands), add a configured processing label such as `AI` or `propr` to the PR. See [Use ProPR On Any Pull Request](./pr-followup.md#use-propr-on-any-pull-request).

## Quick Reference

| Command | Use it when | Changes code? | Details |
|---|---|---|---|
| `/review` | You want AI review comments on the PR | No | [`/review`](#review) |
| `/fix` | You want to apply a `/review`'s findings, or named suggestions | Yes | [`/fix`](#fix) |
| `/merge` | You want the base branch merged into the PR branch | Maybe, if conflicts need resolution | [`/merge`](#merge) |
| `/switch <model-id>` | You want future PR work to use a different model | No, unless you include follow-up instructions | [`/switch`](#switch) |
| `/use <model-id>` | You want one immediate follow-up run with a temporary model | Yes | [`/use`](#use) |
| `/ultrafix` | You want an automated review-fix loop | Yes | [`/ultrafix`](#ultrafix) |

## Syntax Rules

- The slash command must be on the first line of the PR comment. A comment with leading blank lines or text before the command is treated as a normal follow-up comment.
- Arguments go on the same line as the command (for example `/review llm-claude-opus5` or `/ultrafix goal=8 max=10`).
- Lines below the command become extra instructions for the run.
- Both top-level PR comments and line-level review comments are processed; line-level comments carry their file, line, and diff context to the agent.

## Model IDs

Commands that take a model accept the model IDs configured in AI Agents. The `llm-` prefix is optional in command arguments — `/switch claude-opus5` and `/switch llm-claude-opus5` are equivalent. `/switch` and `/use` ignore a model that is neither in the catalog nor configured on an enabled agent; `/review` skips models it cannot resolve and fails only when none of the requested models resolve. The built-in catalog is listed in [Agents and Models](./agents-and-models.md).

## Who Can Trigger Commands

ProPR filters PR comments by author before processing anything (commands and natural follow-ups alike):

- Bot accounts (usernames containing `[bot]` or with user type `Bot`) and ProPR's own bot account are ignored by default.
- The GitHub User Whitelist (Settings, or `GITHUB_USER_WHITELIST` as comma-separated logins) is exclusive: when it has any entries, **only** listed users and bots can trigger processing, and the bot and blacklist checks are skipped for them. Matching ignores a `[bot]` suffix, so `name` also admits `name[bot]`. To exempt a bot, add it to the whitelist in Settings or with the MCP `update_trigger_access_configuration` tool's `addBots` operation — and add every human who should keep access, because adding one bot to an empty whitelist blocks everyone else. Environment-managed entries are read-only through MCP.
- Users listed in `GITHUB_USER_BLACKLIST` are ignored when no whitelist is set.
- MCP administrators with `instance.manage_settings` can inspect all three lists with `get_trigger_access_configuration`. User and bot allowlist changes use `update_trigger_access_configuration`; the environment-only blocklist is reported but cannot be edited by the tool.
- Comments containing a configured follow-up ignore keyword are skipped.

Slash commands from an allowed author are processed directly. Natural follow-up comments are additionally gated: the PR must carry one of the configured processing labels (for example `AI` or `propr`), or the comment must contain a trigger keyword from `PR_FOLLOWUP_TRIGGER_KEYWORDS` (for example `!propr`). When `PR_FOLLOWUP_TRIGGER_KEYWORDS` is empty or unset, every comment from an allowed author triggers a follow-up, labeled PR or not.

## Review And Fix

Use `/review` and `/fix` when you want AI review feedback first, then an implementation pass that applies the review comments you kept.

The commands split the work by feedback source. User-authored comments are processed directly when posted as natural follow-up instructions (see [PR Follow-up](./pr-followup.md)). `/fix` deals exclusively with AI review comments generated by `/review`.

### `/review`

Post:

```text
/review
```

Or request specific models (one review comment per model):

```text
/review llm-claude-opus5 llm-codex-gpt55
```

Without arguments, `/review` uses the PR review model configured in Settings.

You can add focus instructions on the lines below the command; they are included in the review prompt as additional review instructions:

```text
/review
Focus on security and error handling.
```

Reviews are read-only — the agent is instructed to leave files untouched.

### Review Context Budget

**Settings → AI & Models → Review context budget** sets how much of each reviewer's *safe input capacity* a review may use, from 10% to 100% in 10% steps (`pr_review_context_budget_percent`; default 100%). The safe capacity is the routed runtime's context window minus a reserve for the review response (32K tokens) and a runtime reserve (system prompt, tool schemas, compaction headroom), so 100% never uses the reserved space. Each reviewer of a multi-model `/review`, and each model named in a `/review` command, gets its own budget; a smaller reviewer never narrows a larger one.

| Runtime | Context window used | Source |
|---|---|---|
| Claude Code | 1M for models the runtime marks native-1M (Opus 4.7+, Opus 5.x, Sonnet 5.x, Fable, Mythos); 200K otherwise, including Opus/Sonnet 4.6 without the `[1m]` suffix or with `CLAUDE_CODE_DISABLE_1M_CONTEXT` | Model catalog bundled with Claude Code 2.1.284 |
| Codex | 272K for every listed model, including the GPT-6 family | `context_window` in the models catalog bundled with Codex CLI 0.160.0; larger windows are opt-in through `model_context_window`, which ProPR does not set |
| Other runtimes | ProPR model catalog window, with a runtime reserve of 10% of the window (minimum 16K) | Catalog only; the runtime limit is not verified |
| Unknown model | 200K (Codex: its historical 272K) | Conservative fallback |

Prompt size is estimated from token counts, not bytes. Text is tokenized with `o200k_base`; Codex routes use that count plus a 10% margin, Claude applies a calibrated 1.84× ratio, and other runtimes 1.85×. Non-ASCII characters always count at least two tokens each. The fully assembled request, including the runtime's analysis suffix, is measured before it is sent. If it still exceeds the ceiling the review is trimmed again, and if the mandatory instructions alone do not fit the review fails with an explicit error. An oversized prompt is never sent.

When a review does not fit, sections are trimmed in this order: related unchanged context, comment history, full changed-file contents, then whole diff files (lockfiles, generated and binary changes first). The original objective, review request and instructions are only trimmed once everything else is gone.

**Precedence with older settings:**

- A missing percentage or the old `pr_review_max_context_tokens: 0` means automatic (100%).
- A positive `pr_review_max_context_tokens` is kept as a *legacy absolute cap*. Each review uses the lower of the cap and the percentage allowance, so neither a model change nor the percentage can raise it. Settings shows the cap with a **Remove legacy cap** action; the slider never clears it silently.
- `PR_REVIEW_DIFF_MAX_CHARS` is a memory/I/O guard for the fetched diff (default 4,000,000 characters, clamped to 100,000–16,000,000). It applies before any per-reviewer budget and is logged separately from context limits.

A review whose diff is incomplete is marked partial (`partial="true"`), and the comment separates the reasons. **No patch content from GitHub** means GitHub did not return a patch for the file, and a larger budget cannot recover it. The other reasons are **did not fit the review context budget** and **exceeded the diff size safety guard**. Worker logs record the routed model and runtime, capacity source, window, reserves, percentage, effective ceiling, estimated tokens, per-section token sizes and trim reasons. Prompt text is never logged.

The same setting is available as `propr setting update pr_review_context_budget_percent 60` and through the MCP `update_execution_settings` tool.

### Review Output Format

Every `/review` comment follows a fixed structure:

```markdown
## Overall Evaluation
<summary of the change>

## Merge blockers
### F1: 🔴 <problem this PR introduced>
- **Required behavior:** <what the code has to do>
- **Evidence:** <changed file and line that breaks it>
- **Minimum fix:** <smallest correction that resolves it>

## Suggestions
### S1: 🟢 <optional improvement>

<why it is worth doing>

## Score
Score: N/10
```

The four sections always appear in this order. **Merge blockers** holds the problems the PR introduced that have to be resolved before merging, each published as a numbered `F#` record carrying those three fields; **Suggestions** holds the non-blocking follow-ups, each published as a numbered `S#` record with its explanation. A review that found nothing prints `No merge blockers.` or `No suggestions.` in place of the records.

Both identifier sequences are PR-wide and never reused, so `F20` or `S5` names one record for the life of the pull request — that is what makes them selectable by [`/fix F20 S3 S5`](#fix). The comment ends with a `Score: N/10` line, which [`/ultrafix`](#ultrafix) reads to decide whether its goal is reached. ProPR also stores every parsed score, with the reviewer, the implementing model, the reviewed head and (for Ultrafix) the cycle number, so the Analytics page can compare review quality per model; see [Review scores](../operations/metrics.md#review-scores).

### Review Markers

Each AI review comment carries a hidden HTML marker identifying it as machine-generated review output:

```html
<!-- propr:ai-review model="<model-id>" -->
```

Failed reviews carry the error variant (`error="true"`) and are never picked up by `/fix`.

Marker matching skips the author check: any comment carrying a valid `propr:ai-review` marker is treated as review feedback by the next `/fix`. Control who can run commands (and who can comment) through the trigger permissions above, and review pending AI review comments before running `/fix`.

### Edit Before Fixing

AI review comments are intentionally human-editable before `/fix` runs:

- Delete suggestions you do not want applied.
- Rewrite vague suggestions into clearer instructions.
- Leave only the comments you want implemented.

Edited comments keep their marker, so `/fix` applies your edited version. That gives you full control over what the next implementation pass applies.

### `/fix`

Post:

```text
/fix
```

To address every pending merge blocker **and** every optional suggestion across
all current review comments, post:

```text
/fix all
```

`all` is case-insensitive and must stand alone on the command line, apart from
trailing commas or whitespace. Use `;` for inline instructions, as in
`/fix all; keep the API stable`, or put instructions on following lines.
`/fix all the failing tests` keeps the bare `/fix` meaning: blockers only, with
`all the failing tests` passed as instructions. `/fix all F3` or `/fix all S3`
is rejected and nothing is applied: use `/fix all` alone, or name the records
explicitly. `/fix all` with context on following lines still selects every
pending finding and suggestion.
Like bare `/fix`, `/fix all` is not subject to the explicit identifier count cap.

Or name exactly what to address. A review publishes merge-blocking findings as
`F1`, `F2`, … and non-blocking follow-ups as `S1`, `S2`, …; list them in any
order, mixed freely:

```text
/fix F20 S3 S5
Keep the public helper signature unchanged.
```

Every valid review comment with records includes a fenced, copyable `/fix` line
listing exactly its published findings first and suggestions second, for example
`/fix F20 S3 S5`. Copy it into a new PR comment, delete any IDs you do not want,
and post it to use explicit selection. The line uses the permanent PR-wide IDs.

- Both sequences continue across every review on the pull request and are never
  reused: a second review that finds two suggestions after `S5` publishes them as
  `S6` and `S7`, exactly as findings continue from `F5` to `F6`. An `S#` you read
  once identifies that one suggestion for the life of the pull request, so
  `/fix S6` cannot select a different record later. The two sequences advance
  independently — a review with no merge blocker still continues the `S#` count.
- Identifiers are read from the command line only, and are case-insensitive
  (`/fix f20 s3` is `/fix F20 S3`).
- Identifiers end at the first word on that line that is not one (commas may
  separate identifiers, and a `;` ends the list explicitly). That word, the rest
  of the line, and every following line are passed to the agent as
  instructions. The identifiers themselves are not.
- An identifier no current review offers fails the whole command closed, even
  when other identifiers in the same request are available: nothing is applied,
  and ProPR names the identifiers it could not resolve on the pull request. This
  is the same rule the `fix_review_findings` MCP tool applies before it posts.
- A malformed or unsupported identifier such as `S0`, `F007`, `F1x` or the range
  `F1-F2` fails the whole command closed too: nothing is applied, and ProPR names
  the invalid identifiers so you can correct them. A partly misunderstood request
  is never acted on in part, and never silently widened to every pending blocker.
- Selecting a suggestion changes nothing about merge blockers: blockers stay
  required, suggestions are implemented only because you asked for them, and an
  unselected blocker is never treated as in scope.
- `/ultrafix` continues to select findings only; it never takes on a suggestion
  on its own.

With no identifiers, `/fix` keeps its original meaning — every pending merge
blocker, no suggestions — and any text you add becomes extra instructions:

```text
/fix
Only address the critical findings.
```

`/fix` applies a `/review`'s pending feedback: it collects the unprocessed AI review comments on the PR (identified by their `propr:ai-review` marker), narrows them to what you selected, applies them in one implementation pass, and then marks exactly those records processed. Unselected findings stay pending for a later `/fix`, and a suggestion is only ever included when you name it or request `/fix all`. Comments that reported an error (`error="true"`) are excluded. User-authored comments are ignored by `/fix`; ProPR processes those directly as natural follow-ups.

The MCP `fix_review_findings` tool continues to accept explicit IDs only; it
supplies `selectableFindingIds` and `selectableSuggestionIds` for callers to
select. Like `/fix`, it runs against the current head even when new commits
landed after the review: it reports the selected records that still apply and
skips, by name, any whose cited files were deleted since the review when no
surviving file gained lines the code could have moved into. Passing
`expectedHead` keeps the stricter behaviour and refuses a moved head. An MCP
`all` option is a possible follow-up.

Two separate time windows govern which comments `/fix` touches:

- **7-day comment-age filter**: `/fix` gathers only review comments newer than 7 days. Older review comments are left alone.
- **30-day processed-state retention**: once a review comment is applied, its processed state is kept for 30 days, so each suggestion is applied at most once and a later `/fix` skips it.

## Model Routing

Use model routing commands when the current PR should use a different configured agent or model.

### `/switch`

`/switch` changes the PR's model label for future work:

```text
/switch <model-id>
```

ProPR replaces the PR's `llm-*` label with the new model's label. Later comments, commands, and ultrafix cycles on this PR use the new model.

`/switch` takes exactly one model argument; extra arguments are ignored. The model must be a known catalog model or a model configured on an enabled agent — otherwise the command is ignored and the label stays unchanged.

If you include instructions on the lines below the command, ProPR switches the label and also queues one follow-up run with the new model using those instructions:

```text
/switch llm-claude-opus5
Re-check the concurrency handling after switching.
```

Without instructions, `/switch` only updates the label and makes no code changes.

### `/use`

`/use` runs one immediate follow-up task with a temporary model:

```text
/use <model-id>
Please investigate the flaky test failure and update the PR.
```

The PR's model label keeps its current value. Later work returns to the PR's configured model unless you use `/switch` or another `/use`. Like `/switch`, `/use` takes one model argument, and the agent sees only your instructions, without the command syntax.

### Choosing A Model

Check AI Agents in the Web UI for the model IDs available in your deployment; the built-in catalog is in [Agents and Models](./agents-and-models.md).

Use routing when:

- A model is better suited to the task
- The current model is stuck
- You want a one-off second opinion
- You need to work around provider capacity or rate limits

## Ultrafix And Branch Updates

Use these commands when the PR needs branch help or an automated correction loop.

### `/merge`

Post:

```text
/merge
```

`/merge` runs only on PRs that carry a configured processing label (for example `AI` or `propr`). ProPR merges the base branch into the PR branch inside an isolated worktree. Merging the PR itself into the base branch remains your call — a human clicks that merge button. An agent run accompanies the branch update:

- On a clean merge, the agent verifies the result before it is pushed.
- On conflicts, the agent resolves the conflict markers.

In both cases ProPR then scans the tree to confirm no conflict markers remain before pushing. If markers remain, the task fails and the broken merge stays unpushed.

ProPR posts a status comment on the PR when the merge starts and updates it with the result.

Use `/merge` before final review when the base branch has moved or the PR has conflicts.

### `/ultrafix`

Post:

```text
/ultrafix
```

Or configure the loop:

```text
/ultrafix goal=8 max=10 pause=120 model=llm-claude-opus5
```

`/ultrafix` alternates review and fix cycles until the latest review score reaches the goal or the maximum cycle count is exhausted.

#### Parameters

| Parameter | Meaning | Constraints | Default |
|---|---|---|---|
| `goal` | Target review score (`Score: N/10`) | Integer 1–10 | 7 |
| `max` | Maximum fix cycles before giving up | Positive integer | 5 |
| `pause` | Seconds to wait between cycles | Non-negative integer | 60 |
| `model` | Model for the review cycles | Configured model ID (`llm-` prefix optional) | PR review model from Settings |

A bare number is treated as the goal: `/ultrafix 8` is the same as `/ultrafix goal=8`. Defaults can be changed in Settings. Unknown keys and invalid values are ignored with a warning. Lines below the command become extra instructions for the cycles.

#### Automatic Escalation

Settings → Automation → General configuration provides an instance-wide escalation policy, disabled by default. It does not add repository or PR overrides.

| Setting | Default | Meaning |
|---|---|---|
| `ultrafix_escalation_enabled` | `false` | Enable automatic escalation |
| `ultrafix_escalation_models` | `[]` | Ordered handoff models, as model IDs or `agent:model` pairs |
| `ultrafix_escalation_patience` | `3` | Stalled reviews before each escalation step |
| `ultrafix_escalation_max_reasoning_levels` | `2` | Maximum effort increases per model; `0` hands off directly |

The first model is the model already implementing the PR, including its normal reasoning configuration. Review model selection remains controlled by the existing review setting. Every complete, usable review compares its score with the best score seen during this run: `6 → 6` stalls; `6 → 7` resets patience. Lower scores also stall. Invalid and partial reviews do not drive escalation.

After patience expires, the implementation model climbs one of its own available effort tiers. After the configured number of increases, or when no higher tier exists, ProPR tries the next handoff model at that model's own configured base effort. Each step receives a fresh patience window, while the best score remains shared across the run. Antigravity uses the matching effort variant of its model ID (Pro has low/high; GPT-OSS has only medium). Models without an effort dial hand off directly.

Select escalation models from the ordered dropdowns in General settings. Fresh Agent Tank session or weekly usage of 100% or higher skips a handoff candidate. Missing, stale, disabled, or failed usage monitoring permits escalation. Unavailable models are skipped too. If no later model is available, the loop continues with the current model and effort until its normal stopping conditions apply.

The policy is captured when the first automatic fix starts and persisted with the run, including its current model, effort, best score, and patience counter. Webhook and polling intake use the same continuation; deferred CI resumes retain this state. Disabling the master toggle also bypasses escalation in existing runs. The existing overall maximum cycle limit and goal/coverage rules still apply across all models. With escalation disabled, model and reasoning selection and stopping behavior remain unchanged.

#### Waiting Rules

Before each cycle, ProPR checks readiness:

- Before each review cycle, CI on the PR head must be passing (every check run and commit status, except checks the repository marks [non-blocking](./pr-followup.md#checks-that-never-block-automation)); if it is not, the continuation is deferred and resumes when check results arrive. Fix cycles do not wait for CI.
- Non-blocking checks never gate Ultrafix: a check run or legacy commit status whose name matches the repository's `nonBlockingChecks` patterns is ignored whether it failed, is still queued, or is running.
- The PR must be inactive — no other queued or running job and no pending batched comments — so the loop does not race other work on the PR.
- The configured `pause` delay is applied between cycles.

When blocking CI defers a review, ProPR posts one comment on the PR naming the checks that hold the next Ultrafix step back (failed or not finished). It is posted once per deferral — per head commit — not on every re-check, and no extra comment is posted when CI turns green and the loop continues. MCP `start_ultrafix` / `run_ultrafix` receipts report the same deferral reason and blocking checks as the `waiting_for_ci` phase instead of a pickup failure.

The wait is bounded. If the review stays deferred for longer than the CI wait timeout — the `ultrafix_ci_wait_timeout_ms` instance setting (default 2 hours, settable through MCP `update_execution_settings`, `propr setting update ultrafix_ci_wait_timeout_ms <ms>`, or the `ULTRAFIX_CI_WAIT_TIMEOUT_MS` environment variable) — the loop stops with the usual "Ultrafix stopped before reaching its goal" comment and the reason "CI did not settle". Fix or re-run the blocking checks, then re-arm the loop with `/ultrafix`.

#### Recovery From CI Failures

A loop paused on red CI does not need to be restarted by hand once CI is fixed:

1. **Pause.** An automatic fix lands, CI on its commit fails, and the next review is deferred, as described in [Waiting Rules](#waiting-rules). The loop stays active and keeps its `ultrafix` label.
2. **Follow-up fix.** A [CI-failure follow-up](./pr-followup.md#automatic-follow-up-for-failed-ci), a `/fix`, or a developer push fixes the build. Each new piece of automatic work starts a new work epoch, which retires the old deferred step so a stale continuation cannot run against the new commit. The loop itself stays active and is not lost.
3. **Green checks wake the loop.** When the checks on the current PR head pass (a head with no checks at all counts as passing), ProPR re-evaluates the loop. Three triggers can do this: `check_run` events (including runs GitHub delivers without a PR number, which are matched to open PRs by commit), successful `check_suite` events, and the polling cycle's reconciliation for PRs labelled `ultrafix`, which covers missed webhooks.
4. **Resume.** If the loop is still active and the PR is idle, ProPR moves the loop to a new work epoch of its own and schedules the next review after the configured `pause`. A later `/fix`, `/review`, or follow-up therefore supersedes that review just like any other automatic step. From there the loop continues as normal. The resumed review and later fixes keep the instructions you wrote beneath `/ultrafix`.

If a wake-up finds the PR idle but the checks on the new head still red or running, the loop moves to a new work epoch and its review is deferred again. The usual [CI wait](#waiting-rules) applies: one notice per head, and the loop stops with "CI did not settle" once the CI wait timeout passes.

If a wake-up cannot settle the loop, ProPR records a retry for the PR. This happens when Ultrafix work is still in flight, when the queue cannot be read, when scheduling the review fails, or when the wake-up loses its resume lock without another wake-up taking it over. A retry is also recorded when an Ultrafix step job fails after all its attempts, because no continuation runs for it. This holds even when the job fails before the wake-up that scheduled it hears back from the queue. A periodic sweep, run every minute, retries it without waiting for another webhook. The same sweep also re-checks deferred reviews. When the only work in flight is the loop's own current step, that step's continuation already owns the loop, so the sweep checks back after 15 minutes instead of every minute. Polling reconciliation honours the same delay. Starting `/ultrafix` again drops any retry left by the previous loop.

The sweep runs in both the API server and the daemon, so a daemon-only deployment with PR polling disabled still retries. The per-PR resume lock keeps the two from acting on the same loop at once. When both run against the same Redis, a shared lease lets only one of them sweep each minute. Each sweep reads a Redis index of the PRs that have a retry or a deferred review instead of scanning every key. A full key scan still runs when a process starts and every 30 sweeps after that, to find any record that was never indexed.

If scheduling a deferred step fails, for example because the queue is briefly unavailable, the step is kept and the sweep retries that same step. The same holds if the process stops right after taking the step and before scheduling it: the retry carries a copy of the step, and after a restart that step resumes as long as the loop and its work epoch are unchanged. A deferred final fix is therefore not lost and does not turn into a cycles-exhausted stop. If the loop has moved on in the meantime, for example because a `/fix` superseded the step, the usual recovery applies instead.

The usual protections still apply when the loop is woken:

- **Max cycles.** A recovered loop always restarts with a review, because new commits have landed since its last one. It uses the same budget as the normal flow. If the loop was stranded after a fix, the review runs unless the review limit is already reached. That includes the verifying review after the final permitted fix. If it was stranded after a review and the fix limit is reached, the next step would have been a fix, so the loop finishes. When the budget is used up, the loop finishes as failed and posts the usual "stopped before reaching its goal" comment, and no review is scheduled. So a loop stranded right after its final review stops here instead of running the final fix that the normal flow would still have allowed. A deferred final fix that was never dropped resumes as usual.
- **Goal reached.** A loop whose review meets the goal finishes immediately, so it is never left waiting. As a safeguard, a waiting loop whose state already records a final score at or above the goal finishes as succeeded and no review is scheduled.
- **Label removed.** If the `ultrafix` label was removed while the loop waited for CI, its state is cleared and nothing is scheduled. If GitHub cannot be asked about the label, for example during an outage or rate limiting, the loop is kept and a retry is recorded instead.
- **Repeated step failures.** If Ultrafix step jobs keep failing after all their attempts, the loop is recovered at most twice. On the third failure in a row it finishes as failed and posts the usual "stopped before reaching its goal" comment. A step that completes in between resets the count.
- **Work in flight.** Nothing is decided while an Ultrafix job is queued, running, or delayed, or while batched comments are pending. That work's own continuation owns the loop. The same goes for any other job on the PR, such as a manual `/fix` or a CI-failure follow-up that has not pushed yet. Reviewing before it pushes would review the wrong commit, so a retry is recorded and the loop resumes once that job is done.
- **Healthy loops.** A loop still driven by its own current step is never taken over. One example is a loop that `/ultrafix` has just started but whose first job is not queued yet. A wake-up that finds such a loop, even after re-reading a changed state, leaves it alone.

Several triggers often fire for the same green commit at once: check runs, the check suite, and polling. Only one review is ever scheduled. Each wake-up first takes a short per-PR resume lock, so concurrent triggers back off instead of deciding twice. A trigger that backs off leaves a re-check request. The wake-up holding the lock runs once more after it finishes, so a check that turned green while it was still reading CI is not missed. Steps are also enqueued under a deterministic BullMQ job ID derived from the PR, the work epoch, and the step number, so a deferred step that is already pending is never inserted a second time. Each recovery reserves its own work epoch, so if a recovery misses an earlier recovery's review that is still in the queue, the earlier review is superseded and skipped when it runs.

#### Stopping The Loop

The loop is controlled by the visible `ultrafix` PR label, which acts as a circuit breaker. Remove the label to stop the loop after the current cycle finishes.

#### Completion

- **Goal reached**: the `ultrafix` label is removed. If the PR belongs to a planned issue labeled `auto-merge`, ProPR re-enables GitHub auto-merge on the PR.
- **Stopped before the goal** (max cycles exhausted, a review that cannot advance the loop, or CI that did not settle within the CI wait timeout): ProPR posts a warning comment with the requested goal and the last score, and manual review takes over. The `ultrafix` label is left on the PR; remove it once you take over.

Reserve `/ultrafix` for stronger cleanup passes. For small edits and direct changes, a normal PR comment is usually better.

## Completion Comments

When a command or follow-up task finishes, ProPR posts a completion comment on the PR with a summary of what was done, the commit hash when changes were committed, and an expandable "ProPR Slash Commands" reference block listing the available commands.

{/* SCREENSHOT PLACEHOLDER (P1 — public repo only; interim: the site's real-review-1.png + real-pr-propr-claude.png): Capture a PR conversation showing a `/review` comment, the resulting AI review with severity findings and a `Score: N/10` line, and a ProPR completion comment with the expanded slash commands block. */}
