import type { Redis } from 'ioredis';
import { getReasoningLevelsForAgentType, type ReasoningLevel } from '@propr/shared';
import {
    AgentRegistry, logger, loadUltrafixEscalationSettings, loadModelReasoningLevel,
    resolveAgentModelReasoningLevel, resolveConfiguredModel, resolveLlmLabel, resolveRuntimeModelReasoningLevel,
} from '@propr/core';
import { loadState, saveUltrafixStateIfCurrent, type UltrafixLoopState } from './ultrafixOrchestrationService.js';
import { advanceEscalation, type EscalationModel } from './ultrafixEscalationPolicy.js';

type CandidateSkip = {
    candidate: string;
    reason: 'agent_unavailable' | 'agent_disabled' | 'model_unsupported' | 'usage_limit' | 'model_resolution_failed';
    resolvedModel?: string;
    sessionPercent?: number;
    weeklyPercent?: number;
};

function availabilitySkipReason(
    agent: ReturnType<ReturnType<typeof AgentRegistry.getInstance>['getAgentByAlias']>, id: string,
): CandidateSkip['reason'] | undefined {
    if (!agent) return 'agent_unavailable';
    if (!agent.config.enabled) return 'agent_disabled';
    if (!agent.config.supportedModels.includes(id)) return 'model_unsupported';
    return undefined;
}

async function resolveModel(
    model: string | null | undefined, checkUsage: boolean, overrideEffort?: ReasoningLevel,
    onSkip?: (details: Omit<CandidateSkip, 'candidate'>) => void,
): Promise<EscalationModel | null> {
    const configuredModel = await resolveConfiguredModel(model);
    const { agentAlias: alias, model: id } = await resolveLlmLabel(configuredModel);
    const resolved = `${alias}:${id}`;
    const registry = AgentRegistry.getInstance();
    await registry.ensureInitialized();
    const agent = registry.getAgentByAlias(alias);
    const skipReason = availabilitySkipReason(agent, id);
    if (skipReason) {
        onSkip?.({ resolvedModel: resolved, reason: skipReason });
        return null;
    }
    if (!agent) return null;
    if (checkUsage) {
        // Missing, stale, disabled, or failed usage monitoring never blocks a handoff.
        try {
            const { AliasSpecificAgentTankSnapshotProvider } = await import('../../packages/core/src/services/syntheticUsageSnapshotProvider.js');
            const usage = await new AliasSpecificAgentTankSnapshotProvider().getSnapshot(alias);
            if (usage && Math.max(usage.sessionPercent ?? 0, usage.weeklyPercent ?? 0) >= 90) {
                onSkip?.({ resolvedModel: resolved, reason: 'usage_limit', sessionPercent: usage.sessionPercent, weeklyPercent: usage.weeklyPercent });
                return null;
            }
        } catch { /* Escalation remains available without a usage signal. */ }
    }
    let levels: readonly ReasoningLevel[] = getReasoningLevelsForAgentType(agent.config.type, id).filter(level => level !== 'auto');
    const effortInModel = agent.config.type === 'antigravity' && levels.length > 0;
    if (effortInModel) {
        levels = levels.filter(level => agent.config.supportedModels.includes(id.replace(/-(low|medium|high)$/, `-${level}`)));
    }
    const configured = overrideEffort ?? resolveAgentModelReasoningLevel(agent.config.modelReasoningLevels, id) ?? await loadModelReasoningLevel();
    const runtime = resolveRuntimeModelReasoningLevel(agent.config.type, configured);
    const embedded = id.match(/-(low|medium|high)$/)?.[1] as ReasoningLevel | undefined;
    return {
        model: resolved, levels, effortInModel,
        effort: effortInModel ? embedded : runtime && levels.includes(runtime) ? runtime : undefined,
    };
}

/** Called after normal PR model/label resolution, before executing a fix. */
export async function resolveUltrafixFixExecution(input: {
    redis: Redis; owner: string; repo: string; pr: number; workEpoch: number;
    model: string | null | undefined; effort?: ReasoningLevel;
}): Promise<{ model: string | null | undefined; effort?: ReasoningLevel }> {
    const original = { model: input.model, effort: input.effort };
    const state = await loadState(input.redis, input.owner, input.repo, input.pr);
    if (!state?.active || state.workEpoch !== input.workEpoch) return original;
    const settings = await loadUltrafixEscalationSettings();
    if (!settings.enabled) return original;
    if (!state.escalation) {
        const base = await resolveModel(input.model, false, input.effort);
        if (!base) return original;
        state.escalation = {
            models: [base.model, ...settings.models], modelIndex: 0,
            patience: settings.patience, maxReasoningLevels: settings.maxReasoningLevels,
            current: base, climbs: 0, bestScore: state.escalationBestScore ?? null, stalledReviews: 0, exhausted: false,
        };
        const saved = await persist(input.redis, state);
        if (!saved) return original;
    }
    return { model: state.escalation.current.model, effort: state.escalation.modelIndex === 0 && state.escalation.climbs === 0 ? input.effort : state.escalation.current.effort };
}

function persist(redis: Redis, state: UltrafixLoopState): Promise<boolean> {
    return saveUltrafixStateIfCurrent(redis, state, state.workEpoch, JSON.stringify(state));
}

export async function recordUltrafixEscalationReview(
    redis: Redis, state: UltrafixLoopState, score: number,
): Promise<UltrafixLoopState | null> {
    // Reload after findings were recorded, preserving their lifecycle updates.
    const current = await loadState(redis, state.owner, state.repo, state.pr);
    if (!current || current.workEpoch !== state.workEpoch) return null;
    if (!(await loadUltrafixEscalationSettings()).enabled) return current;
    if (!current.escalation) {
        current.escalationBestScore = Math.max(current.escalationBestScore ?? score, score);
        return await persist(redis, current) ? current : null;
    }
    const before = { ...current.escalation.current, modelIndex: current.escalation.modelIndex, climbs: current.escalation.climbs };
    const skipped: CandidateSkip[] = [];
    await advanceEscalation(current.escalation, score, async candidate => {
        try {
            return await resolveModel(candidate, true, undefined, details => skipped.push({ candidate, ...details }));
        } catch {
            skipped.push({ candidate, reason: 'model_resolution_failed' });
            return null;
        }
    });
    // Report only decisions accepted by the epoch-guarded save, after all awaits.
    if (!await persist(redis, current)) return null;
    const context = { owner: current.owner, repo: current.repo, pr: current.pr, workEpoch: current.workEpoch, score, bestScore: current.escalation.bestScore };
    for (const skip of skipped) logger.info({ ...context, ...skip }, 'Ultrafix escalation: candidate skipped');
    const next = current.escalation;
    if (next.climbs > before.climbs && next.modelIndex === before.modelIndex) {
        logger.info({ ...context, fromModel: before.model, toModel: next.current.model, fromEffort: before.effort ?? 'auto', toEffort: next.current.effort, climbs: next.climbs, reason: 'plateau' }, 'Ultrafix escalation: reasoning increased');
    } else if (next.modelIndex !== before.modelIndex && !next.exhausted) {
        logger.info({ ...context, fromModel: before.model, toModel: next.current.model, fromEffort: before.effort ?? 'auto', toEffort: next.current.effort ?? 'auto', modelIndex: next.modelIndex, reason: 'reasoning_limit_reached' }, 'Ultrafix escalation: model handoff');
    }
    return current;
}
