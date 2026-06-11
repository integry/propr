import { ANTIGRAVITY_MODEL_LABELS } from './utils/antigravityOutputParser.js';

// ProPR namespaces Antigravity model IDs with an `antigravity-` prefix so they
// don't collide with other agents' models in config/labels (see
// ANTIGRAVITY_MODELS in modelDefinitions). The Antigravity CLI (`agy --model`)
// expects the model's HUMAN-READABLE display name exactly as `agy models` lists
// it — e.g. "Gemini 3.1 Pro (High)", "Claude Sonnet 4.6 (Thinking)" — NOT a slug.
//
// Slugs are unreliable: some happen to resolve (`gpt-oss-120b-medium`) while
// others silently fall back to the default model (`gemini-3.1-pro-high`,
// `claude-sonnet-4-6-thinking`). The display name works for every model and tier,
// verified against the image with `agy -p "..." --model "<display name>"`.
//
// ANTIGRAVITY_MODEL_LABELS (ProPR id -> display name) is the single source of
// truth and is also used to render model names in parsed output.
//   'antigravity-gemini-3.1-pro-high'        -> 'Gemini 3.1 Pro (High)'
//   'antigravity-claude-sonnet-4.6-thinking' -> 'Claude Sonnet 4.6 (Thinking)'
export function toAntigravityCliModelId(modelName: string): string {
    // Strip an optional `antigravity:` route prefix (agent:model format).
    const withoutRoutePrefix = modelName.startsWith('antigravity:')
        ? modelName.slice('antigravity:'.length)
        : modelName;

    const displayName = ANTIGRAVITY_MODEL_LABELS[withoutRoutePrefix];
    if (displayName) return displayName;

    // Fallback for unmapped models: strip ProPR's `antigravity-` namespace
    // prefix. Prefer adding a label to ANTIGRAVITY_MODEL_LABELS over relying on
    // this — the bare slug may not be accepted by the CLI.
    return withoutRoutePrefix.startsWith('antigravity-')
        ? withoutRoutePrefix.slice('antigravity-'.length)
        : withoutRoutePrefix;
}
