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
    if (withoutRoutePrefix.startsWith('opencode-') && !withoutRoutePrefix.startsWith('opencode-go/')) {
        const unprefixed = withoutRoutePrefix.slice('opencode-'.length);
        return unprefixed.includes('/') ? unprefixed : `opencode/${unprefixed}`;
    }
    return withoutRoutePrefix;
}

export function normalizeOpenCodeCliModelName(modelName: string): string {
    const externalModelId = toOpenCodeExternalModelId(modelName);
    if (externalModelId.startsWith('opencode/')) return externalModelId;
    const slashIndex = externalModelId.indexOf('/');
    return slashIndex > 0 ? externalModelId.slice(slashIndex + 1) : externalModelId;
}

export { shortHash } from '@propr/shared';
