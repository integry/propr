import { PR_STATUS_BLOCK_MAX_LENGTH } from '@propr/shared';
import type {
    EpicStatusFocus, PullRequestActivity, PullRequestAttentionReason, PullRequestCiRunnerProblem, PullRequestStatus, PullRequestStatusDetail,
} from './pullRequestStatus.js';

/**
 * The live status block ProPR keeps as the first thing in a pull request body.
 * It is only ever written between its own markers; everything outside them is
 * preserved byte for byte.
 */
export const PR_STATUS_BLOCK_START = '<!-- propr:pr-status -->';
export const PR_STATUS_BLOCK_END = '<!-- /propr:pr-status -->';

/** Separator between the block and the rest of the body. */
const SEPARATOR = '\n\n';
const TRAILING_SEPARATOR_PATTERN = /^\r?\n\r?\n/;
/** The update stamp, with its date ("Nov 16 13:59 UTC") or, as blocks written before the date was added have it, without. */
export const STATUS_TIMESTAMP_PATTERN = / · updated (?:[A-Z][a-z]{2} \d{1,2} )?\d{2}:\d{2} UTC/;
const TIMESTAMP_PATTERN = new RegExp(STATUS_TIMESTAMP_PATTERN.source, 'g');

const ACTIVITY_TEXT: Record<PullRequestActivity, string> = {
    implementing: 'Implementing',
    follow_up: 'Follow-up in progress',
    review: 'Review in progress',
    resolving_conflicts: 'Resolving conflicts',
    ultrafix: 'Ultrafix in progress',
    waiting_for_ci: 'Waiting for CI',
    queued: 'Queued',
    checking_mergeability: 'Checking for conflicts',
};

const REASON_TEXT: Record<PullRequestAttentionReason, string> = {
    last_run_failed: 'last ProPR run failed',
    conflict_resolution_failed: 'conflict resolution failed',
    ultrafix_stopped: 'Ultrafix stopped',
    check_failed: 'checks failed',
    merge_conflict: 'conflicts with base',
    review_below_goal: 'review below goal',
    review_blockers: 'review has open blockers',
    checks_unavailable: 'checks could not be read',
    epic_child_needs_attention: 'a sub-PR needs you',
    epic_child_ready: 'a sub-PR waits to be merged',
    epic_issue_blocked: 'an issue stopped on a blocker',
    epic_children_unread: 'sub-PR status not read',
    epic_queue_paused: 'queue paused',
    epic_idle: 'nothing in progress',
};

const MAX_FAILED_CHECK_NAMES = 3;

function checksText(checks: PullRequestStatus['detail']['checks']): string | null {
    if (!checks) return null;
    // Skipped and cancelled checks neither passed nor failed: they are counted apart, and only when there are any.
    const parts = [
        checks.passed > 0 ? `${checks.passed} passed` : null,
        checks.failed > 0 ? `${checks.failed} failed` : null,
        checks.pending > 0 ? `${checks.pending} pending` : null,
        (checks.skipped ?? 0) > 0 ? `${checks.skipped} skipped` : null,
        (checks.cancelled ?? 0) > 0 ? `${checks.cancelled} cancelled` : null,
    ].filter((part): part is string => part !== null);
    return parts.length > 0 ? `checks: ${parts.join(', ')}` : null;
}

/** Check names come from CI configuration; keep them from breaking the one-line block. */
function inlineName(name: string): string {
    return name.replace(/[\r\n`*_<>|[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}

/**
 * "failed: unit, lint +2": at most `maxNames` names, the rest counted. A name
 * that still holds a workflow expression (`${{ matrix.os }}`) was never
 * expanded and names no check a person can find, so it is only counted.
 */
function namedChecks(label: string, names: readonly string[], maxNames: number): string | null {
    const listed = names.filter(name => !name.includes('${{')).map(inlineName).filter(Boolean).slice(0, maxNames);
    const more = names.length > listed.length ? ` +${names.length - listed.length}` : '';
    return listed.length > 0 ? `${label}: ${listed.join(', ')}${more}` : null;
}

function reasonText(status: PullRequestStatus, maxNames: number): string {
    const { detail } = status;
    if (detail.reason === 'ultrafix_stopped' && detail.ultrafixStopped) {
        const { cycles, finalScore } = detail.ultrafixStopped;
        const score = finalScore !== null ? ` at ${finalScore}/10` : '';
        return `Ultrafix stopped after ${cycles} cycle${cycles === 1 ? '' : 's'}${score}`;
    }
    if (detail.reason === 'check_failed') {
        const cancelled = detail.cancelledChecks ?? [];
        // A cancelled run is no failure; only when nothing failed does the reason name it.
        const named = detail.failedChecks.length > 0 ? namedChecks('failed', detail.failedChecks, maxNames) : namedChecks('cancelled', cancelled, maxNames);
        if (named) return named;
        if (detail.failedChecks.length === 0 && cancelled.length > 0) return 'checks cancelled';
    }
    // One score and the goal it falls short of; the separate review score is left out (reviewScoreText).
    if (detail.reason === 'review_below_goal') {
        return detail.reviewScore !== null ? `review ${detail.reviewScore}/10, goal ${detail.ratingGoal}` : `review below goal ${detail.ratingGoal}`;
    }
    return detail.reason ? REASON_TEXT[detail.reason] : '';
}

const RUNNER_PROBLEM_TEXT: Record<PullRequestCiRunnerProblem['action'], (job: string) => string> = {
    rerun_requested: job => `runner problem in ${job}, re-run requested`,
    rerun_deferred: job => `runner problem in ${job}, re-run when its workflow finishes`,
    rerun_unavailable: job => `${job} failed on what looks like a runner problem, re-run it`,
};

/** The text for a suspension of the head's validation (PullRequestStatusDetail.ciSuspension). */
export const CI_SUSPENDED_TEXT = 'CI suspended until the follow-up finishes, re-running checks before then has no effect';

/**
 * A suspension, and the runs it cancelled; a runner problem and what ProPR did
 * about it. The cancelled count is check progress (pullRequestStatusEditPacing).
 */
function ciNoteParts(detail: PullRequestStatusDetail): string[] {
    const parts: string[] = [];
    if (detail.ciSuspension) {
        parts.push(CI_SUSPENDED_TEXT);
        const runs = detail.ciSuspension.cancelledRuns;
        if (runs > 0) parts.push(`runs cancelled by ProPR: ${runs}`);
    }
    if (detail.ciRunnerProblem) {
        const job = inlineName(detail.ciRunnerProblem.job) || 'a check';
        parts.push(RUNNER_PROBLEM_TEXT[detail.ciRunnerProblem.action](job));
    }
    return parts;
}

const STATE_EMOJI = { working: '🔨', needs_attention: '⚠️', ready: '✅' } as const;

function headline(status: PullRequestStatus): string {
    const { epic } = status.detail;
    if (epic && epic.total > 0 && status.state !== 'none') {
        return `${STATE_EMOJI[status.state]} ${epic.merged} of ${epic.total} issues merged`;
    }
    if (status.state === 'ready') return '✅ Ready';
    if (status.state === 'needs_attention') return '⚠️ Needs you';
    // A running loop names its cycle once: "🔨 Ultrafix cycle 3 of 10", not "Ultrafix in progress · Ultrafix cycle 3 of 10".
    if (ultrafixHeadline(status)) return `🔨 ${ultrafixCycleText(status.detail.ultrafix!)}`;
    return `🔨 ${ACTIVITY_TEXT[status.detail.activity ?? 'queued']}`;
}

function ultrafixHeadline(status: PullRequestStatus): boolean {
    return status.state === 'working' && status.detail.activity === 'ultrafix' && status.detail.ultrafix !== null;
}

function ultrafixCycleText(ultrafix: { cycle: number; maxCycles: number }): string {
    return `Ultrafix cycle ${ultrafix.cycle} of ${ultrafix.maxCycles}`;
}

/** The review score part, unless the reason already states it (review_below_goal) or it describes a stopped loop. */
function reviewScoreText(status: PullRequestStatus, previous: 'last review' | 'review'): string | null {
    const { detail } = status;
    if (detail.reviewScore === null || detail.reason === 'ultrafix_stopped') return null;
    if (status.state === 'needs_attention' && detail.reason === 'review_below_goal') return null;
    return `${previous} ${detail.reviewScore}/10`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * When the status was written, e.g. "Nov 16 13:59 UTC". The block is read
 * long after it is written (it only changes with the status), so it always
 * carries its date: a bare time reads as today's.
 */
export function statusTimestamp(now: Date): string {
    const time = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
    return `${MONTHS[now.getUTCMonth()]} ${now.getUTCDate()} ${time} UTC`;
}


/** What a sub-PR's status says, in a few words: "Ultrafix cycle 4 of 10, last review 6/10", "ready to merge". */
export function describeChildStatus(status: PullRequestStatus | null, order: 'block' | 'comment' = 'block'): string {
    if (!status || status.state === 'none') return '';
    const { detail } = status;
    const lower = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
    const score = reviewScoreText(status, status.state === 'working' && order === 'block' ? 'last review' : 'review');
    let what: string | null;
    if (status.state === 'ready') what = 'ready to merge';
    else if (status.state === 'needs_attention') what = reasonText(status, 0);
    else what = detail.ultrafix ? null : lower(ACTIVITY_TEXT[detail.activity ?? 'queued']);
    const cycle = detail.ultrafix ? ultrafixCycleText(detail.ultrafix) : null;
    // The comment leads with the score, the block with what runs.
    const parts = order === 'comment' ? [score, what, cycle] : [what, cycle, score];
    return parts.filter(Boolean).join(', ');
}

/** Work in progress is named by its issue; a sub-PR waiting on a person by the pull request. */
function epicFocusText(focus: EpicStatusFocus, verb: string, name: 'issue' | 'pull_request'): string {
    const subject = focus.prNumber === null || (name === 'issue' && focus.issueNumber !== null)
        ? `#${focus.issueNumber ?? focus.prNumber}`
        : `#${focus.prNumber}${focus.issueNumber !== null ? ` (issue #${focus.issueNumber})` : ''}`;
    const state = describeChildStatus(focus.status);
    return `${subject} ${verb}${state ? ` (${state})` : ''}`;
}

/** The parts after an epic's headline: what runs, or what waits on a person. */
function epicParts(status: PullRequestStatus, maxNames: number): string[] {
    const { detail } = status;
    const focus = detail.epic?.focus ?? null;
    if (status.state === 'working') {
        if (focus && focus.prNumber === null && detail.activity === 'queued') return [`#${focus.issueNumber} starts next`];
        if (focus) return [epicFocusText(focus, 'in progress', 'issue')];
        return [ACTIVITY_TEXT[detail.activity ?? 'queued']];
    }
    if (detail.reason === 'epic_child_ready' && focus) return [epicFocusText({ ...focus, status: null }, 'waits to be merged into the epic branch', 'pull_request')];
    if (detail.reason === 'epic_child_needs_attention' && focus) return [epicFocusText(focus, 'needs you', 'pull_request')];
    if (detail.reason === 'epic_issue_blocked' && focus) return [epicFocusText(focus, 'stopped on a blocker', 'issue')];
    return [reasonText(status, maxNames)];
}

/** An epic that has every issue merged reads like any pull request: its reason and its own checks. */
function epicStatusLine(status: PullRequestStatus, maxNames: number): string[] {
    const { detail } = status;
    const epic = detail.epic!;
    const parts = [`**ProPR** ${headline(status)}`];
    if (epic.merged >= epic.total) {
        if (status.state === 'needs_attention') parts.push(reasonText(status, maxNames));
        else if (status.state === 'working') parts.push(ultrafixHeadline(status) ? ultrafixCycleText(detail.ultrafix!) : ACTIVITY_TEXT[detail.activity ?? 'queued']);
        const checks = checksText(detail.checks);
        if (checks) parts.push(checks);
        return parts;
    }
    return [...parts, ...epicParts(status, maxNames)];
}

function statusLine(status: PullRequestStatus, now: Date, maxNames: number): string {
    const { detail } = status;
    if (detail.epic && detail.epic.total > 0) return [...epicStatusLine(status, maxNames), `updated ${statusTimestamp(now)}`].filter(Boolean).join(' · ');
    const parts = [`**ProPR** ${headline(status)}`];
    if (status.state === 'needs_attention') parts.push(reasonText(status, maxNames));
    parts.push(...ciNoteParts(detail));
    if (detail.ultrafix && !ultrafixHeadline(status)) parts.push(ultrafixCycleText(detail.ultrafix));
    parts.push(reviewScoreText(status, status.state === 'working' ? 'last review' : 'review') ?? '');
    const checks = status.state === 'needs_attention' && detail.reason === 'ultrafix_stopped' ? null : checksText(detail.checks);
    if (checks) parts.push(checks);
    parts.push(`updated ${statusTimestamp(now)}`);
    return parts.filter(Boolean).join(' · ');
}

const MARKERS_LENGTH = `${PR_STATUS_BLOCK_START}\n\n${PR_STATUS_BLOCK_END}`.length;
/** The longest status line that keeps the block within PR_STATUS_BLOCK_MAX_LENGTH. */
const MAX_LINE_LENGTH = PR_STATUS_BLOCK_MAX_LENGTH - MARKERS_LENGTH;

/**
 * The one-line status text, e.g. "**ProPR** ✅ Ready · review 8/10 · checks: 35 passed, 12 skipped · updated Nov 16 10:02 UTC".
 * Never longer than the block budget: failed check names are dropped first,
 * then the line is cut, so the space new descriptions reserve always holds it.
 */
export function renderPullRequestStatusLine(status: PullRequestStatus, now: Date = new Date()): string {
    for (let names = MAX_FAILED_CHECK_NAMES; names >= 0; names--) {
        const line = statusLine(status, now, names);
        if (line.length <= MAX_LINE_LENGTH) return line;
    }
    const line = statusLine(status, now, 0);
    const stamp = ` · updated ${statusTimestamp(now)}`;
    // The line always ends with the stamp; cut before it, never inside a surrogate pair.
    const cut = line.slice(0, MAX_LINE_LENGTH - stamp.length - 1).replace(/[\uD800-\uDBFF]$/, '');
    return `${cut}…${stamp}`;
}

function wrapBlock(line: string): string {
    return `${PR_STATUS_BLOCK_START}\n${line}\n${PR_STATUS_BLOCK_END}`;
}

/** The marked block for a status, or null when the pull request shows no block (`none`). */
export function renderPullRequestStatusBlock(status: PullRequestStatus, now: Date = new Date()): string | null {
    if (status.state === 'none') return null;
    return wrapBlock(renderPullRequestStatusLine(status, now));
}

/**
 * The shortest block for a status: its headline and update time only. Used
 * when the full block would push a body a person filled close to GitHub's
 * limit over it, since the text outside the block is never shortened.
 */
export function renderCompactPullRequestStatusBlock(status: PullRequestStatus, now: Date = new Date()): string | null {
    if (status.state === 'none') return null;
    return wrapBlock(`**ProPR** ${headline(status)} · updated ${statusTimestamp(now)}`);
}

interface BlockMatch {
    index: number;
    /** The block, markers included. */
    block: string;
    /** The separator right after the block, when there is one ("" otherwise). */
    separator: string;
}

/**
 * The first block in a body: its start marker and the first end marker after
 * it. Found with indexOf rather than a lazy regular expression, which scans
 * to the end of the body once per start marker when a body (which people can
 * edit) repeats the start marker without an end.
 */
function findBlock(body: string): BlockMatch | null {
    const index = body.indexOf(PR_STATUS_BLOCK_START);
    if (index === -1) return null;
    const end = body.indexOf(PR_STATUS_BLOCK_END, index + PR_STATUS_BLOCK_START.length);
    if (end === -1) return null;
    const blockEnd = end + PR_STATUS_BLOCK_END.length;
    const separator = body.slice(blockEnd, blockEnd + 4).match(TRAILING_SEPARATOR_PATTERN)?.[0] ?? '';
    return { index, block: body.slice(index, blockEnd), separator };
}

/** The current block, markers included, without its trailing separator. */
export function extractPullRequestStatusBlock(body: string | null | undefined): string | null {
    return findBlock(body ?? '')?.block ?? null;
}

/** The body without the status block (and the separator ProPR wrote after it). */
export function stripPullRequestStatusBlock(body: string | null | undefined): string {
    const current = body ?? '';
    const match = findBlock(current);
    if (!match) return current;
    return current.slice(0, match.index) + current.slice(match.index + match.block.length + match.separator.length);
}

/**
 * Puts `block` in the body: replaces the existing block in place, or inserts
 * it as the first thing in the body. A null block removes it. Text outside the
 * markers is never changed.
 */
export function applyPullRequestStatusBlock(body: string | null | undefined, block: string | null): string {
    const current = body ?? '';
    const match = findBlock(current);
    if (match) {
        const before = current.slice(0, match.index);
        const after = current.slice(match.index + match.block.length + match.separator.length);
        if (block === null) return before + after;
        const separator = match.separator || (after ? SEPARATOR : '');
        return `${before}${block}${separator}${after}`;
    }
    if (block === null) return current;
    return current ? `${block}${SEPARATOR}${current}` : block;
}

/**
 * Re-applies the block found in `currentBody` to a body another ProPR writer
 * produced, so that writer neither drops nor duplicates the status block.
 */
export function preservePullRequestStatusBlock(nextBody: string, currentBody: string | null | undefined): string {
    const block = extractPullRequestStatusBlock(currentBody);
    const stripped = stripPullRequestStatusBlock(nextBody);
    return block ? applyPullRequestStatusBlock(stripped, block) : stripped;
}

/** Bodies that differ only in the block's "updated Nov 16 13:59 UTC" stamp are the same status. */
export function sameRenderedStatus(left: string, right: string): boolean {
    return left.replace(TIMESTAMP_PATTERN, '') === right.replace(TIMESTAMP_PATTERN, '');
}

interface EditedPullRequestPayload {
    action?: string;
    changes?: Record<string, unknown> & { body?: { from?: string | null } };
    pull_request?: { body?: string | null };
}

/**
 * A `pull_request` `edited` event whose only change is inside the status
 * block (its text, or the block added or removed). ProPR's own status updates
 * look like this, but so does a person deleting or rewriting the block, so this
 * alone proves no authorship: see pullRequestStatusProvenance for that. Such an
 * edit is never work for the other handlers.
 */
export function isStatusBlockOnlyEdit(payload: EditedPullRequestPayload): boolean {
    if (payload.action !== 'edited' || !payload.changes) return false;
    const keys = Object.keys(payload.changes);
    if (keys.length !== 1 || keys[0] !== 'body') return false;
    const from = payload.changes.body?.from ?? '';
    const to = payload.pull_request?.body ?? '';
    if (from === to) return true;
    return stripPullRequestStatusBlock(from) === stripPullRequestStatusBlock(to);
}
