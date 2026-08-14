export const ANTIGRAVITY_MODEL_LABELS: Record<string, string> = {
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
    'antigravity-claude-sonnet-4.6-thinking': 'Claude Sonnet 4.6 (Thinking)',
    'antigravity-claude-opus-4.6-thinking': 'Claude Opus 4.6 (Thinking)',
    'antigravity-gpt-oss-120b-medium': 'GPT-OSS 120B (Medium)'
};

// ProPR namespaces Antigravity model IDs with an `antigravity-` prefix so they
// don't collide with other agents' models in config/labels (see
// ANTIGRAVITY_MODELS in modelDefinitions). The Antigravity CLI (`agy --model`)
// expects the exact external ID for Gemini 3.7 models. Older models still use
// the HUMAN-READABLE display name exactly as `agy models` lists it — e.g.
// "Gemini 3.1 Pro (High)" or "Claude Sonnet 4.6 (Thinking)".
//
// Slugs are unreliable: some happen to resolve (`gpt-oss-120b-medium`) while
// others silently fall back to the default model (`gemini-3.1-pro-high`,
// `claude-sonnet-4-6-thinking`). For those older models, the display name is
// verified against the image and avoids silent fallback.
//
// ANTIGRAVITY_MODEL_LABELS remains the single source of truth for display names
// and is also used to render model names in parsed output.
//   'antigravity-gemini-3.1-pro-high'        -> 'Gemini 3.1 Pro (High)'
//   'antigravity-claude-sonnet-4.6-thinking' -> 'Claude Sonnet 4.6 (Thinking)'
const ANTIGRAVITY_CANONICAL_MODEL_IDS: Record<string, string> = {
    'antigravity-gemini-3.7-flash-high': 'gemini-3.7-flash-high',
    'antigravity-gemini-3.7-flash-medium': 'gemini-3.7-flash-medium',
    'antigravity-gemini-3.7-flash-low': 'gemini-3.7-flash-low',
};

export function toAntigravityCliModelId(modelName: string): string {
    // Strip an optional `antigravity:` route prefix (agent:model format).
    const withoutRoutePrefix = modelName.startsWith('antigravity:')
        ? modelName.slice('antigravity:'.length)
        : modelName;

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
    return reportedModel === requestedModel
        || reportedModel === toAntigravityCliModelId(requestedModel);
}
