import type { Knex } from 'knex';
import type { PullRequestEvent } from '@octokit/webhooks-types';
import { db } from '../db/connection.js';
import { replayableTransaction } from '../db/sqliteRetry.js';
import { appendRepositoryEvent } from './repositoryEventJournal.js';
import logger from '../utils/logger.js';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import { findPlanIssueByRepoAndPR } from '../config/planIssueManager.js';
import { markEpicQueueAwaitingHumanMerge } from './taskPlanning/epicQueueHumanMerge.js';
import { parseRepositoryWorkflow, WORKFLOW_MAX_BYTES, WORKFLOW_PATH } from '../workflow/repositoryWorkflow.js';
import {
    decideAutoMerge,
    describeAutoMergeDecision,
    type AutoMergeDecision,
    type AutoMergeOpportunity,
    type AutoMergePolicyInput,
    type AutoMergePolicyMethod,
} from '../workflow/autoMergePolicy.js';

/** The subset of Octokit the gate uses, so tests can supply a fake GitHub client. */
export interface AutoMergeGateOctokit {
    request(route: string, params?: Record<string, unknown>): Promise<{ data: unknown }>;
    graphql?<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T>;
}

export type AutoMergeGraphQLMethod = 'MERGE' | 'SQUASH' | 'REBASE';

export interface AutoMergeGateDependencies {
    octokit?: AutoMergeGateOctokit;
    database?: Knex;
    now?: () => number;
    /** ProPR's own GitHub login (`<app-slug>[bot]`); defaults to the verified detected bot username. */
    botLogin?: () => Promise<string>;
    /** Epic queue hook; defaults to the real queue. */
    markEpicQueueAwaitingHumanMerge?: (input: { draftId: string; issueNumber: number; prNumber: number; reason: string }) => Promise<boolean>;
}

export interface PullRequestSnapshot {
    number: number;
    nodeId: string;
    baseRef: string;
    headSha: string;
    changedFiles: number;
    autoMergeArmed: boolean;
    /** Login of the actor that enabled auto-merge, when GitHub reports one. */
    autoMergeEnabledBy: string | null;
}

export interface AutoMergeEvaluation {
    decision: AutoMergeDecision;
    pullRequest: PullRequestSnapshot | null;
}

export interface AutoMergeGateResult extends AutoMergeDecision {
    /** GraphQL merge method to arm with; set only when native auto-merge may be armed. */
    mergeMethod?: AutoMergeGraphQLMethod;
    /**
     * Set with `arm` under `auto_merge.require_up_to_date`: the merge is allowed,
     * but only through ProPR's guarded merge path (check events and the sweep).
     * GitHub's native auto-merge must not be armed, because it would merge a
     * head that is behind its base.
     */
    directMergeOnly?: true;
    pullRequest: PullRequestSnapshot | null;
}

type Log = Pick<typeof logger, 'info' | 'warn' | 'debug'>;

const FILES_PER_PAGE = 100;
/** GitHub lists at most 3000 files for a pull request. */
const MAX_FILE_PAGES = 30;

async function gateOctokit(deps: AutoMergeGateDependencies): Promise<AutoMergeGateOctokit> {
    return deps.octokit ?? (await getAuthenticatedOctokit() as unknown as AutoMergeGateOctokit);
}

export async function fetchPullRequestSnapshot(octokit: AutoMergeGateOctokit, owner: string, repo: string, prNumber: number): Promise<PullRequestSnapshot> {
    const { data } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', { owner, repo, pull_number: prNumber });
    const pr = data as { number: number; node_id: string; base: { ref: string }; head: { sha: string }; changed_files?: number;
        auto_merge?: { enabled_by?: { login?: string } | null } | null };
    return {
        number: pr.number, nodeId: pr.node_id, baseRef: pr.base.ref, headSha: pr.head.sha,
        changedFiles: typeof pr.changed_files === 'number' ? pr.changed_files : -1, autoMergeArmed: Boolean(pr.auto_merge),
        autoMergeEnabledBy: typeof pr.auto_merge?.enabled_by?.login === 'string' ? pr.auto_merge.enabled_by.login : null,
    };
}

/**
 * Read the auto-merge policy from the PR's base branch through the GitHub API,
 * never from the head branch or a worktree the agent could have edited.
 * A missing workflow file is the default policy; anything unreadable is invalid.
 */
export async function loadBaseAutoMergePolicy(octokit: AutoMergeGateOctokit, owner: string, repo: string, baseRef: string): Promise<AutoMergePolicyInput> {
    let response;
    try {
        response = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', { owner, repo, path: WORKFLOW_PATH, ref: baseRef });
    } catch (error) {
        if ((error as { status?: number }).status === 404) return { status: 'valid' };
        return { status: 'invalid', error: `Could not read ${WORKFLOW_PATH} on ${baseRef}: ${(error as Error).message}` };
    }
    const file = response.data as { type?: string; encoding?: string; content?: string; size?: number } | unknown[];
    if (Array.isArray(file) || file.type !== 'file' || typeof file.content !== 'string' || file.encoding !== 'base64' || (file.size ?? 0) > WORKFLOW_MAX_BYTES) {
        return { status: 'invalid', error: `${WORKFLOW_PATH} on ${baseRef} must be a regular UTF-8 file of at most 128 KiB` };
    }
    try {
        const content = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(file.content, 'base64'));
        return { status: 'valid', config: parseRepositoryWorkflow(content).auto_merge };
    } catch (error) {
        return { status: 'invalid', error: (error as Error).message };
    }
}

/**
 * Freshly list the PR's changed files from GitHub (renames contribute both paths).
 * Returns null when the list is incomplete, or when the head moved or the PR was
 * retargeted while listing (the policy read for the old base no longer applies).
 */
export async function fetchPullRequestChangedFiles(octokit: AutoMergeGateOctokit, owner: string, repo: string, pr: PullRequestSnapshot): Promise<string[] | null> {
    const paths = new Set<string>();
    let listed = 0;
    for (let page = 1; page <= MAX_FILE_PAGES; page++) {
        const { data } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/files', {
            owner, repo, pull_number: pr.number, per_page: FILES_PER_PAGE, page,
        });
        if (!Array.isArray(data)) return null;
        for (const file of data as Array<{ filename?: string; previous_filename?: string }>) {
            if (typeof file.filename !== 'string') return null;
            listed++;
            paths.add(file.filename);
            if (typeof file.previous_filename === 'string') paths.add(file.previous_filename);
        }
        if (data.length < FILES_PER_PAGE) break;
    }
    // A truncated or unknown file count could hide a protected path.
    if (pr.changedFiles < 0 || listed !== pr.changedFiles) return null;
    const current = await fetchPullRequestSnapshot(octokit, owner, repo, pr.number);
    if (current.headSha !== pr.headSha || current.baseRef !== pr.baseRef) return null;
    return [...paths];
}

/** Evaluate the policy for a PR's current head without side effects on GitHub. */
export async function evaluatePullRequestAutoMerge(input: {
    owner: string; repo: string; prNumber: number; opportunity: AutoMergeOpportunity;
}, deps: AutoMergeGateDependencies = {}): Promise<AutoMergeEvaluation> {
    const { owner, repo, prNumber, opportunity } = input;
    let pullRequest: PullRequestSnapshot | null = null;
    let octokit: AutoMergeGateOctokit;
    try {
        octokit = await gateOctokit(deps);
        pullRequest = await fetchPullRequestSnapshot(octokit, owner, repo, prNumber);
    } catch (error) {
        // Without the PR there is no base branch to read policy from.
        return { decision: decideAutoMerge({ status: 'invalid', error: (error as Error).message }, null, { opportunity }), pullRequest };
    }
    const policy = await loadBaseAutoMergePolicy(octokit, owner, repo, pullRequest.baseRef);
    let changedFiles: string[] | null = null;
    if (policy.status === 'valid' && policy.config?.enabled !== false) {
        try {
            changedFiles = await fetchPullRequestChangedFiles(octokit, owner, repo, pullRequest);
        } catch {
            changedFiles = null;
        }
    }
    return { decision: decideAutoMerge(policy, changedFiles, { opportunity }), pullRequest };
}

/** The repository's default merge method: squash, as before, unless the repository disallows it. */
async function resolveMergeMethod(octokit: AutoMergeGateOctokit, owner: string, repo: string, method?: AutoMergePolicyMethod): Promise<AutoMergeGraphQLMethod> {
    if (method) return method.toUpperCase() as AutoMergeGraphQLMethod;
    try {
        const { data } = await octokit.request('GET /repos/{owner}/{repo}', { owner, repo });
        const settings = data as { allow_squash_merge?: boolean; allow_merge_commit?: boolean; allow_rebase_merge?: boolean };
        if (settings.allow_squash_merge === false) {
            if (settings.allow_merge_commit !== false) return 'MERGE';
            if (settings.allow_rebase_merge !== false) return 'REBASE';
        }
    } catch {
        // Fall back to the historical default; GitHub rejects a disallowed method.
    }
    return 'SQUASH';
}

/**
 * The merge method for a direct merge: the policy's method, otherwise the same
 * repository-supported default {@link gateAutoMergeArming} arms with.
 */
export async function resolveDirectMergeMethod(input: {
    owner: string; repo: string; method?: AutoMergePolicyMethod;
}, deps: AutoMergeGateDependencies = {}): Promise<AutoMergePolicyMethod> {
    if (input.method) return input.method;
    let octokit: AutoMergeGateOctokit;
    try {
        octokit = await gateOctokit(deps);
    } catch {
        return 'squash';
    }
    return (await resolveMergeMethod(octokit, input.owner, input.repo)).toLowerCase() as AutoMergePolicyMethod;
}

/** Find the task whose timeline records this decision. */
async function resolveDecisionTaskId(database: Knex, repository: string, numbers: number[]): Promise<string | null> {
    const row = await database('tasks').where({ repository }).whereIn('issue_number', numbers)
        .orderBy('created_at', 'desc').first('task_id');
    return row?.task_id ?? null;
}

interface AutoMergeDecisionEventInput {
    repository: string; prNumber: number; issueNumber?: number; taskId?: string;
    opportunity: AutoMergeOpportunity; decision: AutoMergeDecision; headSha?: string; baseRef?: string;
    /** `branch_updated`/`waiting` are `require_up_to_date` decisions taken instead of a merge. */
    action?: 'disarmed' | 'branch_updated' | 'waiting';
    /** Base commit the head was compared with (`require_up_to_date`). */
    baseSha?: string;
}

const DECISION_VERBS: Record<NonNullable<AutoMergeDecisionEventInput['action']>, string> = {
    disarmed: 'disarmed', branch_updated: 'updated the branch', waiting: 'waiting',
};

function decisionEventMetadata(input: AutoMergeDecisionEventInput): Record<string, unknown> {
    const { decision } = input;
    return {
        reason: decision.reason, arm: decision.arm, opportunity: input.opportunity, prNumber: input.prNumber,
        ...(input.action ? { action: input.action } : {}),
        ...(decision.matchedPaths?.length ? { matchedPaths: decision.matchedPaths } : {}),
        ...(decision.method ? { method: decision.method } : {}),
        ...(decision.detail ? { detail: decision.detail } : {}),
        ...(input.headSha ? { headSha: input.headSha } : {}),
        ...(input.baseRef ? { baseRef: input.baseRef, policyPath: WORKFLOW_PATH } : {}),
        ...(input.baseSha ? { baseSha: input.baseSha } : {}),
    };
}

/**
 * Journal an auto-merge decision. The same decision for the same head is one
 * event, however often the opportunity is re-evaluated. Never throws.
 */
async function journalAutoMergeDecision(database: Knex, input: AutoMergeDecisionEventInput, occurredAt: number, log: Log): Promise<void> {
    const outcome = input.action ?? (input.decision.arm ? 'armed' : 'not_armed');
    await appendRepositoryEvent(database, {
        repository: input.repository, domain: 'pull_request', type: 'auto_merge_decision', entityId: input.prNumber,
        prNumber: input.prNumber, issueNumber: input.issueNumber ?? null, headSha: input.headSha ?? null,
        payload: decisionEventMetadata(input), occurredAt: new Date(occurredAt),
        dedupeKey: input.headSha ? `pr:${input.prNumber}:auto_merge:${input.headSha}:${input.opportunity}:${outcome}:${input.decision.reason}` : null,
    }, { log });
}

/** Write one task timeline event (and one journal event) for an auto-merge decision. Never throws. */
export async function recordAutoMergeDecisionEvent(input: AutoMergeDecisionEventInput, deps: AutoMergeGateDependencies = {}, log: Log = logger): Promise<boolean> {
    const database = deps.database ?? db;
    const { decision } = input;
    const occurredAt = (deps.now ?? Date.now)();
    let journaled = false;
    try {
        // Without a known issue, the PR's plan issue (or a PR follow-up task) owns the timeline.
        const issueNumber = input.issueNumber ?? (input.taskId ? undefined : (await findPlanIssueByRepoAndPR(input.repository, input.prNumber))?.issue_number);
        const numbers = [issueNumber, input.prNumber].filter((value): value is number => Number.isInteger(value));
        const taskId = input.taskId ?? await resolveDecisionTaskId(database, input.repository, numbers);
        if (!taskId) {
            log.info({ repository: input.repository, prNumber: input.prNumber, reason: decision.reason }, 'No task found for auto-merge decision event');
            journaled = true;
            await journalAutoMergeDecision(database, input, occurredAt, log);
            return false;
        }
        const verb = input.action ? DECISION_VERBS[input.action] : decision.arm ? 'armed' : 'not armed';
        // Repeat the latest lifecycle state so the event never changes the task's derived state.
        // The read and the append share one write transaction (SQLite opens it with BEGIN
        // IMMEDIATE), so a lifecycle transition cannot land between them; "latest" uses the
        // same history_id order lifecycle readers use, and a replay re-reads it.
        await database.transaction(async trx => {
            const latest = await trx('task_history').where({ task_id: taskId }).orderBy('history_id', 'desc').first('state');
            await trx('task_history').insert({
                task_id: taskId,
                state: latest?.state ?? 'completed',
                timestamp: new Date(occurredAt).toISOString(),
                reason: `Auto-merge ${verb} for PR #${input.prNumber}: ${decision.reason}`,
                metadata: JSON.stringify({ autoMergeDecision: decisionEventMetadata(input) }),
            });
            await journalAutoMergeDecision(trx, input, occurredAt, log);
        }, replayableTransaction());
        return true;
    } catch (error) {
        log.warn({ repository: input.repository, prNumber: input.prNumber, error: (error as Error).message }, 'Failed to record auto-merge decision event');
        // The journal does not depend on the task timeline.
        if (!journaled) await journalAutoMergeDecision(database, input, occurredAt, log);
        return false;
    }
}

async function postDecisionComment(target: { owner: string; repo: string; prNumber: number }, body: string, octokit: AutoMergeGateOctokit | null, log: Log): Promise<void> {
    const { owner, repo, prNumber } = target;
    try {
        await (octokit ?? await getAuthenticatedOctokit() as unknown as AutoMergeGateOctokit)
            .request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', { owner, repo, issue_number: prNumber, body });
    } catch (error) {
        log.warn({ owner, repo, prNumber, error: (error as Error).message }, 'Failed to post auto-merge decision comment');
    }
}

async function surfaceEpicHumanMerge(target: { repository: string; prNumber: number; reason: string }, deps: AutoMergeGateDependencies, log: Log): Promise<void> {
    const { repository, prNumber, reason } = target;
    try {
        const planIssue = await findPlanIssueByRepoAndPR(repository, prNumber);
        if (!planIssue?.draft_id) return;
        const mark = deps.markEpicQueueAwaitingHumanMerge ?? markEpicQueueAwaitingHumanMerge;
        const marked = await mark({ draftId: planIssue.draft_id, issueNumber: planIssue.issue_number, prNumber, reason });
        if (marked) log.info({ repository, prNumber, draftId: planIssue.draft_id }, 'Epic queue is waiting for a human merge');
    } catch (error) {
        log.warn({ repository, prNumber, error: (error as Error).message }, 'Failed to mark epic queue as waiting for a human merge');
    }
}

/**
 * The single decision point before ProPR arms auto-merge. Records exactly one
 * timeline event; when skipped, comments on the PR (leaving the `auto-merge`
 * label for a human) and surfaces "waiting for human merge" on an Epic queue.
 */
export async function gateAutoMergeArming(input: {
    owner: string; repo: string; prNumber: number; opportunity: AutoMergeOpportunity;
    taskId?: string; issueNumber?: number; log?: Log;
}, deps: AutoMergeGateDependencies = {}): Promise<AutoMergeGateResult> {
    const { owner, repo, prNumber, opportunity } = input;
    const log = input.log ?? logger;
    const repository = `${owner}/${repo}`;
    const { decision, pullRequest } = await evaluatePullRequestAutoMerge({ owner, repo, prNumber, opportunity }, deps);
    let mergeMethod: AutoMergeGraphQLMethod | undefined;
    let octokit: AutoMergeGateOctokit | null = deps.octokit ?? null;
    const directMergeOnly = decision.arm && Boolean(decision.upToDate);
    if (decision.arm && !directMergeOnly) {
        octokit ??= await gateOctokit(deps);
        mergeMethod = await resolveMergeMethod(octokit, owner, repo, decision.method);
    }
    log.info({ repository, prNumber, opportunity, reason: decision.reason, matchedPaths: decision.matchedPaths }, 'Auto-merge decision');
    await recordAutoMergeDecisionEvent({
        repository, prNumber, issueNumber: input.issueNumber, taskId: input.taskId, opportunity, decision,
        headSha: pullRequest?.headSha, baseRef: pullRequest?.baseRef,
    }, deps, log);
    if (!decision.arm) {
        await postDecisionComment({ owner, repo, prNumber }, describeAutoMergeDecision(decision), octokit, log);
        await surfaceEpicHumanMerge({ repository, prNumber, reason: decision.reason }, deps, log);
    }
    // A request armed before the repository enabled `require_up_to_date` would bypass it.
    if (directMergeOnly && pullRequest?.autoMergeArmed) {
        await withdrawNativeAutoMergeForUpToDate({ owner, repo, prNumber, pullRequest, opportunity, log }, deps);
    }
    return { ...decision, ...(mergeMethod ? { mergeMethod } : {}), ...(directMergeOnly ? { directMergeOnly: true as const } : {}), pullRequest };
}

async function resolveBotLogin(deps: AutoMergeGateDependencies): Promise<string> {
    if (deps.botLogin) return deps.botLogin();
    // Ownership needs the real identity: a cached fallback login would hide a custom App's request.
    const { detectVerifiedBotUsername } = await import('../daemon/configLoader.js');
    return detectVerifiedBotUsername();
}

/** True only when ProPR's own identity enabled the PR's auto-merge request. */
async function isArmedByProPR(pullRequest: PullRequestSnapshot, deps: AutoMergeGateDependencies, log: Log): Promise<boolean> {
    if (!pullRequest.autoMergeArmed || !pullRequest.autoMergeEnabledBy) return false;
    try {
        const botLogin = (await resolveBotLogin(deps)).trim().toLowerCase();
        return botLogin.length > 0 && pullRequest.autoMergeEnabledBy.toLowerCase() === botLogin;
    } catch (error) {
        log.warn({ prNumber: pullRequest.number, error: (error as Error).message }, 'Could not resolve ProPR bot login; leaving auto-merge untouched');
        return false;
    }
}

async function disablePullRequestAutoMerge(octokit: AutoMergeGateOctokit, pullRequestId: string): Promise<void> {
    if (!octokit.graphql) throw new Error('GraphQL client unavailable');
    await octokit.graphql(`
        mutation DisableAutoMerge($pullRequestId: ID!) {
            disablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId }) {
                pullRequest { autoMergeRequest { enabledAt } }
            }
        }
    `, { pullRequestId });
}

/**
 * Withdraw ProPR's own native auto-merge request. Evaluation awaited several
 * GitHub reads, so a maintainer may have taken the request over meanwhile:
 * ownership is rechecked from a fresh read right before withdrawing. If that
 * read fails, the earlier ProPR-owned snapshot is the latest evidence and the
 * request is withdrawn. Returns the snapshot it acted on, or null when nothing
 * was withdrawn (not ProPR's, or GitHub refused).
 */
async function withdrawProPRAutoMerge(input: {
    owner: string; repo: string; prNumber: number; pullRequest: PullRequestSnapshot; log: Log; failureMessage: string;
}, deps: AutoMergeGateDependencies): Promise<PullRequestSnapshot | null> {
    const { owner, repo, prNumber, pullRequest, log } = input;
    // Only ProPR's own armed request is withdrawn: a person who armed it manually has
    // made their own decision, and another App's request is not ProPR's to cancel.
    if (!(await isArmedByProPR(pullRequest, deps, log))) return null;
    const octokit = await gateOctokit(deps);
    let current = pullRequest;
    try {
        current = await fetchPullRequestSnapshot(octokit, owner, repo, prNumber);
    } catch (error) {
        log.warn({ owner, repo, prNumber, error: (error as Error).message }, 'Could not re-read auto-merge ownership before disarming; using the evaluated snapshot');
    }
    if (current !== pullRequest && !(await isArmedByProPR(current, deps, log))) return null;
    try {
        await disablePullRequestAutoMerge(octokit, current.nodeId);
    } catch (error) {
        log.warn({ owner, repo, prNumber, error: (error as Error).message }, input.failureMessage);
        return null;
    }
    return current;
}

const UP_TO_DATE_WITHDRAWN_DETAIL = 'auto_merge.require_up_to_date is enabled: ProPR merges this PR itself once its head contains the latest base commit and CI has passed on it';

/**
 * Under `auto_merge.require_up_to_date`, GitHub's native auto-merge would merge
 * a behind head without the up-to-date comparison. Withdraw ProPR's own native
 * request (requests armed by anyone else are left alone); the merge intent stays
 * with the `auto-merge` label and ProPR's guarded merge path. Never throws.
 */
export async function withdrawNativeAutoMergeForUpToDate(input: {
    owner: string; repo: string; prNumber: number; pullRequest: PullRequestSnapshot; opportunity: AutoMergeOpportunity; log?: Log;
}, deps: AutoMergeGateDependencies = {}): Promise<boolean> {
    const { owner, repo, prNumber, pullRequest, opportunity } = input;
    const log = input.log ?? logger;
    if (!pullRequest.autoMergeArmed) return false;
    let withdrawn: PullRequestSnapshot | null;
    try {
        withdrawn = await withdrawProPRAutoMerge({
            owner, repo, prNumber, pullRequest, log, failureMessage: 'Failed to withdraw native auto-merge for require_up_to_date',
        }, deps);
    } catch (error) {
        log.warn({ owner, repo, prNumber, error: (error as Error).message }, 'Failed to withdraw native auto-merge for require_up_to_date');
        return false;
    }
    if (!withdrawn) return false;
    log.info({ owner, repo, prNumber, opportunity }, 'Withdrew native auto-merge: require_up_to_date merges through ProPR');
    const decision: AutoMergeDecision = { arm: true, reason: 'armed', opportunity, detail: UP_TO_DATE_WITHDRAWN_DETAIL };
    await recordAutoMergeDecisionEvent({
        repository: `${owner}/${repo}`, prNumber, opportunity, decision, action: 'disarmed',
        headSha: pullRequest.headSha, baseRef: pullRequest.baseRef,
    }, deps, log);
    await postDecisionComment({ owner, repo, prNumber },
        `**GitHub auto-merge withdrawn**: \`auto_merge.require_up_to_date\` is enabled on \`${pullRequest.baseRef}\`, so ProPR merges this PR itself, `
        + 'only once its head contains the latest base commit and CI has passed on that head. The `auto-merge` label stays in place.', deps.octokit ?? null, log);
    return true;
}

/**
 * ProPR's direct merge path returns early for pending CI, mergeability, Ultrafix
 * state or active work, but a native request ProPR armed keeps waiting on GitHub
 * meanwhile and would merge a behind head once CI passes. Callers use this before
 * those gates: when the base policy allows the merge only with
 * `require_up_to_date`, ProPR's native request is withdrawn. Never throws.
 */
export async function withdrawNativeAutoMergeIfUpToDateRequired(input: {
    owner: string; repo: string; prNumber: number; opportunity: AutoMergeOpportunity; log?: Log;
}, deps: AutoMergeGateDependencies = {}): Promise<boolean> {
    const { owner, repo, prNumber, opportunity } = input;
    const log = input.log ?? logger;
    let evaluation: AutoMergeEvaluation;
    try {
        evaluation = await evaluatePullRequestAutoMerge({ owner, repo, prNumber, opportunity }, deps);
    } catch (error) {
        log.warn({ owner, repo, prNumber, error: (error as Error).message }, 'Could not evaluate require_up_to_date before withdrawing native auto-merge');
        return false;
    }
    const { decision, pullRequest } = evaluation;
    if (!decision.arm || !decision.upToDate || !pullRequest?.autoMergeArmed) return false;
    return withdrawNativeAutoMergeForUpToDate({ owner, repo, prNumber, pullRequest, opportunity, log }, deps);
}

/**
 * A new head can add protected changes after auto-merge was armed. Re-evaluate
 * the policy and, if it no longer allows auto-merge, disarm it, say why, and
 * surface "waiting for human merge" on an Epic queue. Under
 * `require_up_to_date`, ProPR's native request is withdrawn as well.
 */
export async function reevaluateArmedAutoMergeOnNewHead(input: {
    owner: string; repo: string; prNumber: number; log?: Log;
}, deps: AutoMergeGateDependencies = {}): Promise<{ disarmed: boolean; decision?: AutoMergeDecision }> {
    const { owner, repo, prNumber } = input;
    const log = input.log ?? logger;
    const { decision, pullRequest } = await evaluatePullRequestAutoMerge({ owner, repo, prNumber, opportunity: 'new_head' }, deps);
    // When the PR cannot be read, GitHub cannot be told either.
    if (!pullRequest) return { disarmed: false, decision };
    if (decision.arm && decision.upToDate) {
        const disarmed = await withdrawNativeAutoMergeForUpToDate({ owner, repo, prNumber, pullRequest, opportunity: 'new_head', log }, deps);
        return { disarmed, decision };
    }
    if (decision.arm) return { disarmed: false, decision };
    const withdrawn = await withdrawProPRAutoMerge({
        owner, repo, prNumber, pullRequest, log, failureMessage: 'Failed to disarm auto-merge after a new head',
    }, deps);
    if (!withdrawn) return { disarmed: false, decision };
    const octokit = await gateOctokit(deps);
    log.info({ owner, repo, prNumber, reason: decision.reason, matchedPaths: decision.matchedPaths }, 'Disarmed auto-merge after a new head');
    await recordAutoMergeDecisionEvent({
        repository: `${owner}/${repo}`, prNumber, opportunity: 'new_head', decision, action: 'disarmed',
        headSha: pullRequest.headSha, baseRef: pullRequest.baseRef,
    }, deps, log);
    await postDecisionComment({ owner, repo, prNumber },
        describeAutoMergeDecision(decision).replace('**Auto-merge not armed**', `**Auto-merge disarmed** after new commits (${pullRequest.headSha.slice(0, 7)})`), octokit, log);
    await surfaceEpicHumanMerge({ repository: `${owner}/${repo}`, prNumber, reason: decision.reason }, deps, log);
    return { disarmed: true, decision };
}

/** Armed open PRs whose head commit or base branch changed are re-evaluated. Never throws. */
export async function handleAutoMergePolicyPullRequestEvent(payload: PullRequestEvent, log: Log = logger, deps: AutoMergeGateDependencies = {}): Promise<void> {
    const pr = payload.pull_request;
    const baseChanged = payload.action === 'edited' && Boolean((payload as { changes?: { base?: unknown } }).changes?.base);
    if (pr.state !== 'open' || !pr.auto_merge || (payload.action !== 'synchronize' && !baseChanged)) return;
    try {
        const [owner, repo] = payload.repository.full_name.split('/');
        await reevaluateArmedAutoMergeOnNewHead({ owner, repo, prNumber: pr.number, log }, deps);
    } catch (error) {
        log.warn({ repository: payload.repository.full_name, prNumber: pr.number, error: (error as Error).message }, 'Auto-merge policy re-evaluation failed');
    }
}
