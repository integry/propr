import { ANTIGRAVITY_MODELS, getReasoningLevelsForAgentType, type ModelReasoningLevel } from '@propr/shared';

export const ANTIGRAVITY_MODEL_LABELS: Record<string, string> = Object.fromEntries(
    ANTIGRAVITY_MODELS.map(model => [model.id, model.shortName])
);

export function toAntigravityCliModelId(modelName: string, reasoningLevel?: ModelReasoningLevel): string {
    const modelId = modelName.replace(/^antigravity:/, '');
    const model = ANTIGRAVITY_MODELS.find(candidate => candidate.id === modelId);
    if (!model) throw new Error(`Unsupported Antigravity model: ${modelName}`);

    const levels = getReasoningLevelsForAgentType('antigravity', model.id);
    // Medium is the neutral fallback. Pro has no Medium, so ties prefer High.
    const preferred = reasoningLevel === 'low' ? 'low'
        : !reasoningLevel || reasoningLevel === 'auto' || reasoningLevel === 'medium' ? 'medium' : 'high';
    const level = levels.includes(preferred) ? preferred : levels.includes('high') ? 'high' : levels[0];
    // The CLI encodes effort in its argument; configuration always stores a base ID.
    if (model.shortAlias === 'flash38' || model.shortAlias === 'flash37') {
        return `${model.id.slice('antigravity-'.length)}-${level}`;
    }
    return `${model.shortName} (${level[0].toUpperCase()}${level.slice(1)})`;
}

export function antigravityModelIdsMatch(requestedModel: string, reportedModel: string): boolean {
    const baseModel = requestedModel.replace(/^antigravity:/, '');
    if (!ANTIGRAVITY_MODELS.some(model => model.id === baseModel)) return false;
    return reportedModel === baseModel || getReasoningLevelsForAgentType('antigravity', baseModel).some(level =>
        reportedModel === toAntigravityCliModelId(baseModel, level)
        || reportedModel === `${ANTIGRAVITY_MODEL_LABELS[baseModel]} (${level[0].toUpperCase()}${level.slice(1)})`
    );
}
