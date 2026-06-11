# ProPR Grand Test Audit

**Date:** 2026-03-19
**Scope:** Full codebase audit based on 2422 commits, 27 test files (~150 tests), 60+ bug fix commits, and complete source code analysis.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Current Test Coverage Map](#2-current-test-coverage-map)
3. [Bug Fix History Analysis](#3-bug-fix-history-analysis)
4. [Gap Analysis: What's NOT Tested](#4-gap-analysis-whats-not-tested)
5. [Proposed Unit Tests](#5-proposed-unit-tests)
6. [Proposed Integration Tests](#6-proposed-integration-tests)
7. [Proposed E2E Test Improvements](#7-proposed-e2e-test-improvements)
8. [Corner Cases Derived from Bug Fixes](#8-corner-cases-derived-from-bug-fixes)
9. [Potential Improvements & Hardening](#9-potential-improvements--hardening)
10. [Test Infrastructure Improvements](#10-test-infrastructure-improvements)
11. [Priority Matrix](#11-priority-matrix)

---

## 1. Executive Summary

### Current State
- **27 test files**, ~150 tests total
- **Testing framework:** Node.js native `node:test` (no Jest/Vitest)
- **E2E suite:** 24+ tests with real API + GitHub integration
- **Major gap:** Many critical business logic paths have zero test coverage
- **Known issue:** Several test files use `process.exit(0)` to work around module-level initialization hanging (agentRegistry tests)
- **CI/CD:** PR build checks validate lint + Docker builds but **do not run tests**

### Critical Findings
1. **Zero tests** for the entire webhook system (checkRunHandler, commentEventHandler, planIssueTracking) — the source of ~40% of all bug fixes
2. **Zero tests** for the auto-merge orchestration, despite 8+ bug fixes in this area
3. **Zero tests** for the PR comment processing job (`processPullRequestCommentJob.ts`), which has complex PR locking, comment batching, and abort logic
4. **Zero tests** for the issue job dispatcher matrix expansion
5. **Zero tests** for the post-processing pipeline (PR creation, validation, retry, cleanup)
6. **Zero tests** for the entire CLI package (40+ commands, no test files exist)
7. **Zero tests** for API route handlers (auth, config, tasks, planner, todos, agents)
8. **Retry handler** (`withRetry`) — fundamental utility used everywhere — has zero tests
9. **Worker state manager** — manages all task lifecycle state — has zero tests

---

## 2. Current Test Coverage Map

### Well-Tested Areas (✅)
| Area | File | Tests | Quality |
|------|------|-------|---------|
| Model name parsing | `modelName.test.ts` | 8 | Excellent - null/undefined/edge cases |
| Model alias resolution | `modelAliases.test.ts` | 6 | Good - case insensitive, legacy patterns |
| Context preview | `contextPreview.test.ts` | 23 | Strong - SQL injection patterns in branch names |
| PR comment generation | `commentGeneration.test.ts` | 4 | Good - missing fields, model mapping |
| Relevance scoring | `relevance.test.ts` | 14 | Good - keyword extraction, score clamping |
| CLI config manager | `cliConfigManager.test.ts` | 13 | Comprehensive - corruption, persistence |
| Worker model-specific | `worker.modelSpecific.test.ts` | 10 | Strong - concurrency, hash delays |
| Repo manager (simple) | `repoManager.simple.test.ts` | 14 | Good - retention, cleanup, edge cases |
| Repo manager (model) | `repoManager.modelSpecific.test.ts` | 15 | Strong - filesystem, naming conventions |
| Worker integration | `worker.integration.test.ts` | 5 | Excellent - real filesystem, concurrency |
| Default branch detection | `defaultBranch.test.ts` | 6 | Good - env vars, priority |
| GitHub service | `githubService.simple.test.ts` | 11 | Good - comment truncation, labels |
| E2E API suite | `e2e.test.ts` | 24+ | Comprehensive - full workflow |

### Partially Tested Areas (⚠️)
| Area | File | Tests | Gap |
|------|------|-------|-----|
| Queue operations | `queue.test.ts` | 5 | Only mocked setup, no failure scenarios |
| Worker (core) | `worker.test.ts` | 8 | Only tag checking, no job processing |
| Daemon | `daemon.test.ts` | 8 | Only issue fetching, not polling or config reload |
| Claude integration | `claude.test.ts` | 8 | Only exports/types, no Docker execution |
| Agent registry | `agentRegistry.test.ts` | 1 active | 15 tests skipped due to hanging |
| Error handler | `errorHandler.test.ts` | 5 | Only wrapper functions, no real error scenarios |
| LLM metrics | `llmMetrics.test.ts` | 6 | Requires live Redis, no failure paths |

### Untested Areas (❌)
| Area | Source Files | Criticality |
|------|-------------|-------------|
| **Webhook system** | `webhookHandler.ts`, `checkRunHandler.ts`, `checkRunHelpers.ts`, `commentEventHandler.ts`, `planIssueTracking.ts` | **CRITICAL** - 40% of bugs |
| **Post-processing** | `issueJobPostProcessing.ts` | **CRITICAL** - PR creation, retry, cleanup |
| **PR comment job** | `processPullRequestCommentJob.ts` | **HIGH** - PR locking, comment batching |
| **Issue job dispatcher** | `issueJobDispatcher.ts` | **HIGH** - matrix expansion, deduplication |
| **Issue job modules** | `issueJob/agent.ts`, `context.ts`, `github.ts`, `completion.ts`, `worktree.ts` | **HIGH** |
| **Epic PR service** | `epicPRService.ts` | **HIGH** - 4 bug fixes |
| **Task execution service** | `taskExecutionService.ts` | **HIGH** - issue creation, comments |
| **Analysis service** | `analysisService.ts` | **MEDIUM** - commit hash polling |
| **Retry handler** | `retryHandler.ts` | **HIGH** - used by everything |
| **Worker state manager** | `workerStateManager.ts` | **HIGH** - all task state |
| **Git operations** | `worktreeCreation.ts`, `worktreeOperations.ts`, `commitOperations.ts`, `fetchOperations.ts`, `repoBranching.ts` | **HIGH** |
| **Planning services** | `previewService.ts`, `contextRegeneration.ts`, `planningHelpers.ts` | **MEDIUM** |
| **Codex helpers** | `codexHelpers.ts` | **MEDIUM** - stream parsing |
| **Config loader** | `daemon/configLoader.ts` | **MEDIUM** |
| **Issue detection** | `daemon/issueDetection.ts` | **MEDIUM** |
| **Plan issue manager** | `planIssueManager.ts` | **MEDIUM** - DB operations |
| **API routes** | All route handlers | **MEDIUM** |
| **CLI commands** | All 40+ commands | **LOW** (UI layer) |
| **Frontend** | All React components | **LOW** (UI layer) |

---

## 3. Bug Fix History Analysis

### Bug Fix Categories (from 60+ fix commits)

#### Category 1: Race Conditions & Status Downgrades (12 fixes)
These are the most dangerous bugs — they cause silent data corruption.

| Commit | Bug | Root Cause |
|--------|-----|------------|
| `3cec788d` | Merged PR status reset to `under_review` | Delayed PR 'opened' event arrived after merge |
| `fe8ca8b4` | Next issue not triggered on merge | Previous fix skipped `handleMergedPRNextIssueTrigger` |
| `d8f813a2` | Comment on merged PR reverted status to `in_refinement` | No terminal state guard in comment handler |
| `4c5b048f` | Epic PR overwrote plan issue PR links | Epic PR references child issues, linked to wrong PR |
| `a343c8ab` | Merged status downgraded to closed | GitHub auto-closes linked issue, triggering status update |
| `3cec788d` | Race between PR events and merge events | No terminal state guard in `determinePRStatusUpdate` |
| `1786cb0e` | Parallel epic issues caused merge conflicts | All issues triggered simultaneously instead of sequentially |
| `811778b4` | Merging unchecked commits | Check run SHA didn't match current PR head |
| `7c5b5031` | Duplicate child jobs from multiple webhooks | Non-deterministic jobId allowed duplicate creation |
| `6fbedf48` | Duplicate jobs from timestamp in jobId | Each poll cycle created new job bypassing dedup |
| `4cb501ab` | Duplicate jobs in polling | Same root cause as above, in polling module |
| `d35cc24d` | Completed jobs blocking retries | BullMQ kept completed jobs, preventing re-add |

#### Category 2: Git Corruption & Stale State (7 fixes)
| Commit | Bug | Root Cause |
|--------|-----|------------|
| `7143b852` | Corrupted clone not recovered | No corruption detection or auto-cleanup |
| `c4f0dfd3` | Checkout failed on corrupted repo | No re-clone on checkout corruption |
| `149ba58f` | Clone failed on stale directory | Directory without `.git` from failed clone |
| `bb44e30f` | Stale branch state in worktrees | `git fetch origin branch` didn't update remote refs |
| `f2daec8a` | Merge conflict in repoManager | Manual conflict resolution needed |
| `c0857681` | Another merge conflict in repoManager | Same |
| `674359df` | Merge conflict in planIssueTracking | Same |

#### Category 3: Post-Processing & PR Creation (6 fixes)
| Commit | Bug | Root Cause |
|--------|-----|------------|
| `0f57c63f` | Unnecessary PR retry when no changes | Missing `commitResult` null check |
| `f916089b` | Missing PR label when Claude creates PR directly | Label not added to existing PRs found via fallback |
| `346604a9` | "No changes needed" shown as error | No graceful handling of successful no-change case |
| `2435eae5` | Epic PR checks not waited for | PR creation targeting wrong base |
| `8625415d` | Epic PR creation failed on empty branch | "No commits between" not handled as partial success |
| `b8254bb3` | Unreliable epic PR check deferral | check_run handler not always invoked for epic PRs |

#### Category 4: Infinite Loops & RangeErrors (3 fixes)
| Commit | Bug | Root Cause |
|--------|-----|------------|
| `7b34fa13` | Context preview request loop | V8 RangeError from spreading large objects, re-fetch loop |
| `d758de33` | Context generation infinite retry | Smart summary budget not reduced during retries |
| `eb6a9eb1` | Analysis ran before commit hash populated | Analysis job fired before post-processing finished |

#### Category 5: Pagination & API Edge Cases (3 fixes)
| Commit | Bug | Root Cause |
|--------|-----|------------|
| `be84bda3` | Missing branches in repos with 100+ | Only first page of branches fetched |
| `1a917bbd` | Wrong parameter source for draftId | Read from body instead of URL params |
| `2840e0dc` | PR comments not processed | Processing label bypass not implemented |

#### Category 6: Other (5+ fixes)
| Commit | Bug | Root Cause |
|--------|-----|------------|
| `fb96f8f6` | Codex output parser missing event types | Incomplete event type handling |
| `3b25f2bd` | CLI --json flag not working on subcommands | Commander.js option inheritance issue |
| `3bbc20cb` | File descriptor exhaustion | Docker containers had low ulimits |
| `63918d06` | Auto-merge trigger not logged | Missing observability |
| `7a4055ec` | Planner retry and epic branch targeting | Multiple issues in planning flow |

---

## 4. Gap Analysis: What's NOT Tested

### 4.1 Critical Pure Functions with Zero Coverage

These functions contain complex logic that has historically produced bugs, yet have no tests:

1. **`determinePRStatusUpdate(action, merged, currentStatus)`** in `planIssueTracking.ts`
   - Pure function returning new status or null
   - 3 bug fixes targeting this exact function
   - Terminal state guard added after race condition bug

2. **`isGitCorruptionError(error)`** in `repoManager.ts`
   - Pure regex matching against 11 corruption patterns
   - Added after 2 corruption-related bugs

3. **`calculateUsageLimitDelay(error)`** in `issueJobHelpers.ts`
   - Pure mathematical calculation with jitter
   - Critical for rate limit recovery

4. **`categorizeError(errorMessage)`** in `issueJobHelpers.ts`
   - Pure string matching for error classification
   - Used in error reporting

5. **`getTaskCompletionStatus(claudeResult, postProcessingResult)`** in `completion.ts`
   - Pure status determination
   - Drives final task state

6. **`determineResultStatus(claudeResult, postProcessingResult)`** in `issueJobHelpers.ts`
   - Same pattern, different context

7. **`toClaudeResult(response)` / `agentResultToClaudeResponse(result)`** in `agent.ts`
   - Pure field mapping between agent result types

8. **`resolveCommitMessage(commitMessage, issueNumber, issueTitle)`** in `commitOperations.ts`
   - Handles 3 input formats (object, string, fallback)

9. **`parseCodexStreamOutput(stdout)`** in `codexHelpers.ts`
   - Complex state machine parsing newline-delimited JSON
   - 1 bug fix for missing event types

10. **`calculateDelay()` / `isRetryableError()`** in `retryHandler.ts`
    - Exponential backoff calculation with jitter
    - Error classification for retry decisions

11. **`truncatePlanName(planName)` / `generateEpicBranchName()`** in `epicPRService.ts`
    - Branch name generation with collision prevention

12. **`extractCommitHashFromMetadata(metadata)`** in `analysisService.ts`
    - Extracts hash from 7 different nested metadata paths

### 4.2 Critical Stateful Logic with Zero Coverage

1. **`triggerNextPendingIssue()`** — sequential issue processing guard
2. **`handlePlanPRUpdate()`** — PR event → plan issue status update
3. **`handlePlanIssueStatusUpdate()`** — issue event → plan issue status update
4. **`handlePlanPRCommentTracking()`** — comment event → refinement tracking
5. **`linkPRToReferencedPlanIssue()`** — PR body parsing for issue references
6. **`acquirePRLock()` / comment tracking** — Redis-based concurrency control
7. **`handleCheckRunEvent()`** — auto-merge decision tree
8. **`areAllChecksPassing()`** — check run aggregation
9. **`performPostProcessing()`** — entire post-processing pipeline
10. **`handlePRValidation()`** — PR existence validation with retry

---

## 5. Proposed Unit Tests

### 5.1 Plan Issue Status Machine (CRITICAL — test/planIssueTracking.test.ts)

Based on 12 race condition bugs, this is the highest priority:

```
describe('determinePRStatusUpdate')
  ✦ returns "merged" when action=closed and merged=true
  ✦ returns "closed" when action=closed and merged=false
  ✦ returns "under_review" when action=opened
  ✦ returns null when currentStatus is "merged" (terminal guard)
  ✦ returns null when currentStatus is "closed" (terminal guard)
  ✦ returns "under_review" when action=reopened
  ✦ returns "under_review" when action=synchronize
  ✦ handles unknown action gracefully

describe('handlePlanIssueStatusUpdate')
  ✦ transitions pending → processing when labeled with processing label
  ✦ does NOT downgrade merged → closed when issue auto-closed
  ✦ transitions to closed only when status is not already merged
  ✦ handles reopened issues correctly
  ✦ ignores non-processing labels

describe('handlePlanPRUpdate')
  ✦ skips Epic PRs (title starts with [Epic])
  ✦ links PR to referenced plan issue on PR opened
  ✦ does NOT overwrite existing PR link with different PR number
  ✦ triggers next issue when PR merged with auto-merge label
  ✦ triggers next issue even when status was already set to merged (race condition)
  ✦ skips next issue trigger when other issues are in progress
  ✦ warns when merged but draft_id is missing

describe('handlePlanPRCommentTracking')
  ✦ skips bot comments
  ✦ skips when plan issue status is merged
  ✦ skips when plan issue status is closed
  ✦ increments followup count on human comment
  ✦ sets status to in_refinement on comment

describe('triggerNextPendingIssue')
  ✦ finds and labels next pending issue
  ✦ skips when issues are in progress (processing, under_review, in_refinement, refinement_processing)
  ✦ preserves epic label (base-*) when triggering next
  ✦ adds auto-merge label when present on current issue
  ✦ does nothing when no pending issues remain
```

### 5.2 Git Corruption Detection (HIGH — test/gitCorruption.test.ts)

```
describe('isGitCorruptionError')
  ✦ detects "invalid index-pack output"
  ✦ detects "not a git repository"
  ✦ detects "bad object"
  ✦ detects "missing blob/tree/commit"
  ✦ detects "corrupted" in various positions
  ✦ detects "broken link"
  ✦ detects "invalid sha1"
  ✦ does NOT flag normal git errors (merge conflict, dirty working tree)
  ✦ does NOT flag network errors (timeout, connection refused)
  ✦ handles null/undefined error message
```

### 5.3 Retry Handler (HIGH — test/retryHandler.test.ts)

```
describe('calculateDelay')
  ✦ applies exponential backoff (2^attempt * baseDelay)
  ✦ applies jitter within ±25%
  ✦ caps at maxDelay
  ✦ first attempt has baseDelay
  ✦ never returns negative delay

describe('isRetryableError')
  ✦ retries on ECONNRESET, ETIMEDOUT, ECONNREFUSED
  ✦ retries on status 429 (rate limit)
  ✦ retries on status 500, 502, 503, 504
  ✦ retries on "rate limit" in message
  ✦ retries on "could not resolve to a node" (GitHub propagation)
  ✦ retries on "unprocessable.*node" pattern
  ✦ retries on authentication failures
  ✦ does NOT retry on 400, 401, 403, 404, 422
  ✦ does NOT retry on unknown errors without retryable patterns

describe('withRetry')
  ✦ returns result on first attempt success
  ✦ retries and succeeds on second attempt
  ✦ exhausts all attempts and throws final error
  ✦ throws immediately on non-retryable error (no waiting)
  ✦ respects maxAttempts configuration
  ✦ passes correlationId through
  ✦ calls operation correct number of times
```

### 5.4 Worker State Manager (HIGH — test/workerStateManager.test.ts)

```
describe('createTaskState')
  ✦ creates state in Redis with correct TTL
  ✦ creates task record in database
  ✦ publishes task update event
  ✦ handles database insert failure gracefully (continues)

describe('updateTaskState')
  ✦ transitions state and appends to history
  ✦ throws when task not found in Redis
  ✦ publishes update event with previous state

describe('markTaskFailed')
  ✦ sets state to FAILED with error metadata
  ✦ defaults errorCategory to 'unknown'
  ✦ does not update if already in terminal state

describe('markTaskCancelled')
  ✦ sets state to CANCELLED with cancelledBy
  ✦ stores cancellation reason

describe('markTaskCompleted')
  ✦ sets state to COMPLETED with PR details
  ✦ includes commit result

describe('getResumableTask')
  ✦ returns task in PROCESSING state
  ✦ returns task in CLAUDE_EXECUTION state
  ✦ returns task in POST_PROCESSING state
  ✦ marks stale if last updated >30min ago
  ✦ returns null for COMPLETED/FAILED/CANCELLED

describe('cleanupOldTasks')
  ✦ removes tasks older than maxAge
  ✦ skips tasks in processing states
  ✦ handles corrupted JSON gracefully
```

### 5.5 Post-Processing Pipeline (HIGH — test/issueJobPostProcessing.test.ts)

```
describe('performPostProcessing')
  ✦ commits changes and creates PR on success
  ✦ handles "no code changes" case — posts success, triggers next plan issue
  ✦ handles commit failure gracefully
  ✦ catches PR creation failure and posts error comment
  ✦ checks cancellation after push, before PR creation
  ✦ enables auto-merge when label present
  ✦ links PR to plan issue

describe('handlePRValidation')
  ✦ returns existing result when PR found
  ✦ retries PR creation when claude succeeded and commits exist
  ✦ skips retry when commitResult is null (no changes case — bug fix 0f57c63f)
  ✦ returns null when no worktreeInfo

describe('triggerNextPlanIssueIfNeeded')
  ✦ triggers next issue when current has auto-merge label
  ✦ skips when issue is not part of a plan (no draft_id)
  ✦ skips when other issues are in progress
  ✦ preserves epic label on next issue

describe('cleanupWorktreeIfExists')
  ✦ keeps branch on failure (deleteBranch: false)
  ✦ deletes branch on success
  ✦ applies retention strategy
```

### 5.6 Issue Job Dispatcher (HIGH — test/issueJobDispatcher.test.ts)

```
describe('handleDispatch')
  ✦ creates child jobs for each agent/model combination
  ✦ creates child jobs for each base branch (base-* labels)
  ✦ uses deterministic jobId for deduplication (bug fix 7c5b5031)
  ✦ falls back to default agent when no LLM labels
  ✦ resolves custom labels from agent registry
  ✦ sets removeOnComplete and removeOnFail on child jobs

describe('label resolution')
  ✦ parses base-* labels for branch targeting
  ✦ parses llm-* labels for model selection
  ✦ resolves custom agent labels
  ✦ handles multiple base + multiple model labels (matrix)
```

### 5.7 Check Run Handler (HIGH — test/checkRunHandler.test.ts)

```
describe('handleCheckRunEvent')
  ✦ merges PR when all checks pass and auto-merge label present
  ✦ skips draft PRs
  ✦ skips when check run conclusion is not success/skipped
  ✦ verifies check SHA matches current PR head (bug fix 811778b4)
  ✦ skips merge when SHA mismatch (newer commits pushed)
  ✦ handles epic PRs — triggers next issue instead of merging
  ✦ deletes branch after successful merge
  ✦ handles merge failure gracefully

describe('areAllChecksPassing')
  ✦ returns true when all checks completed with success
  ✦ returns true when checks are success + skipped mix
  ✦ returns false when any check is in_progress
  ✦ returns false when any check failed
  ✦ returns false when no check runs exist

describe('shouldAutoMergePR')
  ✦ returns true with direct auto-merge label
  ✦ returns true with auto-merge label on linked issue
  ✦ returns false without label
  ✦ returns false for draft PRs
```

### 5.8 Epic PR Service (MEDIUM — test/epicPRService.test.ts)

```
describe('generateEpicBranchName')
  ✦ generates valid branch name with issue ID and plan words
  ✦ truncates plan name to 2 words
  ✦ handles plan name with no alphanumeric characters
  ✦ handles single-word plan name
  ✦ includes random suffix for collision prevention

describe('isEpicBranch')
  ✦ matches valid epic branch pattern
  ✦ rejects non-epic branch names
  ✦ extracts issue ID from epic branch name

describe('ensureEpicPR')
  ✦ creates branch, label, and PR on first call
  ✦ handles "Reference already exists" (branch exists) — continues
  ✦ handles "already_exists" (label exists) — continues
  ✦ handles "pull request already exists" — finds existing PR
  ✦ handles "No commits between" — returns success without PR (bug fix 8625415d)
  ✦ throws on unknown PR creation error
```

### 5.9 Codex Stream Parser (MEDIUM — test/codexHelpers.test.ts)

```
describe('parseCodexStreamOutput')
  ✦ parses agent_message items
  ✦ parses command_execution items
  ✦ parses file_change items
  ✦ handles error events
  ✦ aggregates token usage across turns
  ✦ extracts session and conversation IDs
  ✦ handles non-JSON lines gracefully (bug fix fb96f8f6)
  ✦ handles empty stdout
  ✦ handles unknown event types
```

### 5.10 Analysis Service (MEDIUM — test/analysisService.test.ts)

```
describe('extractCommitHashFromMetadata')
  ✦ extracts from metadata.commitHash
  ✦ extracts from metadata.commit_hash
  ✦ extracts from nested metadata.commitResult.hash
  ✦ extracts hash from GitHub comment body via regex
  ✦ returns null when no hash found
  ✦ handles string metadata (JSON.parse)
  ✦ handles object metadata directly

describe('waitForCommitHash')
  ✦ returns immediately when hash already present
  ✦ polls and returns when hash appears
  ✦ times out after 6 retries (60s)
  ✦ handles task disappearing during polling

describe('compactConversationLog')
  ✦ omits Read/Grep/Glob tool output
  ✦ preserves agent messages
  ✦ handles non-array input
```

### 5.11 Model Aliases — Enhanced (MEDIUM — extend test/modelAliases.test.ts)

```
describe('resolveLlmLabel')  // NEW - the 5-step resolution
  ✦ resolves exact githubLabel match from modelDefinitions
  ✦ resolves agent alias match (e.g., "antigravity" -> default Antigravity model)
  ✦ resolves agent prefix match (e.g., "antigravity-flash" -> specific model)
  ✦ resolves static MODEL_ALIASES (backwards compat)
  ✦ falls back to label as model name
  ✦ returns correct agent type for each resolution path

describe('findMatchingModel')
  ✦ matches exact model ID
  ✦ matches exact shortAlias
  ✦ matches partial model ID (contains)
  ✦ matches partial shortAlias (contains)
  ✦ returns null when no match

describe('getModelShortName')
  ✦ returns correct short name for all 16 models
  ✦ returns 'AI' for unknown model
  ✦ handles undefined input
```

### 5.12 Commit Operations (MEDIUM — test/commitOperations.test.ts)

```
describe('resolveCommitMessage')
  ✦ uses claudeSuggested from object input
  ✦ uses string input as-is
  ✦ generates fallback message from issue info
  ✦ truncates title to 50 chars

describe('validateWorktree')
  ✦ passes for valid worktree (.git file with valid gitdir)
  ✦ fails for missing directory
  ✦ fails for missing .git file
  ✦ fails for .git as directory (not file)
  ✦ fails for missing gitdir path (deleted during execution)
```

### 5.13 Issue Job Helpers (MEDIUM — test/issueJobHelpers.test.ts)

```
describe('categorizeError')
  ✦ categorizes auth, network, git, github_api, timeout errors
  ✦ returns 'unknown_error' for unrecognized patterns

describe('calculateUsageLimitDelay')
  ✦ calculates delay from resetTimestamp
  ✦ defaults to 1 hour when resetTimestamp missing
  ✦ adds buffer and jitter
  ✦ always returns positive value

describe('determineResultStatus')
  ✦ returns 'claude_processing_failed' when claude failed
  ✦ returns 'complete_with_pr' when PR exists
  ✦ returns 'claude_success_no_changes' otherwise

describe('buildClaudeResultSection')
  ✦ handles null claudeResult
  ✦ extracts all fields with safe defaults
```

### 5.14 Config Loader (LOW — test/configLoader.test.ts)

```
describe('loadAllConfigs')
  ✦ loads from environment variables when no CONFIG_REPO
  ✦ loads from config repo when CONFIG_REPO set
  ✦ falls back to env on config repo failure
  ✦ detects bot username via GitHub API
  ✦ falls back to 'propr.dev[bot]' on detection failure

describe('getPrimaryProcessingLabels')
  ✦ parses comma-separated env var
  ✦ defaults to ['AI'] when nothing configured
```

### 5.15 Model Limits (LOW — test/modelLimits.test.ts)

```
describe('getEffectiveTokenLimit')
  ✦ calculates correctly at level 10 (minimum)
  ✦ calculates correctly at level 50 (default)
  ✦ calculates correctly at level 100 (maximum)
  ✦ clamps level to [10, 100]
  ✦ handles agent:model format (extracts model part)
  ✦ falls back to default for unknown models

describe('getModelHardLimit')
  ✦ returns 98% of model max tokens
  ✦ handles all 16 known models
```

### 5.16 Planning Helpers (LOW — test/planningHelpers.test.ts)

```
describe('validatePromptTokens')
  ✦ passes when under limit
  ✦ fails when over limit
  ✦ uses API validation when >80% of limit (conservative)
  ✦ falls back to tiktoken when API fails

describe('calculateCostEstimate')
  ✦ calculates from pricing API
  ✦ falls back to formula when pricing unavailable
  ✦ applies model-specific token ratios (Gemini 1.1x, Claude 1.36x)
```

---

## 6. Proposed Integration Tests

### 6.1 PR Comment Processing Job (test/prCommentJob.integration.test.ts)

```
describe('PR lock acquisition')
  ✦ acquires lock successfully (Redis SET NX)
  ✦ reschedules job when lock held by another worker
  ✦ re-enters lock when held by same worker
  ✦ releases lock in finally block (even on error)
  ✦ lock has correct TTL (3600s)

describe('comment validation')
  ✦ filters out bot comments
  ✦ filters out already-processed comments (Redis tracking)
  ✦ detects bot completion marker in subsequent comments
  ✦ handles comment deleted between validation and processing

describe('batch comment processing')
  ✦ processes multiple comments on same PR as batch
  ✦ applies batch delay correctly
  ✦ handles comment edit → abort + reprocess
```

### 6.2 Issue Detection & Deduplication (test/issueDetection.integration.test.ts)

```
describe('processDetectedIssue')
  ✦ enqueues job with deterministic jobId (no timestamp)
  ✦ skips when parent job already exists
  ✦ allows child jobs alongside parent
  ✦ filters out issues with exclude labels (AI-processing, AI-done)
  ✦ sets removeOnComplete and removeOnFail

describe('fetchIssuesForRepo')
  ✦ filters out pull requests
  ✦ deduplicates across multiple primary labels
  ✦ handles 403 rate limit errors gracefully
  ✦ handles both string and object label formats
```

### 6.3 Worktree Lifecycle (test/worktreeLifecycle.integration.test.ts)

```
describe('worktree creation')
  ✦ creates worktree with proper structure (.git file, gitdir)
  ✦ handles existing worktree path (cleanup + recreate)
  ✦ handles "branch already checked out" conflict
  ✦ uses explicit refspec for fetch (bug fix bb44e30f)
  ✦ verifies final worktree setup (origin remote exists)

describe('worktree cleanup')
  ✦ removes worktree and optionally branch
  ✦ applies retention strategy: always_delete, keep_on_failure, keep_for_hours
  ✦ creates retention marker for deferred cleanup
  ✦ cleans up expired worktrees based on age
  ✦ does NOT prune active worktrees (race condition guard)

describe('safe pruning')
  ✦ prunes stale worktree metadata entries
  ✦ respects age threshold (minAgeHours)
  ✦ detects missing worktree directories
  ✦ skips entries without gitdir file if too young
```

### 6.4 Queue Metrics & Job Lifecycle (test/queueMetrics.integration.test.ts)

```
describe('job completion metrics')
  ✦ increments processed count
  ✦ calculates rolling average execution time
  ✦ adds repository to active set
  ✦ logs AI metrics with cost extraction

describe('job failure metrics')
  ✦ increments failed count
  ✦ truncates error message to 100 chars
  ✦ logs error with timestamp

describe('activity logging')
  ✦ pushes activity to list
  ✦ trims to last 1000 entries
```

---

## 7. Proposed E2E Test Improvements

### 7.1 Webhook Event Simulation (test/e2e/webhook.test.ts)

Currently the E2E suite only tests the REST API. Add webhook simulation:

```
describe('webhook: issue events')
  ✦ labeled event triggers issue detection
  ✦ closed event updates plan issue status
  ✦ reopened event transitions back from closed

describe('webhook: pull request events')
  ✦ opened event links PR to plan issue
  ✦ merged event triggers next plan issue
  ✦ synchronize event updates status

describe('webhook: check run events')
  ✦ completed+success triggers auto-merge check
  ✦ check on outdated SHA is ignored

describe('webhook: comment events')
  ✦ trigger keyword enqueues comment job
  ✦ edited comment aborts existing job
  ✦ deleted comment cancels processing
```

### 7.2 Plan Lifecycle E2E (enhance test/e2e.test.ts)

```
describe('plan: sequential processing')
  ✦ Epic PR auto-merge only triggers the first pending issue
  ✦ subsequent issues triggered after each PR merge
  ✦ in-progress issues block next trigger

describe('plan: no-changes scenario')
  ✦ claude succeeds but no code changes → success comment posted
  ✦ next plan issue triggered even without PR
```

### 7.3 Error Recovery E2E

```
describe('task recovery')
  ✦ task can be stopped mid-execution
  ✦ stopped task posts cancellation notice
  ✦ task can be re-triggered after failure (label re-add)
  ✦ rate-limited task is requeued with delay
```

---

## 8. Corner Cases Derived from Bug Fixes

Each bug fix implies a corner case that should be tested. This is the **most important section** — these are real-world scenarios that have caused production issues.

### 8.1 Race Conditions to Test

| # | Corner Case | Derived From | Test Strategy |
|---|------------|--------------|---------------|
| 1 | PR `opened` event arrives after `merged` event | `3cec788d` | Mock webhook events out of order |
| 2 | GitHub auto-closes issue after PR merge → closed event | `a343c8ab` | Simulate close event when status=merged |
| 3 | Comment posted on already-merged PR | `d8f813a2` | Simulate comment event when status=merged |
| 4 | Epic PR references child issues that already have PR links | `4c5b048f` | Create plan issue with existing PR, then simulate Epic PR opened |
| 5 | Two webhook events for same issue arrive simultaneously | `6fbedf48`, `7c5b5031` | Verify deterministic jobId prevents duplicates |
| 6 | Check run completes but new commit pushed since | `811778b4` | Mock getCurrentPRHead returning different SHA |
| 7 | Multiple poll cycles before AI-processing label added | `4cb501ab` | Simulate 3 polls for same issue |
| 8 | Config reload while job is processing | Source analysis | Publish config event during mock execution |

### 8.2 Git Corruption Scenarios to Test

| # | Corner Case | Derived From | Test Strategy |
|---|------------|--------------|---------------|
| 9 | Clone produces corrupted repository | `7143b852` | Mock git clone throwing corruption error |
| 10 | Checkout fails with "not a git repository" | `c4f0dfd3` | Mock git checkout throwing corruption error |
| 11 | Directory exists without .git from failed clone | `149ba58f` | Create directory without .git, call ensureRepoCloned |
| 12 | `git fetch origin branch` doesn't update remote refs | `bb44e30f` | Verify explicit refspec used |
| 13 | Worktree .git is directory instead of file | Source analysis | Create malformed worktree structure |
| 14 | Worktree gitdir path deleted during execution | Source analysis | Delete gitdir between create and validate |

### 8.3 Post-Processing Edge Cases to Test

| # | Corner Case | Derived From | Test Strategy |
|---|------------|--------------|---------------|
| 15 | Claude succeeds but no code changes made | `346604a9`, `0f57c63f` | commitResult=null, claudeResult.success=true |
| 16 | PR creation fails, existing PR found on branch | `f916089b` | Mock octokit.request POST failing, GET succeeding |
| 17 | Existing PR has wrong base branch | Source analysis | Mock PR with different base, verify PATCH update |
| 18 | Issue is cancelled between agent execution and PR creation | Source analysis | Set task state to CANCELLED during mock |
| 19 | Epic PR creation when no commits exist on branch | `8625415d` | Mock 422 "No commits between" |
| 20 | Deferred epic PR check was unreliable | `b8254bb3` | Verify triggerNextPendingIssue called immediately |

### 8.4 Planning & Context Edge Cases to Test

| # | Corner Case | Derived From | Test Strategy |
|---|------------|--------------|---------------|
| 21 | Context config with thousands of file entries (V8 RangeError) | `7b34fa13` | Large contextCache, verify no spread of full object |
| 22 | Smart summary budget not reduced during retry | `d758de33` | Verify budget decreases each iteration |
| 23 | Analysis job runs before commit hash saved | `eb6a9eb1` | Verify waitForCommitHash polls correctly |
| 24 | Repository has 100+ branches | `be84bda3` | Mock paginated branch response |
| 25 | draftId read from body instead of URL params | `1a917bbd` | Verify URL param extraction |

### 8.5 Queue & Deduplication Edge Cases to Test

| # | Corner Case | Derived From | Test Strategy |
|---|------------|--------------|---------------|
| 26 | Completed job blocks future retry (label re-add) | `d35cc24d` | Verify removeOnComplete: true |
| 27 | Multiple labels added → multiple webhooks → duplicate jobs | `6fbedf48` | Add 3 labels, verify only 1 job created |
| 28 | Child job deduplication across webhook events | `7c5b5031` | Two dispatchers for same issue, verify no duplicate children |

---

## 9. Potential Improvements & Hardening

### 9.1 Code Improvements

1. **Extract `determinePRStatusUpdate` to shared pure module** — used in planIssueTracking but not independently testable without importing full module
2. **Extract `isGitCorruptionError` patterns to a config constant** — easier to test and extend
3. **Add TypeScript strict enum for PlanIssueStatus** — prevent invalid status strings
4. **Add input validation on API routes** — several routes lack validation (webhook payload, docker logs tail param, file upload types)
5. **Add rate limiting middleware** — no API rate limiting exists
6. **Add CSRF protection** — auth relies on Passport sessions without explicit CSRF
7. **Escape LIKE wildcards in search queries** — `%` and `_` in search terms pass through to SQLite
8. **Add bounds checking to docker logs tail parameter** — parsed as int but no max
9. **Add file type validation for planner attachments** — accepts any file type
10. **Add structured error types across codebase** — currently uses string matching for error classification

### 9.2 Resilience Improvements

1. **Versioned state updates** — workerStateManager uses last-write-wins with no optimistic locking
2. **Idempotent comment posting** — comment creation in post-processing can create duplicates if job retries
3. **Bounded retry in analysisService.waitForCommitHash** — currently fixed 6×10s, should use exponential backoff
4. **Graceful Redis disconnection in abort checker** — dockerExecutor's abort polling silently returns false if Redis unavailable
5. **Comment pagination in systemTaskJob** — cascade delete fetches 100 comments per page but may miss later pages for high-comment PRs
6. **Concurrent task stop requests** — no lock on stop endpoint, multiple simultaneous stops could race
7. **Token in authenticated URLs** — auth tokens embedded in git remote URLs should be cleared after operation

### 9.3 Observability Improvements

1. **Add metrics for retry attempts** — withRetry logs but doesn't emit metrics
2. **Add alert on repeated corruption errors** — same repo hitting corruption patterns repeatedly
3. **Add timing metrics for webhook processing** — currently no latency tracking
4. **Track comment batch sizes** — understand how often batching occurs
5. **Add structured tracing for plan issue status transitions** — audit trail for debugging race conditions

---

## 10. Test Infrastructure Improvements

### 10.1 Fix Module-Level Initialization Hanging

**Problem:** `agentRegistry.test.ts` has 15 tests skipped because importing `@propr/core` triggers Redis/BullMQ connections that never close, causing the test process to hang.

**Fix options:**
1. Lazy-initialize Redis connections (only connect when first used)
2. Create a test-mode initialization that skips connection setup
3. Use `mock.module()` to mock Redis/BullMQ at module level before imports

### 10.2 Add Test Running to CI

**Current state:** CI validates lint and Docker builds but **does not run tests**.
Running the full suite on every PR push would be too slow (Docker-based integration tests, E2E with live GitHub). Instead, use a layered approach:

#### Tier 1: Fast unit tests — non-blocking on every PR (path-filtered)

Add a lightweight test step to `pr-build-check.yml` that runs only pure-function unit tests. These have no Redis/Docker/GitHub dependencies and complete in seconds. Run with `continue-on-error: true` so it reports but doesn't block merges.

```yaml
# Inside the "Run Checks" step, after existing lint/build sections:

# --- UNIT TESTS (non-blocking) ---
if [ "${{ steps.filter.outputs.core }}" == 'true' ] || \
   [ "${{ steps.filter.outputs.core_package }}" == 'true' ] || \
   [ "${{ steps.filter.outputs.api }}" == 'true' ]; then
  echo -e "\n--- Unit Tests (non-blocking) ---" >> build_log.txt
  # Run only fast pure-function tests (no Redis/Docker needed)
  TEST_OUTPUT=$(npx tsx --test \
    test/modelName.test.ts \
    test/modelAliases.test.ts \
    test/contextPreview.test.ts \
    test/commentGeneration.test.ts \
    test/relevance.test.ts \
    test/defaultBranch.test.ts \
    test/githubService.simple.test.ts \
    test/repoManager.simple.test.ts \
    test/errorHandler.test.ts \
    test/prValidation.test.ts \
    test/resolveProject.test.ts \
    test/minimal.test.ts \
    2>&1) || {
    echo "⚠️ Unit Tests FAILED (non-blocking)" >> build_log.txt
    echo "$TEST_OUTPUT" | tail -30 >> build_log.txt
  }
  if [ $? -eq 0 ]; then
    echo "✅ Unit Tests passed" >> build_log.txt
  fi
fi
```

As new P0/P1 pure-function tests are written (retryHandler, gitCorruption, planIssueStatus, etc.), add them to this list.

#### Tier 2: Label-triggered full test suite on PRs

Add a separate workflow that runs the full test suite when a `run-tests` label is added to a PR. This lets developers opt-in to full validation on risky changes.

Create `.github/workflows/pr-test-on-label.yml`:

```yaml
name: Test Suite (on label)

on:
  pull_request:
    types: [labeled]

jobs:
  test-full:
    if: github.event.label.name == 'run-tests'
    name: Full Test Suite
    runs-on: ubuntu-latest
    services:
      redis:
        image: redis:7
        ports:
          - 6379:6379
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - run: npm ci

      - name: Run unit tests
        run: npx tsx --test test/*.test.ts
        env:
          NODE_ENV: test
          REDIS_HOST: localhost
          REDIS_PORT: 6379
        continue-on-error: true

      - name: Remove label
        if: always()
        uses: actions/github-script@v7
        with:
          script: |
            try {
              await github.rest.issues.removeLabel({
                owner: context.repo.owner,
                repo: context.repo.repo,
                issue_number: context.issue.number,
                name: 'run-tests'
              });
            } catch (e) { /* label already removed */ }
```

#### Tier 3: Manual dispatch + nightly schedule

Add a workflow for on-demand and scheduled runs of the full suite including E2E:

Create `.github/workflows/test-nightly.yml`:

```yaml
name: Nightly Test Suite

on:
  schedule:
    - cron: '0 3 * * *'  # 3 AM UTC daily
  workflow_dispatch:       # Manual trigger button

jobs:
  test-full:
    name: Full Test Suite
    runs-on: ubuntu-latest
    services:
      redis:
        image: redis:7
        ports:
          - 6379:6379
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - run: npm ci

      - name: Unit & integration tests
        run: npx tsx --test test/*.test.ts
        env:
          NODE_ENV: test
          REDIS_HOST: localhost
          REDIS_PORT: 6379

      - name: E2E tests
        if: github.event_name == 'workflow_dispatch'
        run: npm run test:e2e
        env:
          NODE_ENV: test
          REDIS_HOST: localhost
          REDIS_PORT: 6379
          # E2E needs PROPR_API_URL and GITHUB_TOKEN from secrets

      - name: Post failure issue
        if: failure() && github.event_name == 'schedule'
        uses: actions/github-script@v7
        with:
          script: |
            const runUrl = `https://github.com/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`;
            await github.rest.issues.create({
              owner: context.repo.owner,
              repo: context.repo.repo,
              title: `Nightly test suite failed (${new Date().toISOString().split('T')[0]})`,
              body: `The nightly test run failed. [View logs](${runUrl})`,
              labels: ['bug', 'tests']
            });
```

#### Summary

| Tier | Trigger | Blocking? | Scope | Speed |
|------|---------|-----------|-------|-------|
| 1 | Every PR push (path-filtered) | No | Pure unit tests only | ~10-30s |
| 2 | `run-tests` label on PR | No | All unit + integration | ~2-5min |
| 3a | Manual dispatch (Actions tab) | N/A | Full suite + optional E2E | ~5-15min |
| 3b | Nightly schedule (3 AM UTC) | N/A | Full suite, creates issue on failure | ~5-15min |

### 10.3 Create Test Utilities

**Needed helpers:**
1. **Mock Octokit factory** — reusable across all GitHub API tests
2. **Mock Redis factory** — for state manager, metrics, comment tracking tests
3. **Webhook event factory** — generates realistic webhook payloads for each event type
4. **Plan issue factory** — creates plan issues in various states for testing
5. **Task state factory** — creates task states in various lifecycle stages

### 10.4 Test Database

**Current state:** `llmMetrics.test.ts` requires live Redis. Many proposed tests need database.

**Recommendation:**
1. Use in-memory SQLite for unit/integration tests (`':memory:'`)
2. Run migrations before each test suite
3. Create seed data factories for common scenarios

### 10.5 Parallel Test Execution

**Current state:** Tests run sequentially.

**Recommendation:** Node.js `node:test` supports `--concurrency` flag. Tests that don't share state can run in parallel. Tests using shared Redis/DB should run sequentially.

---

## 11. Priority Matrix

### P0 — Must Have (blocks production reliability)

| Test Suite | Estimated Tests | Effort | Justification |
|-----------|----------------|--------|---------------|
| Plan issue status machine | 25 | Medium | 12 race condition bugs in this area |
| Check run handler / auto-merge | 15 | Medium | 8 bug fixes, silent merge failures |
| Post-processing pipeline | 15 | Medium | 6 bug fixes, PR creation failures |
| Retry handler | 12 | Low | Foundational utility, used everywhere |
| Git corruption detection | 10 | Low | Pure function, 7 related bug fixes |

### P1 — Should Have (high risk, significant logic)

| Test Suite | Estimated Tests | Effort | Justification |
|-----------|----------------|--------|---------------|
| Issue job dispatcher | 10 | Medium | Matrix expansion, deduplication |
| Worker state manager | 20 | Medium | All task lifecycle state |
| Epic PR service | 12 | Medium | 4 bug fixes |
| Issue detection & deduplication | 12 | Medium | Dedup logic, label filtering |
| Worktree lifecycle | 15 | High | Filesystem, cleanup, retention |
| Issue job helpers (pure functions) | 12 | Low | Error categorization, delay calc |

### P2 — Nice to Have (reduces risk, improves confidence)

| Test Suite | Estimated Tests | Effort | Justification |
|-----------|----------------|--------|---------------|
| PR comment job (lock, batch, abort) | 15 | High | Complex concurrency |
| Codex stream parser | 10 | Medium | Bug fix, complex parsing |
| Analysis service | 10 | Medium | Commit hash extraction |
| Model aliases (resolveLlmLabel) | 12 | Low | 5-step resolution |
| Planning helpers | 8 | Medium | Token validation, cost |
| Commit operations | 8 | Low | Message resolution |
| Config loader | 8 | Low | Fallback chains |
| Model limits | 8 | Low | Token calculations |

### P3 — Future (defensive, completeness)

| Test Suite | Estimated Tests | Effort | Justification |
|-----------|----------------|--------|---------------|
| API route handlers | 40+ | High | Input validation, auth |
| CLI commands | 30+ | High | Argument parsing, display |
| Webhook event simulation (E2E) | 20 | High | Full event flow |
| Frontend components | 50+ | Very High | React component testing |

---

### Total Estimated New Tests

| Priority | Tests | Effort |
|----------|-------|--------|
| P0 | ~77 | ~2 weeks |
| P1 | ~81 | ~3 weeks |
| P2 | ~71 | ~3 weeks |
| P3 | ~140+ | ~6+ weeks |
| **Total** | **~369+** | **~14+ weeks** |

---

*This audit document should be used as a living reference. As tests are implemented, mark sections as complete. As new bugs are found, add them to Section 3 and derive new test cases in Section 8.*
