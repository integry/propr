export function buildAntigravityContainerName(
    alias: string,
    taskType: string,
    shortTaskId: string,
    modelName?: string,
): string {
    const suffix = `-${shortTaskId}`;
    const rawPrefix = modelName
        ? `${alias}-${taskType}-${modelName}`
        : `${alias}-${taskType}`;
    const maxPrefixLength = Math.max(1, 120 - suffix.length);
    const sanitizedPrefix = rawPrefix
        .replace(/[^a-zA-Z0-9_.-]/g, '-')
        .replace(/^[^a-zA-Z0-9]+/, '')
        .slice(0, maxPrefixLength)
        .replace(/[^a-zA-Z0-9]+$/, '');
    return `${sanitizedPrefix || 'antigravity'}${suffix}`.slice(0, 128);
}
