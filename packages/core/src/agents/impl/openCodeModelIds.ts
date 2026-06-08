export function toProprOpenCodeExternalModelId(modelName: string): string {
    if (modelName.startsWith('opencode-')) return modelName;
    if (modelName.startsWith('opencode/')) return `opencode-${modelName.slice('opencode/'.length)}`;
    return `opencode-${modelName}`;
}

export function toProprOpenCodeModelId(modelName: string): string {
    const withoutRoutePrefix = modelName.startsWith('opencode:') ? modelName.slice('opencode:'.length) : modelName;
    return toProprOpenCodeExternalModelId(withoutRoutePrefix);
}

export function toOpenCodeExternalModelId(modelName: string): string {
    const withoutRoutePrefix = modelName.startsWith('opencode:') ? modelName.slice('opencode:'.length) : modelName;
    // opencode-go/ is a native OpenCode Go model prefix, not a ProPR routing prefix — keep it as-is
    if (withoutRoutePrefix.startsWith('opencode-') && !withoutRoutePrefix.startsWith('opencode-go/')) {
        const unprefixed = withoutRoutePrefix.slice('opencode-'.length);
        return unprefixed.includes('/') ? unprefixed : `opencode/${unprefixed}`;
    }
    return withoutRoutePrefix;
}

export function normalizeOpenCodeCliModelName(modelName: string): string {
    return toOpenCodeExternalModelId(modelName);
}

