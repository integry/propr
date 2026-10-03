import type { Redis } from 'ioredis';
import { getReasoningLevelsForAgentType, type ReasoningLevel } from '@propr/shared';
import {
    AgentRegistry, loadUltrafixEscalationSettings, loadModelReasoningLevel,
    resolveAgentModelReasoningLevel, resolveConfiguredModel, resolveLlmLabel, resolveRuntimeModelReasoningLevel,
} from '@propr/core';
import { loadState, saveUltrafixStateIfCurrent, type UltrafixLoopState } from './ultrafixOrchestrationService.js';
import { advanceEscalation, type EscalationModel } from './ultrafixEscalationPolicy.js';

async function resolveModel(model: string | null | undefined, checkUsage: boolean, overrideEffort?: ReasoningLevel): Promise<EscalationModel | null> {
    const configuredModel = await resolveConfiguredModel(model);
    const { agentAlias: alias, model: id } = await resolveLlmLabel(configuredModel);
    const resolved = `${alias}:${id}`;
    const registry = AgentRegistry.getInstance();
    await registry.ensureInitialized();
    const agent = registry.getAgentByAlias(alias);
    if (!agent?.config.enabled || !agent.config.supportedModels.includes(id)) return null;
    if (checkUsage) {
        // Missing, stale, disabled, or failed usage monitoring never blocks a handoff.
        try {
            const { AliasSpecificAgentTankSnapshotProvider } = await import('../../packages/core/src/services/syntheticUsageSnapshotProvider.js');
            const usage = await new AliasSpecificAgentTankSnapshotProvider().getSnapshot(alias);
            if (usage && Math.max(usage.sessionPercent ?? 0, usage.weeklyPercent ?? 0) >= 90) return null;
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
    await advanceEscalation(current.escalation, score, async model => {
        try { return await resolveModel(model, true); } catch { return null; }
    });
    return await persist(redis, current) ? current : null;
}
