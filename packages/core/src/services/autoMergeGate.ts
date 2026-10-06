import type { Knex } from 'knex';
import type { PullRequestEvent } from '@octokit/webhooks-types';
import { db } from '../db/connection.js';
import { replayableTransaction } from '../db/sqliteRetry.js';
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
    /** ProPR's own GitHub login (`<app-slug>[bot]`); defaults to the detected bot username. */
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
    /** GraphQL merge method to arm with; set only when `arm` is true. */
    mergeMethod?: AutoMergeGraphQLMethod;
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

/** Find the task whose timeline records this decision. */
async function resolveDecisionTaskId(database: Knex, repository: string, numbers: number[]): Promise<string | null> {
    const row = await database('tasks').where({ repository }).whereIn('issue_number', numbers)
        .orderBy('created_at', 'desc').first('task_id');
    return row?.task_id ?? null;
}

interface AutoMergeDecisionEventInput {
    repository: string; prNumber: number; issueNumber?: number; taskId?: string;
    opportunity: AutoMergeOpportunity; decision: AutoMergeDecision; headSha?: string; baseRef?: string; action?: 'disarmed';
}

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
    };
}

/** Write one task timeline event for an auto-merge decision. Never throws. */
export async function recordAutoMergeDecisionEvent(input: AutoMergeDecisionEventInput, deps: AutoMergeGateDependencies = {}, log: Log = logger): Promise<boolean> {
    const database = deps.database ?? db;
    const { decision } = input;
    try {
        // Without a known issue, the PR's plan issue (or a PR follow-up task) owns the timeline.
        const issueNumber = input.issueNumber ?? (input.taskId ? undefined : (await findPlanIssueByRepoAndPR(input.repository, input.prNumber))?.issue_number);
        const numbers = [issueNumber, input.prNumber].filter((value): value is number => Number.isInteger(value));
        const taskId = input.taskId ?? await resolveDecisionTaskId(database, input.repository, numbers);
        if (!taskId) {
            log.info({ repository: input.repository, prNumber: input.prNumber, reason: decision.reason }, 'No task found for auto-merge decision event');
            return false;
        }
        const verb = input.action === 'disarmed' ? 'disarmed' : decision.arm ? 'armed' : 'not armed';
        // Repeat the latest lifecycle state so the event never changes the task's derived state.
        // The read and the append share one write transaction (SQLite opens it with BEGIN
        // IMMEDIATE), so a lifecycle transition cannot land between them; "latest" uses the
        // same history_id order lifecycle readers use, and a replay re-reads it.
        await database.transaction(async trx => {
            const latest = await trx('task_history').where({ task_id: taskId }).orderBy('history_id', 'desc').first('state');
            await trx('task_history').insert({
                task_id: taskId,
                state: latest?.state ?? 'completed',
                timestamp: new Date((deps.now ?? Date.now)()).toISOString(),
                reason: `Auto-merge ${verb} for PR #${input.prNumber}: ${decision.reason}`,
                metadata: JSON.stringify({ autoMergeDecision: decisionEventMetadata(input) }),
            });
        }, replayableTransaction());
        return true;
    } catch (error) {
        log.warn({ repository: input.repository, prNumber: input.prNumber, error: (error as Error).message }, 'Failed to record auto-merge decision event');
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
    if (decision.arm) {
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
    return { ...decision, ...(mergeMethod ? { mergeMethod } : {}), pullRequest };
}

async function resolveBotLogin(deps: AutoMergeGateDependencies): Promise<string> {
    if (deps.botLogin) return deps.botLogin();
    const { detectBotUsername } = await import('../daemon/configLoader.js');
    return detectBotUsername();
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
 * A new head can add protected changes after auto-merge was armed. Re-evaluate
 * the policy and, if it no longer allows auto-merge, disarm it and say why.
 */
export async function reevaluateArmedAutoMergeOnNewHead(input: {
    owner: string; repo: string; prNumber: number; log?: Log;
}, deps: AutoMergeGateDependencies = {}): Promise<{ disarmed: boolean; decision?: AutoMergeDecision }> {
    const { owner, repo, prNumber } = input;
    const log = input.log ?? logger;
    const { decision, pullRequest } = await evaluatePullRequestAutoMerge({ owner, repo, prNumber, opportunity: 'new_head' }, deps);
    // Only ProPR's own armed request is withdrawn: a person who armed it manually after a
    // skipped decision has already reviewed the protected change, and another App's request
    // is not ProPR's to cancel. When the PR cannot be read, GitHub cannot be told either.
    if (decision.arm || !pullRequest || !(await isArmedByProPR(pullRequest, deps, log))) return { disarmed: false, decision };
    const octokit = await gateOctokit(deps);
    try {
        await disablePullRequestAutoMerge(octokit, pullRequest.nodeId);
    } catch (error) {
        log.warn({ owner, repo, prNumber, error: (error as Error).message }, 'Failed to disarm auto-merge after a new head');
        return { disarmed: false, decision };
    }
    log.info({ owner, repo, prNumber, reason: decision.reason, matchedPaths: decision.matchedPaths }, 'Disarmed auto-merge after a new head');
    await recordAutoMergeDecisionEvent({
        repository: `${owner}/${repo}`, prNumber, opportunity: 'new_head', decision, action: 'disarmed',
        headSha: pullRequest.headSha, baseRef: pullRequest.baseRef,
    }, deps, log);
    await postDecisionComment({ owner, repo, prNumber },
        describeAutoMergeDecision(decision).replace('**Auto-merge not armed**', `**Auto-merge disarmed** after new commits (${pullRequest.headSha.slice(0, 7)})`), octokit, log);
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
