// ProPR namespaces Antigravity model IDs with an `antigravity-` prefix so they
// don't collide with other agents' models in config/labels (see
// ANTIGRAVITY_MODELS in modelDefinitions). The Antigravity CLI (`agy --model`)
// expects the provider's own model id, which is NOT a clean transform of the
// ProPR id: Gemini ids keep their version dots (`gemini-3.5-flash-low`,
// `gemini-3.1-pro-low`) while Claude ids use dashes (`claude-sonnet-4-6-thinking`,
// `claude-opus-4-6-thinking`). Passing the wrong form makes `agy` route to its
// default model. Because the scheme is inconsistent, map known models explicitly.
//
// Source of truth: the Antigravity rotator's accepted `--model` ids, verified
// against `agy -p "which model are you?" --model <id>`. The scheme is genuinely
// irregular — note Sonnet's thinking model is `claude-sonnet-4-6` (NO -thinking
// suffix) while Opus's is `claude-opus-4-6-thinking` (WITH suffix), and Gemini
// keeps version dots. Hence an explicit map rather than a string transform.
const ANTIGRAVITY_CLI_MODEL_IDS: Record<string, string> = {
    'antigravity-gemini-3.5-flash-medium': 'gemini-3.5-flash-medium',
    'antigravity-gemini-3.5-flash-high': 'gemini-3.5-flash-high',
    'antigravity-gemini-3.5-flash-low': 'gemini-3.5-flash-low',
    'antigravity-gemini-3.1-pro-low': 'gemini-3.1-pro-low',
    'antigravity-gemini-3.1-pro-high': 'gemini-3.1-pro-high',
    'antigravity-claude-sonnet-4.6-thinking': 'claude-sonnet-4-6', // verified: returns "Claude Sonnet 4.6 (Thinking)"
    'antigravity-claude-opus-4.6-thinking': 'claude-opus-4-6-thinking',
    'antigravity-gpt-oss-120b-medium': 'gpt-oss-120b-medium',
};

// Converts a stored/route-prefixed ProPR id to the Antigravity CLI's native
// model id. Falls back to stripping the `antigravity-` namespace prefix for any
// model not in the explicit map (correct for dot-less ids like gpt-oss; add a
// map entry when introducing a model whose CLI id rewrites version separators).
//   'antigravity:antigravity-claude-opus-4.6-thinking' -> 'claude-opus-4-6-thinking'
//   'antigravity-gemini-3.5-flash-low'                  -> 'gemini-3.5-flash-low'
//   'gpt-oss-120b-medium'                               -> 'gpt-oss-120b-medium'
export function toAntigravityCliModelId(modelName: string): string {
    // Strip an optional `antigravity:` route prefix (agent:model format).
    const withoutRoutePrefix = modelName.startsWith('antigravity:')
        ? modelName.slice('antigravity:'.length)
        : modelName;

    const mapped = ANTIGRAVITY_CLI_MODEL_IDS[withoutRoutePrefix];
    if (mapped) return mapped;

    // Fallback: strip ProPR's `antigravity-` namespace prefix to recover the id.
    return withoutRoutePrefix.startsWith('antigravity-')
        ? withoutRoutePrefix.slice('antigravity-'.length)
        : withoutRoutePrefix;
}
