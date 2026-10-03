import type { ReasoningLevel } from '@propr/shared';

export interface EscalationModel {
    model: string;
    levels: readonly ReasoningLevel[];
    effort?: ReasoningLevel;
    /** Antigravity effort is encoded in the model ID rather than a CLI dial. */
    effortInModel?: boolean;
}

export interface UltrafixEscalationState {
    models: string[];
    patience: number;
    maxReasoningLevels: number;
    modelIndex: number;
    current: EscalationModel;
    climbs: number;
    bestScore: number | null;
    stalledReviews: number;
    exhausted: boolean;
}

/** Any strict improvement resets patience; the best score spans all models. */
export async function advanceEscalation(
    state: UltrafixEscalationState,
    score: number,
    resolveAvailableModel: (model: string) => Promise<EscalationModel | null>,
): Promise<void> {
    if (state.bestScore === null || score > state.bestScore) {
        state.bestScore = score;
        state.stalledReviews = 0;
        return;
    }
    if (++state.stalledReviews < state.patience) return;
    state.stalledReviews = 0;
    const levels = state.current.levels;
    const index = state.current.effort ? levels.indexOf(state.current.effort) : 0;
    const next = levels[index + 1];
    if (state.climbs < state.maxReasoningLevels && next) {
        state.current.effort = next;
        if (state.current.effortInModel) state.current.model = state.current.model.replace(/-(low|medium|high)$/, `-${next}`);
        state.climbs++;
        return;
    }
    while (++state.modelIndex < state.models.length) {
        const candidate = await resolveAvailableModel(state.models[state.modelIndex]);
        if (!candidate) continue;
        state.current = candidate;
        state.climbs = 0;
        return;
    }
    state.exhausted = true;
}
