import { PR_STATUS_BLOCK_MAX_LENGTH } from '@propr/shared';
import type { PullRequestActivity, PullRequestAttentionReason, PullRequestStatus } from './pullRequestStatus.js';

/**
 * The live status block ProPR keeps as the first thing in a pull request body.
 * It is only ever written between its own markers; everything outside them is
 * preserved byte for byte.
 */
export const PR_STATUS_BLOCK_START = '<!-- propr:pr-status -->';
export const PR_STATUS_BLOCK_END = '<!-- /propr:pr-status -->';

/** Separator between the block and the rest of the body. */
const SEPARATOR = '\n\n';
const BLOCK_PATTERN = /<!-- propr:pr-status -->[\s\S]*?<!-- \/propr:pr-status -->(?:\r?\n\r?\n)?/;
const TIMESTAMP_PATTERN = / · updated \d{2}:\d{2} UTC/g;

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
    checks_unavailable: 'checks could not be read',
};

const MAX_FAILED_CHECK_NAMES = 3;

function checksText(checks: PullRequestStatus['detail']['checks']): string | null {
    if (!checks) return null;
    const parts = [
        checks.passed > 0 ? `${checks.passed} passed` : null,
        checks.failed > 0 ? `${checks.failed} failed` : null,
        checks.pending > 0 ? `${checks.pending} pending` : null,
    ].filter((part): part is string => part !== null);
    return parts.length > 0 ? `checks: ${parts.join(', ')}` : null;
}

/** Check names come from CI configuration; keep them from breaking the one-line block. */
function inlineName(name: string): string {
    return name.replace(/[\r\n`*_<>|[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}

function reasonText(status: PullRequestStatus, maxNames: number): string {
    const { detail } = status;
    if (detail.reason === 'ultrafix_stopped' && detail.ultrafixStopped) {
        const { cycles, finalScore } = detail.ultrafixStopped;
        const score = finalScore !== null ? ` at ${finalScore}/10` : '';
        return `Ultrafix stopped after ${cycles} cycle${cycles === 1 ? '' : 's'}${score}`;
    }
    if (detail.reason === 'check_failed' && detail.failedChecks.length > 0) {
        const names = detail.failedChecks.slice(0, maxNames).map(inlineName).filter(Boolean);
        const more = detail.failedChecks.length > names.length ? ` +${detail.failedChecks.length - names.length}` : '';
        if (names.length > 0) return `failed: ${names.join(', ')}${more}`;
    }
    if (detail.reason === 'review_below_goal') return `review below goal ${detail.ratingGoal}/10`;
    return detail.reason ? REASON_TEXT[detail.reason] : '';
}

function headline(status: PullRequestStatus): string {
    if (status.state === 'ready') return '✅ Ready';
    if (status.state === 'needs_attention') return '⚠️ Needs you';
    return `🔨 ${ACTIVITY_TEXT[status.detail.activity ?? 'queued']}`;
}

function utcTime(now: Date): string {
    return `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')} UTC`;
}

function statusLine(status: PullRequestStatus, now: Date, maxNames: number): string {
    const { detail } = status;
    const parts = [`**ProPR** ${headline(status)}`];
    if (status.state === 'needs_attention') parts.push(reasonText(status, maxNames));
    if (detail.ultrafix) parts.push(`Ultrafix cycle ${detail.ultrafix.cycle} of ${detail.ultrafix.maxCycles}`);
    if (detail.reviewScore !== null && detail.reason !== 'ultrafix_stopped') {
        parts.push(status.state === 'working' ? `last review ${detail.reviewScore}/10` : `review ${detail.reviewScore}/10`);
    }
    const checks = status.state === 'needs_attention' && detail.reason === 'ultrafix_stopped' ? null : checksText(detail.checks);
    if (checks) parts.push(checks);
    if (detail.epic) parts.push(`issues: ${detail.epic.merged} of ${detail.epic.total} merged`);
    parts.push(`updated ${utcTime(now)}`);
    return parts.filter(Boolean).join(' · ');
}

const MARKERS_LENGTH = `${PR_STATUS_BLOCK_START}\n\n${PR_STATUS_BLOCK_END}`.length;
/** The longest status line that keeps the block within PR_STATUS_BLOCK_MAX_LENGTH. */
const MAX_LINE_LENGTH = PR_STATUS_BLOCK_MAX_LENGTH - MARKERS_LENGTH;

/**
 * The one-line status text, e.g. "**ProPR** ✅ Ready · review 8/10 · checks: 35 passed · updated 10:02 UTC".
 * Never longer than the block budget: failed check names are dropped first,
 * then the line is cut, so the space new descriptions reserve always holds it.
 */
export function renderPullRequestStatusLine(status: PullRequestStatus, now: Date = new Date()): string {
    for (let names = MAX_FAILED_CHECK_NAMES; names >= 0; names--) {
        const line = statusLine(status, now, names);
        if (line.length <= MAX_LINE_LENGTH) return line;
    }
    const line = statusLine(status, now, 0);
    const stamp = ` · updated ${utcTime(now)}`;
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
    return wrapBlock(`**ProPR** ${headline(status)} · updated ${utcTime(now)}`);
}

/** The current block, markers included, without its trailing separator. */
export function extractPullRequestStatusBlock(body: string | null | undefined): string | null {
    const match = (body ?? '').match(BLOCK_PATTERN);
    return match ? match[0].replace(/(?:\r?\n\r?\n)$/, '') : null;
}

/** The body without the status block (and the separator ProPR wrote after it). */
export function stripPullRequestStatusBlock(body: string | null | undefined): string {
    return (body ?? '').replace(BLOCK_PATTERN, '');
}

/**
 * Puts `block` in the body: replaces the existing block in place, or inserts
 * it as the first thing in the body. A null block removes it. Text outside the
 * markers is never changed.
 */
export function applyPullRequestStatusBlock(body: string | null | undefined, block: string | null): string {
    const current = body ?? '';
    const match = current.match(BLOCK_PATTERN);
    if (match && match.index !== undefined) {
        const before = current.slice(0, match.index);
        const after = current.slice(match.index + match[0].length);
        if (block === null) return before + after;
        const separator = match[0].match(/(?:\r?\n\r?\n)$/)?.[0] ?? (after ? SEPARATOR : '');
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

/** Bodies that differ only in the block's "updated HH:MM UTC" stamp are the same status. */
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
