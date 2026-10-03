import { ANTIGRAVITY_MODELS, getReasoningLevelsForAgentType, type ModelReasoningLevel } from '@propr/shared';

export const ANTIGRAVITY_MODEL_LABELS: Record<string, string> = {
    'antigravity-gemini-3.8-flash-medium': 'Gemini 3.8 Flash (Medium)',
    'antigravity-gemini-3.8-flash-high': 'Gemini 3.8 Flash (High)',
    'antigravity-gemini-3.8-flash-low': 'Gemini 3.8 Flash (Low)',
    'antigravity-gemini-3.7-flash-medium': 'Gemini 3.7 Flash (Medium)',
    'antigravity-gemini-3.7-flash-high': 'Gemini 3.7 Flash (High)',
    'antigravity-gemini-3.7-flash-low': 'Gemini 3.7 Flash (Low)',
    'antigravity-gemini-3.6-flash-medium': 'Gemini 3.6 Flash (Medium)',
    'antigravity-gemini-3.6-flash-high': 'Gemini 3.6 Flash (High)',
    'antigravity-gemini-3.6-flash-low': 'Gemini 3.6 Flash (Low)',
    'antigravity-gemini-3.5-flash-medium': 'Gemini 3.5 Flash (Medium)',
    'antigravity-gemini-3.5-flash-high': 'Gemini 3.5 Flash (High)',
    'antigravity-gemini-3.5-flash-low': 'Gemini 3.5 Flash (Low)',
    'antigravity-gemini-3.1-pro-low': 'Gemini 3.1 Pro (Low)',
    'antigravity-gemini-3.1-pro-high': 'Gemini 3.1 Pro (High)',
    'antigravity-claude-sonnet-5.5-medium': 'Claude Sonnet 5.5 (Medium)',
    'antigravity-claude-sonnet-5.5-high': 'Claude Sonnet 5.5 (High)',
    'antigravity-claude-sonnet-5.5-low': 'Claude Sonnet 5.5 (Low)',
    'antigravity-claude-opus-5.5-medium': 'Claude Opus 5.5 (Medium)',
    'antigravity-claude-opus-5.5-high': 'Claude Opus 5.5 (High)',
    'antigravity-claude-opus-5.5-low': 'Claude Opus 5.5 (Low)',
    'antigravity-gpt-oss-120b-medium': 'GPT-OSS 120B (Medium)'
};

// ProPR namespaces Antigravity model IDs to avoid collisions with other agents.
// Gemini 3.8 and 3.7 use exact external IDs. Other models use the CLI's
// human-readable model and effort name, e.g. "Claude Sonnet 5.5 (High)".
// Keep the effort in the --model argument so the CLI selects the requested tier.
//
// Bare slugs are unreliable: older models such as gemini-3.1-pro-high silently
// fall back to the default. Keep the established display-name mapping for those
// models instead of relying on namespace stripping.
// ANTIGRAVITY_MODEL_LABELS also supplies display names for parsed output.
const ANTIGRAVITY_CANONICAL_MODEL_IDS: Record<string, string> = {
    'antigravity-gemini-3.8-flash-high': 'gemini-3.8-flash-high',
    'antigravity-gemini-3.8-flash-medium': 'gemini-3.8-flash-medium',
    'antigravity-gemini-3.8-flash-low': 'gemini-3.8-flash-low',
    'antigravity-gemini-3.7-flash-high': 'gemini-3.7-flash-high',
    'antigravity-gemini-3.7-flash-medium': 'gemini-3.7-flash-medium',
    'antigravity-gemini-3.7-flash-low': 'gemini-3.7-flash-low',
};

export function toAntigravityCliModelId(modelName: string, reasoningLevel?: ModelReasoningLevel): string {
    // Strip an optional `antigravity:` route prefix (agent:model format).
    const withoutRoutePrefix = modelName.startsWith('antigravity:')
        ? modelName.slice('antigravity:'.length)
        : modelName;

    const baseModel = ANTIGRAVITY_MODELS.find(model => model.id === withoutRoutePrefix);
    if (baseModel) {
        const levels = getReasoningLevelsForAgentType('antigravity', baseModel.id);
        // Medium is the neutral fallback; higher system levels map to High.
        // Pro has no Medium, so ties prefer the more capable level.
        const preferred = reasoningLevel === 'low' ? 'low'
            : !reasoningLevel || reasoningLevel === 'auto' || reasoningLevel === 'medium' ? 'medium' : 'high';
        const level = levels.includes(preferred) ? preferred : levels.includes('high') ? 'high' : levels[0];
        return toAntigravityCliModelId(`${baseModel.id}-${level}`);
    }

    const canonicalModelId = ANTIGRAVITY_CANONICAL_MODEL_IDS[withoutRoutePrefix];
    if (canonicalModelId) return canonicalModelId;

    const displayName = ANTIGRAVITY_MODEL_LABELS[withoutRoutePrefix];
    if (displayName) return displayName;

    // Fallback for unmapped models: strip ProPR's `antigravity-` namespace
    // prefix. Prefer adding a label to ANTIGRAVITY_MODEL_LABELS over relying on
    // this — the bare slug may not be accepted by the CLI.
    return withoutRoutePrefix.startsWith('antigravity-')
        ? withoutRoutePrefix.slice('antigravity-'.length)
        : withoutRoutePrefix;
}

export function antigravityModelIdsMatch(requestedModel: string, reportedModel: string): boolean {
    const baseModel = requestedModel.replace(/^antigravity:/, '');
    if (ANTIGRAVITY_MODELS.some(model => model.id === baseModel)) {
        return getReasoningLevelsForAgentType('antigravity', baseModel).some(level =>
            reportedModel === `${baseModel}-${level}` || reportedModel === toAntigravityCliModelId(baseModel, level)
        ) || reportedModel === baseModel;
    }
    return reportedModel === requestedModel
        || reportedModel === toAntigravityCliModelId(requestedModel);
}
