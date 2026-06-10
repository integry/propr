// ProPR namespaces Antigravity model IDs with an `antigravity-` prefix so they
// don't collide with other agents' models in config/labels (see
// ANTIGRAVITY_MODELS in modelDefinitions). The Antigravity CLI (`agy --model`)
// expects the real provider model name WITHOUT that prefix — passing the
// namespaced id makes the CLI fall back to its default model.
//
// This converts a stored/route-prefixed id back to the CLI's native name:
//   'antigravity:antigravity-gpt-oss-120b-medium' -> 'gpt-oss-120b-medium'
//   'antigravity-gemini-3.5-flash-high'           -> 'gemini-3.5-flash-high'
//   'gemini-3.5-flash-high'                        -> 'gemini-3.5-flash-high'
export function toAntigravityCliModelId(modelName: string): string {
    // Strip an optional `antigravity:` route prefix (agent:model format).
    const withoutRoutePrefix = modelName.startsWith('antigravity:')
        ? modelName.slice('antigravity:'.length)
        : modelName;

    // Strip ProPR's `antigravity-` namespace prefix to recover the native id.
    return withoutRoutePrefix.startsWith('antigravity-')
        ? withoutRoutePrefix.slice('antigravity-'.length)
        : withoutRoutePrefix;
}
