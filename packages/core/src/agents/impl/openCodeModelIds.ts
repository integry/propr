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

