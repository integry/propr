import { ANTIGRAVITY_MODELS, REASONING_LEVELS, getReasoningLevelsForAgentType, type ModelReasoningLevel } from '@propr/shared';

export const ANTIGRAVITY_MODEL_LABELS: Record<string, string> = Object.fromEntries(
    ANTIGRAVITY_MODELS.map(model => [model.id, model.shortName])
);

// Compatibility routes are deliberately absent from the selectable catalog.
export const ANTIGRAVITY_COMPATIBILITY_ROUTES: Record<string, { model: string; effort: ModelReasoningLevel }> = Object.create(null);
export const ANTIGRAVITY_COMPATIBILITY_ALIASES: Record<string, string> = Object.create(null);
for (const model of ANTIGRAVITY_MODELS) {
    for (const effort of getReasoningLevelsForAgentType('antigravity', model.id)) {
        const id = `${model.id}-${effort}`;
        ANTIGRAVITY_COMPATIBILITY_ROUTES[id] = { model: model.id, effort };
        ANTIGRAVITY_COMPATIBILITY_ALIASES[`antigravity-${model.shortAlias}-${effort}`] = id;
    }
}
for (const family of ['opus', 'sonnet']) {
    const id = `antigravity-claude-${family}-4.6-thinking`;
    ANTIGRAVITY_COMPATIBILITY_ROUTES[id] = { model: `antigravity-claude-${family}-5.5`, effort: 'high' };
    ANTIGRAVITY_COMPATIBILITY_ALIASES[`antigravity-${family}46-thinking`] = id;
}

export function getAntigravityCompatibilityRoute(id: string) {
    const clean = id.toLowerCase().replace(/^antigravity:/, '');
    return ANTIGRAVITY_COMPATIBILITY_ROUTES[clean];
}

export function antigravitySupportedModel(config: { type: string; supportedModels: string[] }, id: string): boolean {
    const base = config.type === 'antigravity' ? getAntigravityCompatibilityRoute(id)?.model ?? id : id;
    return config.supportedModels.some(model => model.toLowerCase() === base.toLowerCase());
}

export function toAntigravityCliModelId(modelName: string, reasoningLevel?: ModelReasoningLevel): string {
    const route = getAntigravityCompatibilityRoute(modelName);
    const modelId = route?.model ?? modelName.replace(/^antigravity:/, '');
    reasoningLevel ??= route?.effort;
    const model = ANTIGRAVITY_MODELS.find(candidate => candidate.id === modelId);
    if (!model) throw new Error(`Unsupported Antigravity model: ${modelName}`);

    const levels = getReasoningLevelsForAgentType('antigravity', model.id);
    // Start at the requested effort and go down to the closest supported level.
    const preferred = !reasoningLevel || reasoningLevel === 'auto' ? 'medium' : reasoningLevel;
    const preferredIndex = REASONING_LEVELS.indexOf(preferred);
    // Use the lowest supported effort when none is at or below the request (GPT-OSS).
    const level = [...levels].reverse().find(candidate =>
        REASONING_LEVELS.indexOf(candidate) <= preferredIndex
    ) ?? levels[0];
    // The CLI encodes effort; selectable model IDs remain independent of effort.
    if (model.shortAlias === 'flash38' || model.shortAlias === 'flash37') {
        return `${model.id.slice('antigravity-'.length)}-${level}`;
    }
    return `${model.shortName} (${level[0].toUpperCase()}${level.slice(1)})`;
}

/** Preserve the effort reported by the provider independently of catalog identity. */
export function antigravityReportedIdentity(reported: string): { model: string; effort?: ModelReasoningLevel } {
    const route = getAntigravityCompatibilityRoute(reported);
    if (route) return { model: route.model, effort: route.effort };
    for (const model of ANTIGRAVITY_MODELS) {
        if (reported === model.id) return { model: model.id };
        for (const effort of getReasoningLevelsForAgentType('antigravity', model.id)) {
            if (reported === `${model.id.slice('antigravity-'.length)}-${effort}`
                || reported === `${model.shortName} (${effort[0].toUpperCase()}${effort.slice(1)})`) {
                return { model: model.id, effort };
            }
        }
    }
    return { model: reported };
}

export function antigravityModelIdsMatch(requestedModel: string, reportedModel: string): boolean {
    const requested = antigravityReportedIdentity(requestedModel.replace(/^antigravity:/, ''));
    const reported = antigravityReportedIdentity(reportedModel);
    return ANTIGRAVITY_MODELS.some(model => model.id === requested.model) && requested.model === reported.model && (!requested.effort || !reported.effort || requested.effort === reported.effort);
}
