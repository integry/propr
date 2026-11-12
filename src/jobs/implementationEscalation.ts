import { createHash, randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { ReasoningLevel } from '@propr/shared';
import {
    db, describeRepositoryValidationStatus, getAuthenticatedOctokit, getStateManager, issueQueue, loadImplementationEscalationSettings,
    type ClaudeCodeResponse, type CommentJobData, type ImplementationEscalationLadder, type ImplementationEscalationSettings,
    type IssueJobData, type RepositoryValidationResult,
} from '@propr/core';
import { escalateOneStep, type EscalationModel, type EscalationStep } from './ultrafixEscalationPolicy.js';
import { resolveHandoffCandidate, resolveModel, type CandidateSkip } from './ultrafixEscalation.js';

/**
 * Escalation of implementation (issue) runs: start cheap and climb only after a
 * failure. A replacement of a failed attempt runs one step up the ladder (one
 * reasoning level higher, up to the configured maximum, then the next available
 * model of the list), and a run whose repository validation failed may get one
 * automatic follow-up one step up. The ladder is the Ultrafix escalation policy.
 */

export type ImplementationEscalationReason = 'infra_lost' | 'provider_transient' | 'repository_validation_failed';

export interface EscalationRung {
    model: string;
    effort?: ReasoningLevel;
}

export interface ImplementationEscalation {
    from: EscalationRung;
    to: EscalationRung;
    step: EscalationStep;
    reason: ImplementationEscalationReason;
    /** The ladder after this step, carried by the escalated run. */
    ladder: ImplementationEscalationLadder;
}

export interface ImplementationEscalationDeps {
    loadSettings?: () => Promise<ImplementationEscalationSettings>;
    /** The current model as a ladder rung, without usage checks. */
    resolveCurrent?: (model: string, effort?: ReasoningLevel) => Promise<EscalationModel | null>;
    /** A handoff candidate, with the same availability and provider-usage checks as Ultrafix. */
    resolveCandidate?: (candidate: string, skipped: CandidateSkip[]) => Promise<EscalationModel | null>;
    logger?: Pick<Logger, 'info' | 'warn'>;
}

const REASON_TEXT: Record<ImplementationEscalationReason, string> = {
    infra_lost: 'the previous attempt was lost with its worker',
    provider_transient: 'the previous attempt ended with a transient provider error',
    repository_validation_failed: 'repository validation failed',
};

function rungText(rung: EscalationRung): string {
    return `${rung.model} (${rung.effort ?? 'default effort'})`;
}

/** Computes one ladder step for a run on `model` at `effort`, or null when the ladder has no step left. */
export async function planImplementationEscalation(
    input: { model: string; effort?: ReasoningLevel; ladder?: ImplementationEscalationLadder; reason: ImplementationEscalationReason },
    settings: Pick<ImplementationEscalationSettings, 'models' | 'maxReasoningLevels'>,
    deps: ImplementationEscalationDeps = {},
): Promise<ImplementationEscalation | null> {
    const resolveCurrent = deps.resolveCurrent ?? ((model: string, effort?: ReasoningLevel) => resolveModel(model, false, effort));
    const resolveCandidate = deps.resolveCandidate ?? resolveHandoffCandidate;
    const current = await resolveCurrent(input.model, input.effort);
    if (!current) return null;
    // A lineage keeps the ladder it started with; settings changes apply to new lineages.
    const ladder = input.ladder ?? {
        models: [current.model, ...settings.models.filter(model => model !== current.model)],
        maxReasoningLevels: settings.maxReasoningLevels, modelIndex: 0, climbs: 0,
    };
    const from = { model: current.model, ...(current.effort ? { effort: current.effort } : {}) };
    const state = { models: ladder.models, maxReasoningLevels: ladder.maxReasoningLevels, modelIndex: ladder.modelIndex, climbs: ladder.climbs, current: { ...current } };
    const skipped: CandidateSkip[] = [];
    const step = await escalateOneStep(state, candidate => resolveCandidate(candidate, skipped));
    for (const skip of skipped) deps.logger?.info({ ...skip, reason: input.reason, skipReason: skip.reason }, 'Implementation escalation: candidate skipped');
    if (!step) return null;
    return {
        from,
        to: { model: state.current.model, ...(state.current.effort ? { effort: state.current.effort } : {}) },
        step, reason: input.reason,
        ladder: { models: ladder.models, maxReasoningLevels: ladder.maxReasoningLevels, modelIndex: state.modelIndex, climbs: state.climbs },
    };
}

/** The `task.escalation` timeline event (from, to, reason) of one escalation. */
export function implementationEscalationEvent(escalation: ImplementationEscalation, extra: Record<string, unknown> = {}): {
    event: 'task.escalation'; reason: string; metadata: Record<string, unknown>;
} {
    const action = escalation.step === 'model_handoff' ? 'Handed off' : 'Raised reasoning';
    return {
        event: 'task.escalation',
        reason: `${action} from ${rungText(escalation.from)} to ${rungText(escalation.to)}: ${REASON_TEXT[escalation.reason]}`,
        metadata: {
            event: 'task.escalation', from: escalation.from, to: escalation.to, step: escalation.step,
            reason: escalation.reason, modelIndex: escalation.ladder.modelIndex, climbs: escalation.ladder.climbs, ...extra,
        },
    };
}

function splitModel(model: string): { agentAlias: string; modelName: string } {
    const separator = model.indexOf(':');
    return { agentAlias: model.slice(0, separator), modelName: model.slice(separator + 1) };
}

/**
 * The replacement job's agent, model, effort and ladder one step up, when
 * escalation is enabled. Null keeps the replacement on the failed attempt's
 * model and effort (disabled, or nothing left to climb to).
 */
export async function escalateReplacementJob(
    replay: Pick<IssueJobData, 'agentAlias' | 'modelName' | 'reasoningLevel' | 'implementationEscalation'>,
    reason: Exclude<ImplementationEscalationReason, 'repository_validation_failed'>,
    deps: ImplementationEscalationDeps = {},
): Promise<{ jobData: Pick<IssueJobData, 'agentAlias' | 'modelName' | 'reasoningLevel' | 'implementationEscalation'>; escalation: ImplementationEscalation } | null> {
    const settings = await (deps.loadSettings ?? loadImplementationEscalationSettings)();
    if (!settings.enabled || !replay.agentAlias || !replay.modelName) return null;
    const escalation = await planImplementationEscalation({
        model: `${replay.agentAlias}:${replay.modelName}`, effort: replay.reasoningLevel, ladder: replay.implementationEscalation, reason,
    }, settings, deps);
    if (!escalation) {
        deps.logger?.info({ agentAlias: replay.agentAlias, modelName: replay.modelName, reason }, 'Implementation escalation: no higher step left; replacement keeps the same model and effort');
        return null;
    }
    const { agentAlias, modelName } = splitModel(escalation.to.model);
    return {
        jobData: { agentAlias, modelName, reasoningLevel: escalation.to.effort, implementationEscalation: escalation.ladder },
        escalation,
    };
}

// --- Validation follow-up ---

export const VALIDATION_FOLLOWUP_AUTHOR = 'propr-escalation';
const VALIDATION_FOLLOWUP_CLAIM_TTL_SECONDS = 30 * 24 * 60 * 60;
const FAILING_STATUSES = new Set(['failed', 'timed_out', 'killed']);

export type ValidationFollowupOutcome = 'queued' | 'disabled' | 'not_failed' | 'no_pull_request' | 'ladder_exhausted' | 'duplicate';

export interface ValidationFollowupParams {
    taskId: string;
    issueRef: IssueJobData;
    agentAlias: string;
    modelName: string;
    claudeResult: Pick<ClaudeCodeResponse, 'success' | 'reasoningLevel' | 'repositoryValidationResult'> | null;
    pullRequest: { number: number; url?: string } | null | undefined;
    correlatedLogger: Pick<Logger, 'info' | 'warn'>;
}

export interface ValidationFollowupDeps extends ImplementationEscalationDeps {
    /** Atomic once-only claim; resolves false when this task already had its follow-up. */
    claim?: (key: string, ttlSeconds: number) => Promise<boolean>;
    release?: (key: string) => Promise<void>;
    enqueue?: (data: CommentJobData, jobId: string) => Promise<void>;
    recordEvent?: (taskId: string, event: ReturnType<typeof implementationEscalationEvent>) => Promise<void>;
    postComment?: (owner: string, repo: string, issueNumber: number, body: string) => Promise<void>;
    randomId?: () => string;
}

function shortHash(value: string): string {
    return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/** The validation follow-up claim key; one follow-up per implementation task. */
export function validationFollowupClaimKey(taskId: string): string {
    return `implementation-escalation:validation-followup:${shortHash(taskId)}`;
}

export function buildValidationFollowupRequest(result: RepositoryValidationResult, escalation: ImplementationEscalation): string {
    const failing = result.commands.filter(entry => FAILING_STATUSES.has(entry.status));
    return [
        'Repository validation failed for this pull request. Fix the code so that these validation commands pass, then run them again to confirm:',
        '',
        ...failing.map(entry => `- \`${entry.command.replace(/`/g, '\'')}\`: ${describeRepositoryValidationStatus(entry)}`),
        '',
        `Triggered automatically by implementation escalation (${rungText(escalation.to)}).`,
    ].join('\n');
}

function validationFollowupNotice(escalation: ImplementationEscalation): string {
    return `🔁 **Repository validation failed.** One automatic follow-up will try to fix the failing commands with ${rungText(escalation.to)}`
        + ` (this run used ${rungText(escalation.from)}). Its spend counts toward this task's spend cap.`;
}

async function recordTimelineEvent(taskId: string, event: ReturnType<typeof implementationEscalationEvent>): Promise<void> {
    const state = (await getStateManager().getTaskState(taskId))?.state;
    await db('task_history').insert({
        task_id: taskId, state: state ?? 'completed', timestamp: new Date().toISOString(),
        reason: event.reason, metadata: JSON.stringify(event.metadata),
    });
}

async function postIssueComment(owner: string, repo: string, issueNumber: number, body: string): Promise<void> {
    const octokit = await getAuthenticatedOctokit();
    await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', { owner, repo, issue_number: issueNumber, body });
}

async function issueRedis() {
    // Loaded lazily: the worker's Redis connection opens on import.
    return (await import('./issueJob/config.js')).redisClient;
}

const DEFAULT_FOLLOWUP_DEPS: Required<Pick<ValidationFollowupDeps, 'claim' | 'release' | 'enqueue' | 'recordEvent' | 'postComment' | 'randomId'>> = {
    claim: async (key, ttl) => await (await issueRedis()).set(key, '1', 'EX', ttl, 'NX') === 'OK',
    release: async key => { await (await issueRedis()).del(key); },
    enqueue: async (data, jobId) => { await issueQueue.add('processPullRequestComment', data, { jobId }); },
    recordEvent: recordTimelineEvent,
    postComment: postIssueComment,
    randomId: randomUUID,
};

function validationFollowupJob(
    params: ValidationFollowupParams, escalation: ImplementationEscalation,
    run: { pullRequestNumber: number; validation: RepositoryValidationResult; correlationId: string },
): CommentJobData {
    const { pullRequestNumber, validation, correlationId } = run;
    const { taskId, issueRef } = params;
    const effort = escalation.to.effort ? { effort: escalation.to.effort } : {};
    return {
        ...(issueRef.userId ? { userId: issueRef.userId } : {}),
        pullRequestNumber, repoOwner: issueRef.repoOwner, repoName: issueRef.repoName, llm: escalation.to.model, correlationId,
        ...(effort.effort ? { reasoningLevel: effort.effort } : {}),
        effortEscalation: { model: escalation.to.model, ...effort, reason: 'repository_validation_failed', sourceTaskId: taskId },
        // The follow-up spends from the same cap as the task and its replaced attempts.
        ...(issueRef.maxCostUsd === undefined ? {} : { maxCostUsd: issueRef.maxCostUsd }),
        costBudgetTaskIds: [...new Set([...(issueRef.costBudgetTaskIds ?? []), taskId])],
        comments: [{ id: 0, body: buildValidationFollowupRequest(validation, escalation), author: VALIDATION_FOLLOWUP_AUTHOR, type: 'issue' }],
    };
}

/**
 * After an implementation run opened a pull request whose repository validation
 * failed, queues one follow-up on it, one step up the ladder, asking the agent to
 * fix the failing commands. Off unless enabled; at most once per task. The
 * follow-up's spend counts toward the task's spend cap with the lineage's.
 */
export async function requestValidationFollowup(params: ValidationFollowupParams, deps: ValidationFollowupDeps = {}): Promise<ValidationFollowupOutcome> {
    const { taskId, issueRef, claudeResult, pullRequest, correlatedLogger } = params;
    const validation = claudeResult?.repositoryValidationResult;
    if (!claudeResult?.success || validation?.overall !== 'failed') return 'not_failed';
    if (!pullRequest?.number) return 'no_pull_request';
    const settings = await (deps.loadSettings ?? loadImplementationEscalationSettings)();
    if (!settings.validationFollowupEnabled) return 'disabled';
    const escalation = await planImplementationEscalation({
        model: `${params.agentAlias}:${params.modelName}`, effort: claudeResult.reasoningLevel ?? issueRef.reasoningLevel,
        ladder: issueRef.implementationEscalation, reason: 'repository_validation_failed',
    }, settings, { logger: correlatedLogger, ...deps });
    if (!escalation) {
        correlatedLogger.info({ taskId, pullRequestNumber: pullRequest.number }, 'Repository validation failed, but the escalation ladder has no higher step; no automatic follow-up');
        return 'ladder_exhausted';
    }
    const io = { ...DEFAULT_FOLLOWUP_DEPS, ...deps };
    const key = validationFollowupClaimKey(taskId);
    if (!await io.claim(key, VALIDATION_FOLLOWUP_CLAIM_TTL_SECONDS)) return 'duplicate';
    const jobId = `pr-validation-followup-${issueRef.repoOwner}-${issueRef.repoName}-${pullRequest.number}-${shortHash(taskId)}`;
    try {
        await io.enqueue(validationFollowupJob(params, escalation, { pullRequestNumber: pullRequest.number, validation, correlationId: io.randomId() }), jobId);
    } catch (error) {
        await io.release(key).catch(() => undefined);
        throw error;
    }
    const event = implementationEscalationEvent(escalation, { pullRequestNumber: pullRequest.number, followupJobId: jobId });
    await io.recordEvent(taskId, event).catch(error => {
        correlatedLogger.warn({ taskId, error: (error as Error).message }, 'Could not record the escalation on the task timeline');
    });
    await io.postComment(issueRef.repoOwner, issueRef.repoName, pullRequest.number, validationFollowupNotice(escalation)).catch(error => {
        correlatedLogger.warn({ taskId, error: (error as Error).message }, 'Could not post the validation follow-up notice');
    });
    correlatedLogger.info({ taskId, pullRequestNumber: pullRequest.number, from: escalation.from, to: escalation.to, step: escalation.step, jobId }, 'Implementation escalation: queued validation follow-up');
    return 'queued';
}
