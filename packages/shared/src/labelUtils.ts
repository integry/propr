// GitHub's hard limit on label name length
export const MAX_GITHUB_LABEL_LENGTH = 50;

// 32-bit FNV-1a hash, base36-encoded. Used for routing — not cryptographic.
export function shortHash(value: string): string {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index++) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}

// `~` separator is an intentional public contract — these labels are persisted on GitHub and resolved later
export function buildDynamicLlmLabel(agentKey: string, modelId: string): string {
    const canonicalLabel = `llm-${agentKey}~${modelId}`;
    if (canonicalLabel.length <= MAX_GITHUB_LABEL_LENGTH) return canonicalLabel;

    const hash = shortHash(modelId);
    const maxAliasLength = Math.max(1, MAX_GITHUB_LABEL_LENGTH - `llm-~-x-${hash}`.length);
    const sanitizedAlias = agentKey
        .replace(/[^a-zA-Z0-9_.-]/g, '-')
        .slice(0, maxAliasLength)
        .replace(/[^a-zA-Z0-9]+$/, '');
    const labelAlias = sanitizedAlias || 'agent'.slice(0, maxAliasLength);
    const prefixBudget = MAX_GITHUB_LABEL_LENGTH - `llm-${labelAlias}~-${hash}`.length;
    const fallbackPrefix = 'model'.slice(0, Math.max(1, prefixBudget));
    const modelPrefix = modelId
        .replace(/[^a-zA-Z0-9_.-]/g, '-')
        .slice(0, Math.max(1, prefixBudget))
        .replace(/[^a-zA-Z0-9]+$/, '');
    return `llm-${labelAlias}~${modelPrefix || fallbackPrefix}-${hash}`;
}
