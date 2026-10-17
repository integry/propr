import { ANTIGRAVITY_MODELS, REASONING_LEVELS, getReasoningLevelsForAgentType, getAntigravityCompatibilityRoute, type ModelReasoningLevel } from '@propr/shared';

// Runtime identities outlive the selectable catalog so saved defaults keep working.
const ANTIGRAVITY_RUNTIME_MODELS = [
    ...ANTIGRAVITY_MODELS,
    ...['3.6', '3.7'].map(version => ({
        id: `antigravity-gemini-${version}-flash`,
        shortName: `Gemini ${version} Flash`,
        shortAlias: `flash${version.replace('.', '')}`,
    })),
];

export const ANTIGRAVITY_MODEL_LABELS: Record<string, string> = Object.fromEntries(
    ANTIGRAVITY_RUNTIME_MODELS.map(model => [model.id, model.shortName])
);

export { ANTIGRAVITY_COMPATIBILITY_ROUTES, ANTIGRAVITY_COMPATIBILITY_ALIASES, getAntigravityCompatibilityRoute } from '@propr/shared';

export function antigravitySupportedModel(config: { type: string; supportedModels: string[] }, id: string): boolean {
    const base = config.type === 'antigravity' ? getAntigravityCompatibilityRoute(id)?.model ?? id : id;
    return config.supportedModels.some(model => model.toLowerCase() === base.toLowerCase());
}

// `agy models` IDs: Gemini keeps its version dot, Claude uses dashes (claude-opus-5-5-high).
// Gemini 3.6 Flash predates these IDs and keeps the display-name form.
function antigravityCliModelBase(model: { id: string; shortAlias: string }): string | undefined {
    if (model.shortAlias === 'flash36') return undefined;
    const base = model.id.slice('antigravity-'.length);
    return base.startsWith('claude-') ? base.replace(/\./g, '-') : base;
}

function antigravityDisplayModelId(model: { shortName: string }, level: ModelReasoningLevel): string {
    return `${model.shortName} (${level[0].toUpperCase()}${level.slice(1)})`;
}

export function toAntigravityCliModelId(modelName: string, reasoningLevel?: ModelReasoningLevel): string {
    const route = getAntigravityCompatibilityRoute(modelName);
    const modelId = route?.model ?? modelName.replace(/^antigravity:/, '');
    reasoningLevel ??= route?.effort;
    const model = ANTIGRAVITY_RUNTIME_MODELS.find(candidate => candidate.id === modelId);
    // Explicitly configured custom IDs are passed through without catalog effort encoding.
    if (!model) return modelId.replace(/^antigravity-/, '');

    const levels = getReasoningLevelsForAgentType('antigravity', model.id);
    // Start at the requested effort and go down to the closest supported level.
    const preferred = !reasoningLevel || reasoningLevel === 'auto' ? 'medium' : reasoningLevel;
    const preferredIndex = REASONING_LEVELS.indexOf(preferred);
    // Use the lowest supported effort when none is at or below the request (GPT-OSS).
    const level = [...levels].reverse().find(candidate =>
        REASONING_LEVELS.indexOf(candidate) <= preferredIndex
    ) ?? levels[0];
    // The CLI encodes effort; selectable model IDs remain independent of effort.
    const base = antigravityCliModelBase(model);
    return base ? `${base}-${level}` : antigravityDisplayModelId(model, level);
}

/** Preserve the effort reported by the provider independently of catalog identity. */
export function antigravityReportedIdentity(reported: string): { model: string; effort?: ModelReasoningLevel } {
    const route = getAntigravityCompatibilityRoute(reported);
    if (route) return { model: route.model, effort: route.effort };
    for (const model of ANTIGRAVITY_RUNTIME_MODELS) {
        if (reported === model.id) return { model: model.id };
        const base = antigravityCliModelBase(model);
        for (const effort of getReasoningLevelsForAgentType('antigravity', model.id)) {
            // Streams may report either the CLI ID or the display name.
            if ((base && reported === `${base}-${effort}`)
                || reported === `${model.id.slice('antigravity-'.length)}-${effort}`
                || reported === antigravityDisplayModelId(model, effort)) {
                return { model: model.id, effort };
            }
        }
    }
    return { model: reported };
}

export function antigravityModelIdsMatch(requestedModel: string, reportedModel: string): boolean {
    const requested = antigravityReportedIdentity(requestedModel.replace(/^antigravity:/, ''));
    const reported = antigravityReportedIdentity(reportedModel);
    if (!ANTIGRAVITY_RUNTIME_MODELS.some(model => model.id === requested.model)) {
        return toAntigravityCliModelId(requestedModel) === reportedModel;
    }
    return requested.model === reported.model && (!requested.effort || !reported.effort || requested.effort === reported.effort);
}
