import { createHash, randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { ReasoningLevel } from '@propr/shared';
import {
    db, describeRepositoryValidationStatus, getAuthenticatedOctokit, getStateManager, issueQueue, loadImplementationEscalationSettings,
    type ClaudeCodeResponse, type CommentJobData, type ImplementationEscalationLadder, type ImplementationEscalationSettings,
    type IssueJobData, type RepositoryValidationResult,
} from '@propr/core';
import { escalateOneStep, type EscalationModel, type EscalationStep } from './ultrafixEscalationPolicy.js';
import { canonicalModelId, resolveHandoffCandidate, resolveModel, type CandidateSkip } from './ultrafixEscalation.js';

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
    /** The canonical agent:model ID of a configured entry (bare IDs and aliases resolved), or null when unresolvable. */
    canonicalModel?: (model: string) => Promise<string | null>;
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

const EFFORT_SUFFIX = /-(low|medium|high)$/;

/** Whether `id` names the same model as `rung`, ignoring an effort encoded in the model ID. */
function sameModel(id: string, rung: EscalationModel): boolean {
    return rung.effortInModel ? id.replace(EFFORT_SUFFIX, '') === rung.model.replace(EFFORT_SUFFIX, '') : id === rung.model;
}

/** The current model, then the configured handoff models by canonical ID, without aliases of an earlier entry. */
async function initialLadderModels(current: EscalationModel, configured: string[], canonical: (model: string) => Promise<string>): Promise<string[]> {
    const models = [current.model];
    for (const entry of configured) {
        const id = await canonical(entry);
        if (!sameModel(id, current) && !models.includes(id)) models.push(id);
    }
    return models;
}

/** Computes one ladder step for a run on `model` at `effort`, or null when the ladder has no step left. */
export async function planImplementationEscalation(
    input: { model: string; effort?: ReasoningLevel; ladder?: ImplementationEscalationLadder; reason: ImplementationEscalationReason },
    settings: Pick<ImplementationEscalationSettings, 'models' | 'maxReasoningLevels'>,
    deps: ImplementationEscalationDeps = {},
): Promise<ImplementationEscalation | null> {
    const resolveCurrent = deps.resolveCurrent ?? ((model: string, effort?: ReasoningLevel) => resolveModel(model, false, effort));
    const resolveCandidate = deps.resolveCandidate ?? resolveHandoffCandidate;
    const canonical = async (model: string) => await (deps.canonicalModel ?? canonicalModelId)(model) ?? model;
    const current = await resolveCurrent(input.model, input.effort);
    if (!current) return null;
    // A lineage keeps the ladder it started with; settings changes apply to new lineages.
    const ladder = input.ladder ?? {
        models: await initialLadderModels(current, settings.models, canonical),
        maxReasoningLevels: settings.maxReasoningLevels, modelIndex: 0, climbs: 0,
    };
    const from = { model: current.model, ...(current.effort ? { effort: current.effort } : {}) };
    const state = { models: ladder.models, maxReasoningLevels: ladder.maxReasoningLevels, modelIndex: ladder.modelIndex, climbs: ladder.climbs, current: { ...current } };
    const skipped: CandidateSkip[] = [];
    // Rungs already run by this lineage; an alias of one of them would restart it at its base effort.
    const used = await Promise.all(ladder.models.slice(0, ladder.modelIndex + 1).map(canonical));
    const step = await escalateOneStep(state, async candidate => {
        const resolved = await resolveCandidate(candidate, skipped);
        if (!resolved || !(sameModel(current.model, resolved) || sameModel(resolved.model, current) || used.some(id => sameModel(id, resolved)))) return resolved;
        skipped.push({ candidate, reason: 'equivalent_model', resolvedModel: resolved.model });
        return null;
    });
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
    /** Atomically reserves the task's follow-up as pending delivery; false when a reservation already exists. */
    claim?: (key: string, ttlSeconds: number) => Promise<boolean>;
    /** The reservation state: 'pending' until the follow-up is queued, then 'delivered'; null when none. */
    readClaim?: (key: string) => Promise<string | null>;
    /** Atomically moves a pending reservation to delivered; false when it was not pending (another invocation finished it). */
    completeClaim?: (key: string, ttlSeconds: number) => Promise<boolean>;
    /** Drops a reservation that is still pending. */
    release?: (key: string) => Promise<void>;
    enqueue?: (data: CommentJobData, jobId: string) => Promise<void>;
    jobExists?: (jobId: string) => Promise<boolean>;
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

const CLAIM_PENDING = 'pending';
const CLAIM_DELIVERED = 'delivered';
const COMPLETE_CLAIM_SCRIPT = "if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3]) return 1 end return 0";
const RELEASE_CLAIM_SCRIPT = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0";

type FollowupIo = Required<Pick<ValidationFollowupDeps, 'claim' | 'readClaim' | 'completeClaim' | 'release' | 'enqueue' | 'jobExists' | 'recordEvent' | 'postComment' | 'randomId'>>;

const DEFAULT_FOLLOWUP_DEPS: FollowupIo = {
    claim: async (key, ttl) => await (await issueRedis()).set(key, CLAIM_PENDING, 'EX', ttl, 'NX') === 'OK',
    readClaim: async key => await (await issueRedis()).get(key),
    completeClaim: async (key, ttl) => Number(await (await issueRedis()).eval(COMPLETE_CLAIM_SCRIPT, 1, key, CLAIM_PENDING, CLAIM_DELIVERED, String(ttl))) === 1,
    release: async key => { await (await issueRedis()).eval(RELEASE_CLAIM_SCRIPT, 1, key, CLAIM_PENDING); },
    enqueue: async (data, jobId) => { await issueQueue.add('processPullRequestComment', data, { jobId }); },
    jobExists: async jobId => Boolean(await issueQueue.getJob(jobId)),
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
 * Reserves the task's follow-up. A reservation still pending was left by an
 * invocation that stopped before delivering it (or is delivering it now), so it
 * is recovered rather than counted as a completed follow-up.
 */
async function reserveValidationFollowup(io: FollowupIo, key: string): Promise<'claimed' | 'recovered' | 'delivered'> {
    for (let attempt = 0; attempt < 2; attempt++) {
        if (await io.claim(key, VALIDATION_FOLLOWUP_CLAIM_TTL_SECONDS)) return 'claimed';
        const state = await io.readClaim(key);
        if (state === CLAIM_PENDING) return 'recovered';
        // Gone between the two reads (released or expired): claim again once.
        if (state !== null) return 'delivered';
    }
    return 'delivered';
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
    const io: FollowupIo = { ...DEFAULT_FOLLOWUP_DEPS, ...deps };
    const key = validationFollowupClaimKey(taskId);
    const jobId = `pr-validation-followup-${issueRef.repoOwner}-${issueRef.repoName}-${pullRequest.number}-${shortHash(taskId)}`;
    const reservation = await reserveValidationFollowup(io, key);
    if (reservation === 'delivered') return 'duplicate';
    try {
        // A recovered reservation may already have its job queued; the deterministic job ID keeps a re-add idempotent.
        if (reservation === 'claimed' || !await io.jobExists(jobId)) {
            await io.enqueue(validationFollowupJob(params, escalation, { pullRequestNumber: pullRequest.number, validation, correlationId: io.randomId() }), jobId);
        }
    } catch (error) {
        await io.release(key).catch(() => undefined);
        throw error;
    }
    // Only the invocation that marks the reservation delivered reports it, so a concurrent recovery posts one notice.
    if (!await io.completeClaim(key, VALIDATION_FOLLOWUP_CLAIM_TTL_SECONDS)) return 'duplicate';
    if (reservation === 'recovered') correlatedLogger.info({ taskId, jobId }, 'Implementation escalation: recovered an interrupted validation follow-up reservation');
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
