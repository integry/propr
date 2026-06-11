// Native OpenCode provider prefixes that start with "opencode-" — these are NOT ProPR routing prefixes
const NATIVE_OPENCODE_PREFIXES = ['opencode-go/'];

function isNativeOpenCodePrefix(modelName: string): boolean {
    return NATIVE_OPENCODE_PREFIXES.some(prefix => modelName.startsWith(prefix));
}

// Adds ProPR's `opencode-` routing prefix. Called when storing models in agent config.
export function toProprOpenCodeExternalModelId(modelName: string): string {
    if (isNativeOpenCodePrefix(modelName)) return modelName;
    if (modelName.startsWith('opencode-')) return modelName;
    if (modelName.startsWith('opencode/')) return `opencode-${modelName.slice('opencode/'.length)}`;
    return `opencode-${modelName}`;
}

// Strips the `opencode:` route prefix (if present) then applies ProPR's external prefix.
export function toProprOpenCodeModelId(modelName: string): string {
    const withoutRoutePrefix = modelName.startsWith('opencode:') ? modelName.slice('opencode:'.length) : modelName;
    return toProprOpenCodeExternalModelId(withoutRoutePrefix);
}

// Converts ProPR's `opencode-provider/model` back to OpenCode's native `provider/model` format.
export function toOpenCodeExternalModelId(modelName: string): string {
    const withoutRoutePrefix = modelName.startsWith('opencode:') ? modelName.slice('opencode:'.length) : modelName;
    if (isNativeOpenCodePrefix(withoutRoutePrefix)) return withoutRoutePrefix;
    if (withoutRoutePrefix.startsWith('opencode-')) {
        const unprefixed = withoutRoutePrefix.slice('opencode-'.length);
        return unprefixed.includes('/') ? unprefixed : `opencode/${unprefixed}`;
    }
    return withoutRoutePrefix;
}

export function normalizeOpenCodeCliModelName(modelName: string): string {
    return toOpenCodeExternalModelId(modelName);
}

// `opencode-go/*` are OpenCode's native (paid) models. They are NOT in ProPR's
// curated model catalog, so they have no configured openRouterId and pricing
// lookups miss. Their OpenRouter slug is `<provider>/<name>`, where the provider
// is inferred from the model-name prefix. Verified against the OpenRouter catalog
// for the current opencode-go set (deepseek, mimo→xiaomi, minimax, glm→z-ai,
// kimi→moonshotai, qwen). Add a prefix here when OpenCode introduces a new family.
const OPENCODE_GO_PROVIDER_BY_PREFIX: ReadonlyArray<readonly [string, string]> = [
    ['deepseek-', 'deepseek'],
    ['mimo-', 'xiaomi'],
    ['minimax-', 'minimax'],
    ['glm-', 'z-ai'],
    ['kimi-', 'moonshotai'],
    ['qwen', 'qwen'],
];

/**
 * Maps a native `opencode-go/<name>` model id to its OpenRouter slug
 * (`<provider>/<name>`) for pricing lookups. Returns null for non-opencode-go
 * ids or unknown providers (caller should fall back to the raw id).
 *   'opencode-go/deepseek-v4-pro'          -> 'deepseek/deepseek-v4-pro'
 *   'opencode:opencode-go/minimax-m3'      -> 'minimax/minimax-m3'
 */
export function toOpenCodeGoOpenRouterId(modelName: string): string | null {
    const withoutRoutePrefix = modelName.startsWith('opencode:')
        ? modelName.slice('opencode:'.length)
        : modelName;
    if (!withoutRoutePrefix.startsWith('opencode-go/')) return null;
    const name = withoutRoutePrefix.slice('opencode-go/'.length);
    for (const [prefix, provider] of OPENCODE_GO_PROVIDER_BY_PREFIX) {
        if (name.startsWith(prefix)) return `${provider}/${name}`;
    }
    return null;
}

