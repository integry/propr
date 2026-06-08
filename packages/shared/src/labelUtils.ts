export const MAX_GITHUB_LABEL_LENGTH = 50;

export function shortHash(value: string): string {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index++) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}

export function buildDynamicLlmLabel(agentKey: string, modelId: string): string {
    const canonicalLabel = `llm-${agentKey}:${modelId}`;
    if (canonicalLabel.length <= MAX_GITHUB_LABEL_LENGTH) return canonicalLabel;

    const hash = shortHash(modelId);
    const maxAliasLength = Math.max(1, MAX_GITHUB_LABEL_LENGTH - `llm-:-x-${hash}`.length);
    const labelAlias = agentKey
        .replace(/[^a-zA-Z0-9_.-]/g, '-')
        .slice(0, maxAliasLength)
        .replace(/[^a-zA-Z0-9]+$/, '') || 'agent';
    const prefixBudget = MAX_GITHUB_LABEL_LENGTH - `llm-${labelAlias}:-${hash}`.length;
    const modelPrefix = modelId
        .replace(/[^a-zA-Z0-9_.-]/g, '-')
        .slice(0, Math.max(1, prefixBudget))
        .replace(/[^a-zA-Z0-9]+$/, '');
    return `llm-${labelAlias}:${modelPrefix || 'model'}-${hash}`;
}
