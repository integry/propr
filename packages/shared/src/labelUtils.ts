// GitHub's hard limit on label name length
export const MAX_GITHUB_LABEL_LENGTH = 50;
const MAX_LABEL_HASH_INPUT_LENGTH = 4096;

// 32-bit FNV-1a hash, base36-encoded. Used for routing — not cryptographic.
export function shortHash(value: string): string {
    const boundedValue = value.slice(0, MAX_LABEL_HASH_INPUT_LENGTH);
    if (boundedValue.length !== value.length) {
        throw new RangeError(`Label hash input exceeds ${MAX_LABEL_HASH_INPUT_LENGTH} characters`);
    }
    let hash = 2166136261;
    for (let index = 0; index < boundedValue.length; index++) {
        hash ^= boundedValue.charCodeAt(index);
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

/**
 * Builds the long GitHub label for a model as exposed by a configured agent.
 * Static catalog labels retain their short model suffix while replacing the
 * built-in agent type with the configured alias. Dynamic labels are rebuilt so
 * their length and hash account for the alias as well.
 */
export function buildAgentModelLlmLabel(
    agentType: string,
    agentAlias: string,
    model: { id: string; githubLabel: string }
): string {
    const effectiveAlias = agentAlias || agentType;
    const dynamicPrefix = `llm-${agentType}~`;
    if (model.githubLabel.startsWith(dynamicPrefix)) {
        return buildDynamicLlmLabel(effectiveAlias, model.id);
    }

    const staticPrefix = `llm-${agentType}-`;
    if (model.githubLabel.startsWith(staticPrefix)) {
        const staticLabel = `llm-${effectiveAlias}-${model.githubLabel.slice(staticPrefix.length)}`;
        return staticLabel.length <= MAX_GITHUB_LABEL_LENGTH
            ? staticLabel
            : buildDynamicLlmLabel(effectiveAlias, model.id);
    }

    return model.githubLabel;
}
