# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **MCP `resolve_merge_conflicts`**: the MCP equivalent of typing `/merge` on a
  pull request. It posts the same `/merge` command, whose intake merges the base
  branch into the PR branch and resolves conflicts with an agent. It requires
  `expectedHead` (a moved head fails with `STALE_HEAD`) and an `idempotencyKey`,
  refuses a PR without a ProPR processing label with `PULL_REQUEST_NOT_MANAGED`,
  and returns a durable receipt that `get_operation` follows to the merge task.
  `update_pull_request_branch` is unchanged and still covers the clean case
  GitHub can update itself.

### Changed

- **Ultrafix CI wait comment**: the "Ultrafix is waiting for CI before the next
  `/review`" comment is now edited in place with the wait's outcome instead of
  staying on the PR next to it. The review that runs once blocking checks pass
  turns it into its "AI Code Review Complete" comment, and a CI wait timeout
  turns it into the "CI did not settle" stop comment.

- **`GET /api/stats/dashboard`** reports its daily series as `dailyTasks`
  (tasks created per UTC day, the series the Analytics activity chart plots)
  and no longer reports `dailyCompleted` (completions per day). The bundled
  dashboard reads `dailyTasks`, and still draws `dailyCompleted` from an older
  server; a script that read `dailyCompleted` should read `dailyTasks`.
- **Repository to-dos**: launching a task from a to-do (**Run task**, MCP
  `create_task` with `todoIds`, or a submission retry) now marks the to-do
  completed once its GitHub issue exists and records that issue
  (`linkedIssueRepository`, `linkedIssueNumber`, `linkedTaskId`). The REST API,
  MCP `list_todos`/`get_todo`, the CLI and the Web UI carry the link, and the
  UI shows a `#<issue number>` chip opening the issue on active and completed
  to-dos. Only the submitting user's to-dos in the issue's repository are
  touched, and a failed to-do write never fails the submission.

## [0.9.0] - 2026-09-29

Covers every change merged since v0.8.15. This section records delivered source
changes; it does not announce published packages, images, desktop installers or a
release tag. The [coverage audit](docs/release-0.9.0-audit.md) covers changes
through `c2de30509`.

### Added

- **Goals and native execution**: launch long-running objectives with Claude Code,
  Codex or Antigravity, follow their progress and artifacts, and send corrective
  inputs. Antigravity runs goals through its built-in `/goal` command; inputs,
  pauses and model changes are applied at the next finished step and the same
  conversation resumes. Pause/resume/cancel controls and capability-aware input
  delivery preserve work across execution boundaries. Goal timelines show operator
  corrections verbatim, and published checkpoints render as a `CHECKPOINT` card
  instead of raw JSON.
- **Goal CLI, blockers and waits**: the `propr goal` command group covers
  `capabilities`, `create`, `list`, `inspect`, `input`, `inputs`, `pause`,
  `resume`, `cancel`, `model`, `attention` and `wait`, with `--json` output and
  idempotent retries. Goals that need you (a confirmed pause, or a Codex question
  or approval) appear as durable blockers in the goal console's **Needs you**
  panel, the goal list, the dashboard, `propr goal attention` and MCP
  `list_goal_attention`, each naming the action that resolves it; ProPR never
  approves on your behalf. MCP `wait_goal` and `propr goal wait` wait with a
  finite deadline for a confirmed state or a new checkpoint, and a resumable
  cursor means a reconnect never misses or repeats a transition. MCP
  `create_goal` accepts `ultrafix` and `maxParallelTasks` (default 1 over MCP).
- **Automations**: saved prompts that run on demand or on a UTC cron schedule
  (15-minute minimum) and produce a free-form Markdown report. Create them on the
  **Agents** page, trigger them with **Run now**, `POST
  /api/agent-definitions/:id/runs` (with an `Idempotency-Key`), MCP
  `trigger_agent_run` or `propr automation run --wait`, and read the report in the
  UI, over MCP or with `propr automation report`. Each run is an isolated ProPR
  task that never commits or pushes, with up to 10 repositories read-only,
  optional web access, up to 10 input files and up to 5 previous reports as
  context. Autonomy is **Dry run** (report only, the default), **Preview +
  approve** (an acting step waits for your approval, with an Inbox notice) or
  **Auto**. The acting step works only through ProPR MCP tools with a
  short-lived grant limited to the automation's repositories; it can create
  tasks, plans, goals, to-dos and PR comments, and cannot merge, deploy, change
  settings or trigger other automations. Acting and ProPR tool access need
  Claude Code or Codex. Unattended runs are skipped or deferred when Agent Tank reports
  usage at or above `agent_run_usage_pause_percent` (default 90%); missed
  schedule slots coalesce into one run. New MCP tools: `list_agent_definitions`,
  `get_agent_definition`, `get_agent_definition_contract`, `list_agent_runs`,
  `get_agent_run`, `trigger_agent_run`, `approve_agent_run` and
  `reject_agent_run`; new optional environment variables
  `PROPR_INTERNAL_API_URL` and `PROPR_AGENT_MCP_URL`. See the
  [Agents guide](docs/docs/features/agents.md).
- **New Task**: launch a single instruction against a repository without planning
  a multi-issue project. New Task and New Goal share one dialog with a **Prompt**
  field, docked attachments and collapsed **Advanced Options**; New Task
  preselects your last repository, agent and model, and repository pickers list
  starred repositories first. Repository and to-do shortcuts prefill the request,
  attached images are embedded in the created GitHub issue, and the resulting
  issue, task and pull request remain traceable.
- **Plan revision history**: inspect saved plan snapshots and restore a prior
  version; each revision is labelled **Generated**, **Refined**, **Manual edit**,
  **Restored** or **Renamed**. Refinement retains the complete plan and rejects
  partial output instead of overwriting the plan with a fragment; file-based
  generation validates every issue before accepting output, with guarded syntax
  repair when needed.
- **Sequential epics**: **Implement Epic** in the UI, CLI, API and MCP
  `implement_plan` queues the selected issues in publication order, runs one at a
  time and advances durably after each merge. Over MCP the default holds a failed
  or closed head until it is fixed and merged, `epicAdvanceOn: "terminal"` moves
  past it, and `epicExecution: "parallel"` restores fan-out and multi-model
  comparisons. Pause/resume holds and releases the next issue. Plans already
  running at upgrade have no queue; restart them from their next pending issue.
- **Inbox, PWA and Web Push**: install the web app, opt into browser notifications,
  choose personal categories and quiet hours, and suppress repository notifications
  without stopping automation. Inbox opens the relevant task, plan or goal and
  supports paging and synchronized dismissal.
- **Authenticated MCP**: administrators enable the server and bound its scopes;
  users consent to repositories and manage connected apps. Operator tools cover
  current/recent activity, goals and corrective inputs, plans, tasks, PRs and
  review control. Status filters and a payload-free administrative access log
  make activity easier to inspect. One-off MCP tasks support explicit Ultrafix
  and auto-merge options with the corresponding scopes.
- **MCP tools**: `list_operations` and a receipt lifecycle (`accepted`,
  `running`, `completed`, `failed`, `cancelled`) followed through to completion,
  including `/review`, `/fix` and Ultrafix progress; `get_work_overview` for
  running and recent tasks with their PR checks, review and Ultrafix state;
  `list_task_submissions`; `start_ultrafix`; `review_pull_request` with one or
  up to 8 review models; `generate_repository_improvements` for the **Improve**
  tab; `search_repository_files` (semantic or literal) and
  `read_repository_file` to find and read code without cloning;
  `list_visual_previews`, `get_visual_preview` and `get_comment_attachment` for
  images on tasks, PRs and comments; `get_trigger_access_configuration` and
  `update_trigger_access_configuration`; and `list_docs`, `get_doc`,
  `search_docs` and `find_setting`, answered from the documentation bundled with
  the running version. A generated "Where each setting lives" docs page uses the
  same settings catalog.
- **HTTP API reference and `@propr/client`**: an OpenAPI 3.1 spec generated from
  the API route registry, with each route's authentication and required
  permission and a common error envelope (`code`, `message`, `hint`), rendered as
  an "API reference" page under Operations in the docs. `@propr/client` gains
  typed task and task submission methods, generated `ProprApi.*` types and a
  README covering authentication, examples and Socket.IO events.
- **Desktop application**: browser-approved pairing, saved accounts and instances,
  local setup, connection diagnostics, native menus and notifications, and separate
  application/runtime version displays. Linux/macOS packaging and Linux preview
  verification are present; Linux previews embed a digest-pinned managed agent
  image built from the same commit. Distribution remains subject to the
  documented release gates, Windows package validation remains paused, and agent
  tasks run on amd64 only.
- **Visual previews**: repository capture settings, GitHub attachments, optional
  Plus managed originals, task/goal galleries and zoomable image viewing. Private
  PR images use authenticated media access in web and desktop.
- **Synthetic pools**: virtual models route among direct agent/model members using
  priority tiers, usage limits, scheduling and failover.
- **Repository workflow file**: an optional `.propr/workflow.yml`, read from the
  base-branch commit for every implementation and PR follow-up, defines lifecycle
  hooks (`after_create`, `before_run`, `after_run`, `before_remove`), an
  instructions file appended to prompts, `validation` commands whose results are
  added to the completion summary, preview types, `limits.max_parallel_tasks`,
  `limits.max_cost_usd`, `auto_merge` and `network`. An invalid file fails the
  run before the agent starts. `propr init` scaffolds a commented example, and a
  JSON schema is published for editors.
- **Pull request templates**: an optional `.propr/pr-template.md` shapes the
  title and description of the pull requests ProPR opens, with sections such as
  `title`, `summary`, `run` and `trailer` and `{{placeholder}}` substitution.
  Untrusted values are sanitized and HTML-escaped. Without the file, ProPR adds
  the repository's GitHub pull request template under its own summary (per
  repository, on by default: `propr repo toggle --no-github-pr-template`).
  `propr repo validate` checks a template locally. A template that cannot be read
  or rendered falls back to the default description and never fails a run.
- **Auto-merge policy with protected paths**: an `auto_merge` block in
  `.propr/workflow.yml` (`enabled`, `method`, `protected_paths`, with `.propr/**`
  always protected) gates every point where ProPR arms GitHub auto-merge or
  merges an `auto-merge` PR. The policy is read from the base branch and the
  changed files from a fresh GitHub fetch, and anything unreadable means no
  auto-merge. A skip is recorded with a reason code, commented on the PR and
  leaves the label for a person; a new head that violates the policy disarms
  auto-merge ProPR armed. A skipped Epic head waits for a human merge.
- **Per-run spend caps**: a run whose estimated cost reaches its cap is stopped
  while it executes and its partial work is published. The cap comes from a
  per-task `maxCostUsd` (task submissions, MCP `create_task`, `propr issue
  implement --max-cost`), then `limits.max_cost_usd` in `.propr/workflow.yml`,
  then the instance `default_max_cost_usd`. It covers implementations,
  follow-ups, `/fix`, Ultrafix cycles and reviews; retries share the budget.
  Capped runs end with `cost_cap_exceeded`, notify the Inbox and comment on the
  issue or PR, and task details show spend against the cap.
- **Agent watchdog**: an agent that produces no output for 10 minutes (30
  minutes while a tool runs silently), or streams 50 consecutive whitespace-only
  deltas, is stopped instead of holding its worker slot until the 24-hour
  timeout. Partial work is published, the task ends `stalled` or
  `degenerate_output`, and the Inbox and GitHub comment explain the stop.
  Thresholds are instance settings under **Settings → Automation → Agent
  watchdog** and apply to the next run.
- **Automatic replacement runs**: an issue task lost with its worker gets one
  replacement, and a run that ends on a transient provider error (5xx,
  overloaded, connection reset) gets up to `max_provider_replacements` (default
  2). Replacements reuse the agent, model and overrides, continue the pushed
  branch and receive what remains of the spend cap; user and withdrawal
  cancellations, timeouts, watchdog and spend-cap stops and goal tasks are never
  replaced. Task details show "Attempt N of M", the Inbox shows one
  "Replacement started" card, and the final failure comment links every attempt.
- **Push salvage and rejection diagnosis**: when the final push of a run fails,
  ProPR retries with a fresh token, then pushes to a
  `refs/propr/rescue/<taskId>` ref, then writes a git bundle under
  `<DATA_DIR>/rescue/`, then keeps the worktree, so the agent's commits are never
  lost. The rejection is classified (`push_protection` with GitHub's unblock URL,
  `ruleset_or_branch_protection`, `non_fast_forward`, `auth`, `network`,
  `unknown`) and shown with the exact recovery command in task details,
  `propr task get` and the failure comment. An issue run whose push fails now
  ends failed. Rescue refs and bundles are pruned after
  `PUSH_RESCUE_RETENTION_DAYS` (default 14).
- **Restricted network mode**: an optional `restricted` mode starts agent
  containers with `--network none`; their only route out is a per-run HTTP/HTTPS
  allowlist proxy on the worker, reached through a Unix socket. No privileged
  containers, `NET_ADMIN` or iptables are needed. The default allowlist covers
  the agent's provider API, GitHub, npm and PyPI; the instance and each
  repository's `network.allow` add exact hosts, `*.domain` wildcards or
  `host:port`. DNS resolves on the worker, and loopback, private and link-local
  addresses (including cloud metadata) are refused unless the instance lists
  the IP. The instance sets the default mode (`open` by default) and can
  enforce restricted mode across repositories (**Settings → Automation → Agent
  network**, `propr setting update`, MCP `update_execution_settings`). Issue
  runs, PR commands, reviews, goals and indexing are covered; Automation runs
  follow restricted mode only when the instance enforces it, and plan generation
  is not covered. Each restricted issue, PR, review or goal run records one
  timeline event listing every denied host. Claude Code, Codex, OpenCode and
  Vibe run behind the proxy; Antigravity falls back to open networking with a
  warning, or is refused when restricted mode is enforced.
  Requires a Linux Docker host that shares `PROPR_EGRESS_SOCKET_DIR` with the
  worker; the bundled Compose files and launcher mount it.
- **Ultrafix escalation**: an opt-in instance policy
  (`ultrafix_escalation_enabled`) raises the implementing model's reasoning
  effort one tier at a time when review scores stop improving for
  `ultrafix_escalation_patience` reviews, then hands off to the next model in
  `ultrafix_escalation_models`, skipping models Agent Tank reports at their
  usage limit.
- **Review scores and agent efficacy**: every `/review` and Ultrafix review with a
  parsed score is stored with the reviewer and implementer model, and PR merge
  outcomes are recorded. Analytics shows **Agent efficacy by model** (evaluated
  PRs, initial and final score, score delta, average runs to merge, merge rate),
  task details show a PR's score history, `propr stats review-scores` prints the
  summary, `GET /api/stats/review-scores` (and `.csv`) serves it, and MCP
  `get_pull_request` includes `scoreHistory`. Earlier scores are not backfilled.
- **Withdrawing work**: closing an issue or removing its trigger label cancels its
  queued and running implementation work, and closing a PR without merging
  cancels its follow-ups, reviews and Ultrafix loop. Webhooks act immediately,
  polling catches the rest, and workers re-check GitHub before starting.
  Withdrawal cancellations are terminal and never retried; reopen and reapply
  the label to restart.
- **GitHub App from the CLI**: `propr github-app create` registers a private
  GitHub App through GitHub's manifest flow, verifies the installation, writes
  the private key and `.env`, and configures direct webhooks and GitHub login;
  `propr github-app manifest` writes the files for manual registration, and
  `--no-browser` works over SSH. `propr setup` offers **Create it for me** for a
  custom App, with Connect remaining the default.
- **Bundled Agent Tank**: Agent Tank usage tracking has three modes, **Disabled**
  (default), **Bundled** and **External**. Bundled mode runs Agent Tank inside
  the agent image with nothing to install; external mode points at your own
  daemon. Set it in **Settings → Integrations → Agent Tank**, with
  `propr tank bundled|external|off` or MCP `update_provider_policy`. Existing
  settings migrate.

### Changed

- **Navigation and dashboard**: The primary creation action follows the page: New Task by default,
  New Plan in Plans/Planner Studio and New Goal in Goals. Quick add to-do offers
  Add another after saving. Work and system navigation are grouped;
  Goals, repository settings and connected apps have revised layouts. The dashboard
  shows Needs attention, Happening now, Completed and Historical stats, with a
  repository filter, activity summaries and documentation-derived usage tips;
  Completed loads an entry's earlier updates when you expand it. `Cmd/Ctrl+K`
  opens a command palette with category tabs and a live preview pane. Lists
  share one loading skeleton. Broader reporting lives in Analytics.
- **Tasks console**: Tasks is one ledger with a row per task (status, agent,
  duration, score, a **Merged** state and a run-count chip summarizing earlier
  runs) and 25 tasks per page. From 1280px wide a task opens in a side pane
  (`?task=` survives reloads; `j`/`k` move between rows, `Esc` closes); the full
  task page lists every run in a timeline and switches screenshots, trace and
  changed files per run. Task details group metadata, list the largest file
  changes first and move **Delete** into the overflow menu.
- **Analytics**: one console with a timeframe selector (24 hours to all time,
  kept in the URL as `?period=`; the stats API accepts the same `period`). A
  totals band and a **Delivery** band (runs per task, first-time pass, time to
  merge, autonomy) sit over daily activity bars for runs and tasks, repository
  performance, a per-model table counting runs, task status and token
  consumption with cache hit rate and savings from caching. Rows open the
  filtered Tasks list or the LLM log. The dashboard's Historical stats use the
  same aggregation and window, so the figures match.
- **Planner Studio**: plans move through a **Define › Review › Execute** stepper.
  Define has a **Scope** control (**Focused**, **Expanded**, **Full Scan**) and a
  docked composer for task size, model and context export. Review adds a step
  tab bar, a collapsible, reorderable **Plan Outline** and a **Jump to task**
  sheet on phones. Execute toggles between **Epic PR** and **Individual Tasks**,
  shows issues in one matrix with per-row agent overrides, and **Queue
  Remaining** starts the first pending issue and chains the rest (individual
  tasks chain only with auto-merge on). Plan statuses are simplified, with
  "Ready for Review" now **In Review**.
- **Coding Agents screen**: compact model chips copy their alias on click,
  providers collapse, and **Log in**, **Edit path** and **Delete provider** moved
  into each provider's actions menu.
- **Live activity**: push-driven refresh, hidden-tab reconciliation, append-based
  logs, cached/coalesced reads and bounded output reduce polling and rendering work.
- **Review commands**: `/fix F20 S3 S5` can select findings and optional suggestions
  together, and `/fix all` selects every pending blocker and suggestion. Every
  review comment ends with a copyable `/fix F# S#` line to trim. Unknown or
  malformed identifiers reject the whole selection. `F#` and `S#` sequences
  persist independently per PR. Suggestions remain optional and do not extend
  Ultrafix or change score gates. Multiline instructions are preserved.
- **MCP behaviour**: tool failures return a structured error with `code`,
  `message`, `stage` and `retryable`, with secrets and absolute paths redacted.
  `expectedHead` is optional on `review_pull_request`, `fix_review_findings`,
  `run_ultrafix` and `comment_on_pull_request`; supplying it still rejects a
  moved head. `fix_review_findings` re-anchors findings onto a newer head like a
  typed `/fix`. `merge_pull_request` names the failed precondition (for example
  `CHECKS_FAILING` or `MERGE_CONFLICT`). `publish_plan` accepts `resume: true` to
  continue a partly published plan. `delete_plan` deletes idle and finished
  plans without a revision and reports `PLAN_NOT_DELETABLE` separately from
  `STALE_REVISION`. An omitted Ultrafix goal now uses the instance
  `ultrafix_rating_goal` instead of 9.
- **CI cancellation**: an opt-in repository setting cancels only explicitly selected
  workflows on the exact PR head being replaced. Interrupted/no-change follow-ups
  retain restart obligations; closed PR cleanup uses the same opt-in policy.
  Per-repository non-blocking check patterns keep selected checks from delaying
  ProPR automation, Ultrafix and Epic advancement while preserving their visible
  GitHub results.
- **Agent models**: Claude Code adds Claude Opus 5.5 (the new default), Fable 5.1
  and Sonnet 5.5, bundled at Claude Code 2.1.284. Codex adds GPT-6 Astra (the new
  default), GPT-6.1 Sol, GPT-6 Sol and GPT-6 Luna on Codex CLI 0.160.0.
  Antigravity lists one entry per model (Gemini 3.8 Flash by default, Gemini 3.1
  Pro, Claude Sonnet 5.5, Claude Opus 5.5, GPT-OSS 120B) with a separate
  reasoning selector instead of effort-suffixed entries; saved suffixed selections
  and labels still resolve. OpenCode defaults to Big Pickle and adds Ling 3.0
  Flash Fin Free, Muse Spark 1.2 and 1.3 Contributor Free and Nemotron 3.5
  Lightning Free. Mistral Vibe adds GLM 5.3 and GLM 5.2 on the same Mistral
  credentials (Vibe 2.25.8, Python 3.12). Older models remain selectable behind
  the legacy fold. GitHub comments and commit messages show model display names.
- **Read-only agent GitHub access**: implementation, follow-up, review-fix and
  direct-goal containers receive a read-only installation token, and the
  worktree's `.git` and shared clones are mounted read-only; ProPR performs every
  push, merge, comment and label itself. The repository setting
  `contextRepositories` limits the token and mounted clones to the task
  repository plus a list. Orchestrated goals keep write access.
- **Voice briefings**: experimental and off by default; enable per account,
  instance and device in Settings.
- **Security and operations**: durable instance roles, scoped repository access,
  guarded agent runtimes and desktop network/credential boundaries; improved
  health signals, rootless CI worker routing and change-aware validation.

### Removed

- **Post-implementation analysis**: the execution analysis that rated each run's
  prompt, efficiency and implementation is gone, with the analysis worker
  service (upgrades remove its container), `GET /api/task/:taskId/analysis`, the
  task details analysis panel, critique score pills and the **Auto-Followup Score
  Threshold** setting. "Post-Implementation Analysis Model" is now **Fast
  Analysis Model**, used by `/review` to gather context. `/review`, review scores
  and Ultrafix are unaffected.
- **iptables firewall**: the allowlist firewall script (`scripts/init-firewall.sh`)
  needed privileged containers, so no entrypoint ran it. The script and the agent
  image's `iptables` package are gone; restricted network mode replaces them.
- **Retired models**: Antigravity Gemini 3.5 Flash (its labels no longer
  resolve), with Gemini 3.6 and 3.7 Flash leaving the picker while saved
  selections still run; OpenCode DeepSeek V4 Flash Free, Laguna S 2.1 Free, Ling
  3.0 Flash Free and North Mini Code Free; Vibe Devstral Small, whose saved
  defaults move to Mistral Medium.

### Fixed

- **Ultrafix and CI**: a loop paused on failing CI resumes when green `check_run`
  or `check_suite` events or polling show the build fixed, and a deferred step
  survives restarts and failed jobs. Review readiness honours the repository's
  non-blocking check patterns; when blocking CI defers a review ProPR posts one
  comment naming the checks, and stops the loop with "CI did not settle" after
  `ultrafix_ci_wait_timeout_ms` (default 2 hours). Check events without PR
  numbers, notably for fork PRs, are matched to their PRs by commit. Existing
  GitHub Apps must subscribe to the **Check suite** event; `propr check --verify`
  reports it missing.
- **Merge-conflict auto-resolution**: detection no longer skips most conflicts.
  ProPR waits for GitHub to compute mergeability, checks open PRs when their
  base branch moves, sweeps periodically, and records a reason for every skip;
  resolution creates a real merge commit and leaves the remote untouched on
  failure. A per-repository **Auto-resolve merge conflicts** override (Always,
  Never or the instance default) is available in repository settings,
  `propr repo toggle --auto-resolve-conflicts` and MCP.
- **Publishing runs**: follow-up and `/fix` agents edit the writable workspace
  instead of the read-only worktree path, issue implementations refresh GitHub
  credentials before pushing, and parallel tasks on one repository no longer fail
  or re-clone on Git config lock contention.
- **Notifications**: deferred reviews no longer send a "ready for review"
  notification. Inbox shows "Inbox unavailable offline" instead of hanging, and
  reloads on reconnect.
- **Web, mobile and WebKit**: list search on phones for Tasks, Plans and Goals,
  repository tabs and the sidebar fit narrow screens, Tasks pagination no longer
  overlaps pages, New Task attachment recovery works in Safari, and lightbox
  keyboard focus no longer strands in WebKit.
- **Third-party notices**: the notices generator refuses to produce a
  `THIRD_PARTY_LICENSES.md` without the full Claude Code and Anthropic SDK license
  texts and a complete production dependency inventory, so images no longer ship
  incomplete notices.
- Bounded SQLite lock retries and explicit transaction replay rules protect
  concurrent workers and goal heartbeat writes.
- Durable task reconciliation, worktree cleanup before lock release, follow-up
  retries, fork PR handling and merged-PR completion avoid lost or repeated work.
- Plan prompt autosave, full-plan refinement, title preservation and partial
  generation rejection prevent silent loss of planning content.
- Private preview diagnostics, notification cleanup, live logs, partial indexing
  retries, model-aware review concurrency and alias-aware usage pricing.

### Security

- **Dependency advisories**: runtime dependencies are patched, including
  `simple-git` 4.0.2 (critical advisories),
  `@modelcontextprotocol/sdk` 1.32.1, `sharp` 0.35.5, `hono` 4.13.12,
  `proxy-addr`, `fast-copy`, `argv-parser` and `tinypool`; process-local Git
  authentication now strips inherited Git, editor, pager and SSH overrides.
  Desktop packaging and documentation build tooling are patched as well.

## [0.8.15] - 2026-08-15

ProPR 0.8.15 is the first public release.

### Added

- **Expanded coding-agent support**: added Antigravity Gemini 3.7 Flash High,
  Medium, and Low models with a pinned packaged CLI and strict no-fallback
  verification, plus an opt-in bundled ProPR orchestration skill for supported
  coding agents.
- **Connect Plus experience**: eligible Community Connect accounts can see and
  dismiss a privacy-safe capacity banner, and start the Connect Plus purchase
  path while preserving their authorized GitHub installation and billing choice.

### Changed

- **Validated public setup path**: documented Apple Silicon Docker Desktop,
  ProPR data-folder handoff, and safe CLI installation and management of the
  bundled Agent Skill.

### Fixed

- **Task stopping**: `propr task stop` sends one URL-encoded request to the
  supported task `/stop` endpoint and never uses the obsolete `/cancel` route.
- **Release hardening**: incorporated setup, migration, authentication, CLI
  validation, and Agent Tank reliability fixes validated for the public package.

## [0.8.14] - 2026-08-14

### Changed

- **Configurable live-E2E timeout**: model tasks can override the live-E2E
  timeout while retaining a bounded default when no override is configured.
- **Safe coding-agent installation guidance**: added a copyable,
  non-destructive setup prompt with human authorization gates and documented
  Node.js 22 and 24 as the validated CLI runtimes.
- **Packaged production defaults**: generated stacks set an explicit
  production runtime, publish API and UI ports on loopback by default, and
  wire browser-visible frontend and CORS origins.

### Fixed

- **Interrupted setup recovery**: fresh and migrated stacks without a durable
  administrator can safely resume `propr setup` after pre-authentication
  interruption.
- **CLI task stop compatibility**: `propr task stop` uses the canonical
  singular endpoint while the API continues accepting `cancel` as a
  compatibility alias.
- **CLI task deletion compatibility**: `propr task delete` uses the canonical
  endpoint while the API continues accepting the singular compatibility alias.
- **Hosted UI tunnel isolation**: tunnel authority is scoped per browser tab,
  popup OAuth uses the active managed tunnel, logout and navigation preserve
  the active flow, and copied, raw, or foreign authority is rejected.

### Security

- **UI dependency refresh**: updated the transitive `nanoid` resolution to
  3.3.18, addressing GHSA-2v37-7h3g-55p8 without upgrading `postcss`.

## [0.8.13] - 2026-08-13

### Fixed

- **Setup root persistence**: fresh `propr setup` runs retain the normalized
  stack root across later configuration saves, so rootless CLI commands target
  the configured stack from any working directory.

## [0.8.12] - 2026-08-12

### Changed

- **Guided setup defaults**: clean installs now use ProPR Connect and the
  default ProPR GitHub App, including guided GitHub login and App installation.

### Fixed

- **Local UI API routing**: production UI containers receive the browser-visible
  API origin, so local `/api/*` requests reach the backend instead of the static
  UI server.
- **Setup failure handling**: missing authentication, invalid intake settings,
  and unhealthy backend startup stop setup before dependent configuration or UI
  launch.
- **Connect authentication boundaries**: local login is limited to exact
  loopback callbacks while managed tunnels, custom OAuth Apps, and explicit
  operator modes retain their supported behavior.

## [0.8.11] - 2026-08-12

### Changed

- **Supported install contract**: release documentation now states the tested
  Linux `amd64` baseline, practical host sizing, Docker requirements, and
  Docker Hub as the canonical distribution registry.

### Fixed

- **Planner issue dispatch**: routing selectors are applied before the `AI`
  trigger label, preventing one planned issue from starting both on `main` and
  on its generated epic branch.
- **CLI read reliability**: transient transport failures on idempotent API
  reads retry briefly without retrying mutations or HTTP error responses.

## [0.8.10] - 2026-08-12

### Fixed

- **Resumable image publication**: partial Docker Hub releases preserve the
  first commit-scoped artifact and complete missing immutable tags safely even
  when a later rebuild produces a different digest.
- **Ultrafix deferred actions**: API continuation sweeps initialize the issue
  queue before checking conflicts or enqueueing the next review/fix action.
- **Source Compose compatibility**: backend development and legacy production
  images use Node 22, matching ProPR's declared runtime requirement.

## [0.8.9] - 2026-08-12

### Changed

- **Adaptive agent resources**: default container CPU limits now scale to the
  detected host capacity while preserving explicit operator overrides.

### Fixed

- **First-run repository activation**: repositories selected in setup or
  Settings load without a legacy config repository, reload live, and filter
  routed events before processing begins.
- **Retryable issue failures**: failed or zero-change interrupted agent runs no
  longer create empty pull requests or receive a misleading done label.
- **Review container reliability**: retries and concurrent review commands use
  unique Docker container names while preserving task ownership labels.
- **Release retries**: Docker Hub publication and npm artifact reconciliation
  are deterministic and safely resumable after partial workflow failures.

## [0.8.8] - 2026-08-11

### Added

- **Managed Connect login**: hosted tunnel instances can authenticate through
  the shared ProPR GitHub App without requiring users to create a separate
  OAuth App, while preserving verified GitHub identity and redirect state.
- **Guided agent validation**: setup prepares safe credential mounts, checks
  selected agents from the worker image, and prints exact login/recovery
  commands when an agent is not ready.

### Changed

- **Issue-driven Ultrafix**: an exact `ultrafix` label on a source issue now
  starts Ultrafix automatically on its generated implementation PR.

### Fixed

- **Agent and E2E reliability**: bundled runtimes remain executable,
  Antigravity initializes disposable state correctly, model-task failures are
  surfaced, and configured task coverage is tracked deterministically.
- **Review correctness**: emphasized scores are accepted and incomplete diff
  coverage fails closed instead of producing an overconfident review.
- **Safe runtime paths and logs**: model IDs cannot escape generated worktree
  paths, credentials are redacted from worktree diagnostics, and setup rejects
  unsafe agent credential mount paths before creating directories.
- **Deployment defaults**: Compose Redis ports remain bound to loopback rather
  than being exposed on public interfaces.
- **Release validation**: workspace dependencies are built before package
  typechecks, and agent runner code satisfies the release's zero-warning gate.

## [0.8.7] - 2026-08-09

### Added

- **Release validation**: pull requests and nightly runs now exercise the
  complete server/UI suite on Node.js 22 with isolated Redis, while release
  metadata discovery automatically includes publishable `@propr/*` workspaces.
- **Per-agent Web login**: adding Claude, Codex, Antigravity, or OpenCode can
  now create and authenticate an isolated account directly, without entering a
  host path. Managed credentials live below ProPR's credential root and allow
  multiple accounts from the same provider; existing host config remains an
  explicit alternative.
- **Review and PR decomposition workflows**: `/split` can create an authorized,
  idempotent PR-splitting operation, while model-aware context scouting enriches
  reviews within a configurable context budget and can be disabled per instance.
- **Instance administration**: explicit administrator roles separate privileged
  instance management from ordinary authenticated access.
- **Documentation**: security overview (trust boundaries, isolation, network
  surface, user-whitelist gating), evaluator FAQ, glossary, consolidated
  configuration reference (shipped vs code defaults), and a symptom-organized
  troubleshooting guide; intro gains a "First 15 Minutes" panel and the
  hosted-UI-tunnel docs are canonicalized to the deployment guide.

### Changed

- **Notification API contract (0.8.6)**: Push eligibility is opt-in at both the
  user-preference and producer-assignment layers; object-form recipients now
  require an explicit `pushEnabled` boolean. Synthesized preference entries use
  `updatedAt: null`, while persisted entries retain an ISO-8601 timestamp.
  Downstream `@propr/shared` consumers should handle the nullable timestamp when
  adopting the new notification API. No notification UI or production event
  producer existed in this repository to migrate.
- **Focused AI reviews**: reviews now evaluate the stated PR scope, keep
  suggestions separate from `/fix`, assign durable incremental finding IDs,
  explain blockers and suggestions in human-readable sections, and acknowledge
  implementation strengths without inflating the score.
- **Scope-safe Ultrafix cycles**: follow-up reviews and fixes retain the original
  PR objective, consume only current actionable findings, and preserve command
  ownership when comments are batched or superseded.

### Fixed

- **Fail-closed runtime safety**: webhook and merge checks require verified
  signals, configuration writes reconcile post-commit failures, and planner
  cancellation/live progress are isolated by generation run ID.
- **Task lifecycle ownership**: revision-ordered socket updates, fenced Docker
  execution and teardown, stale-task reconciliation, and reliable PR-comment
  finalization prevent older work from overwriting or terminating newer work.
- **Ultrafix orchestration**: CI readiness is action-aware (failed checks may be
  fixed, while reviews wait for a settled exact head); manual commands cancel
  superseded automatic jobs; fresh-loop startup, label teardown, terminal side
  effects, and deferred work are protected by renewable ownership and epochs.
- **Release and agent reliability**: nightly model coverage is deterministically
  bounded, immutable artifacts are preflighted, production image smoke coverage
  is restored, failed unified-agent image builds recover cleanly, and remote
  downloads plus Antigravity release artifacts are verified and pinned.
- **Event delivery and CI reporting**: routing WebSocket health requires an
  application heartbeat, direct webhook traffic is rate-limited, and CI creates
  a fresh failure comment only when a check actually fails.
- **Web UI**: dead `/agents` link in the no-models helper (now `/ai-agents`)
  plus a catch-all 404 route; "Planner Studio" tab title; Agent Tank banner
  reframed to rate-limit capacity; human-readable API error messages;
  actionable empty states; contextual docs links from Settings.
- **Docs/config drift**: `.env.example` tunnel hostnames updated to
  `t-<id>.propr.dev`; Node.js 22+ requirement stated consistently; stale
  OpenCode `CLI_VERSION` and `WORKER_CONCURRENCY` default corrected.
- **Agent login reliability**: normalize managed credential ownership, remove
  stack-scoped orphan login containers on startup, pull missing agent images,
  preserve split terminal escape sequences, accept agent aliases consistently,
  renew active sessions, and harden dialog lifecycle and keyboard behavior.

### Security

- The production API now mounts the Docker socket to create short-lived,
  authenticated agent-login containers. Docker-socket access is root-equivalent
  host access; deployment and security documentation now call out this trust
  boundary explicitly.
- OAuth state is validated, strong session secrets are mandatory, WebSocket
  subscriptions are authenticated, public API and webhook routes are
  rate-limited, and direct API runs bind to loopback by default.
- Untrusted input parsing and repository filesystem paths are bounded and
  contained; subprocesses execute without a shell; failed uploads are cleaned
  up; agent containers receive explicit resource limits; and local CLI state is
  created with private permissions.
- CodeQL and dependency-review gates now run in CI, preview checkouts are pinned,
  vulnerable transitive dependencies were refreshed, and a security policy was
  added.

## [0.8.5] - 2026-06-30

### Added

- **Hosted UI tunnel (ProPR Connect)**: optional CLI-managed `cloudflared`
  sidecar that exposes a local stack to the hosted UI at `app.propr.dev` through
  a per-instance `https://t-<id>.propr.dev` proxy. Includes shared tunnel
  constants, `propr tunnel on|off|verify`, tunnel diagnostics in `propr status`
  (and `--json`), runtime-configurable UI API base URL, and `.env.example`
  guidance. The tunnel only routes `/api/*` and `/socket.io/*`; the proxy root
  intentionally returns 404. See the hosted UI tunnel docs for setup.
- **`/api/compatibility` endpoint**: a new, intentionally unauthenticated API
  route that returns non-sensitive build metadata (`version`,
  `apiCompatibility`, `uiCompatibility`) so the hosted UI can detect an
  incompatible local stack before login. It exposes no user or repository data;
  operators evaluating their unauthenticated API surface should note that the
  exact release version is now readable pre-auth.

### Changed

- **Explicit routing delivery acknowledgements**: the routing WebSocket intake
  service now ACKs each forwarded GitHub delivery with an authoritative
  `status` (`accepted`, `blocked`, or `ignored`), plus an optional `reason`
  (e.g. `unsupported_event`, `user_not_allowed`, `limit_reached`) and `billing`
  metadata. The webhook dispatcher may return a disposition to drive this;
  returning nothing is treated as a plain `accepted`. ProPR remains the only
  source of truth for repo/user policy; the relay forwards every eligible-looking
  trigger and records the result. See the ProPR Connect docs for the delivery
  acknowledgement contract.
- `propr check --json` remains machine-readable but now reports the additional
  check rows introduced by the grouped check output, including CLI version and
  configured agent validation rows.
- `propr start` now verifies ProPR-published service image freshness and may
  pull a stale local tag before starting; use `PROPR_SKIP_REMOTE_IMAGE_CHECK=1`
  to skip registry probes in offline or latency-sensitive environments.
- **CORS scheme hardening**: the shared CORS origin validator now only trusts
  `http:`/`https:` origins on its cookie-domain and localhost branches, so an
  unusual scheme (e.g. `file:`, `chrome-extension:`) on a cookie-domain
  subdomain or on `localhost`/`127.0.0.1` is no longer allowed. `http:` is
  deliberately still accepted for cookie-domain subdomains so existing
  `http://<sub>.<cookie-domain>` PR-preview environments keep working — the
  tunnel work does not change that. Local development and explicit `FRONTEND_URL`
  origins are unaffected.
- **Enqueue failures now propagate from `processDetectedIssue`**: a failure to
  add an issue to the work queue is re-thrown instead of being swallowed, so the
  routing intake path withholds the ACK and the delivery is redelivered. All
  callers handle this: the polling loop catches it per-repository and continues
  to the next cycle, and the direct-webhook handler awaits the processor before
  ACKing so a throw returns HTTP 500 (GitHub then redelivers).

## [0.8.3] - 2026-06-16

### Added

- **OpenCode agent**: first-class support for the OpenCode CLI runtime — Docker
  image and entrypoint, runtime adapter, agent registry registration, frontend
  configuration, ProPR CLI command, model-alias and GitHub-label resolution,
  live-details/task-stream parsing, and dynamic model discovery.
- **Vibe (Mistral) agent**: new Mistral-backed agent with API-key configuration,
  shared-agent registry entry, runtime adapter, and Vibe branding.
- **CLI control plane**: manage the local Docker stack and relay GitHub tokens
  from the `@propr/cli` package; CLI-driven setup is now the primary path.
- **User whitelist gating**: dashboard/CLI access and issue-label triggers can be
  restricted to a configured set of users.
- **Background GitHub session refresh**: expired GitHub session tokens are now
  refreshed in the background (resolves the logout redirect loop).
- **Summarization fallback**: configurable fallback model with quota-aware retry
  so repository indexing survives provider rate limits and outages.
- **Claude Fable 5** model support.
- **Offline full-text documentation search**.
- Extensive documentation: Web UI Guide, Agent Tank usage-tracking guide,
  Secure VPS Deployment tutorial (with optional Cloudflare Zero Trust layer),
  Repository Best Practices guide, CLI control-plane docs, and a rebuilt docs
  home page.

### Changed

- **Renamed the Gemini agent integration to Antigravity** across runtime, Docker
  images, entrypoints, credentials, parsers, model IDs, and documentation; added
  support for the Antigravity CLI runtime.
- Modernized the header system-status menu and compacted the Settings page into
  horizontal rows with numeric inputs.
- Cleaned up dashboard stats tables and humanized model names.
- Codex planner now caps and budgets prompt/context size using the usable input
  window, with priority-based context packing and reduced metadata overhead.
- Epic chains now require a child PR merge before starting the next issue.
- Docker Hub metadata is synced on release (non-blocking).
- Documentation defaults to Claude Opus 4.8 in examples and gives the CLI equal
  footing in setup tutorials.

### Fixed

- Summarization: stop prompt-too-long failures masquerading as parse errors;
  improve fallback parsing and reliability; scope batch limits by model.
- Indexing: recover from partial summarization failures without a full reindex;
  dedupe prioritized jobs; refresh summarization config between batches; cap
  repository summary batch size/file count; skip generated capture artifacts.
- Pricing: correct OpenRouter slugs for `gemini-3.1-pro`, `nemotron-3-ultra`, and
  native `opencode-go/*` models.
- Antigravity: deliver prompts via stdin to avoid `E2BIG`, use CLI display names
  for `--model`, estimate implementation tokens from the full transcript, and
  fix token usage / log filtering.
- Vibe: numerous runtime fixes for live-log streaming, transcript parsing,
  credential loading, container permissions, and token/cost reporting.
- TaskWatcher: fix `EMFILE` error by switching to polling.
- Metrics: stop infinite task-analysis recursion in the analysis processor.
- Fix default GitHub bot username and use the ProPR app bot for system commits.

[Unreleased]: https://github.com/integry/propr/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/integry/propr/compare/v0.8.15...v0.9.0
[0.8.15]: https://github.com/integry/propr/compare/v0.8.14...v0.8.15
[0.8.14]: https://github.com/integry/propr/compare/v0.8.13...v0.8.14
[0.8.13]: https://github.com/integry/propr/releases/tag/v0.8.13
[0.8.12]: https://github.com/integry/propr/releases/tag/v0.8.12
[0.8.11]: https://github.com/integry/propr/releases/tag/v0.8.11
[0.8.10]: https://github.com/integry/propr/releases/tag/v0.8.10
[0.8.9]: https://github.com/integry/propr/releases/tag/v0.8.9
[0.8.8]: https://github.com/integry/propr/releases/tag/v0.8.8
[0.8.7]: https://github.com/integry/propr/releases/tag/v0.8.7
[0.8.5]: https://github.com/integry/propr/releases/tag/v0.8.5
[0.8.3]: https://github.com/integry/propr/releases/tag/v0.8.3
[0.8.2]: https://github.com/integry/propr/releases/tag/v0.8.2
