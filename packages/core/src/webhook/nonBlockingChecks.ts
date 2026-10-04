/**
 * Matching for RepoToMonitor.nonBlockingChecks: a check run name matches a
 * pattern case-insensitively, where `*` stands for any text (including none).
 * Anything else in the pattern is literal.
 */
export function checkNameMatches(name: string, pattern: string): boolean {
    const trimmed = pattern.trim();
    if (!trimmed) return false;
    const expression = trimmed.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    return new RegExp(`^${expression}$`, 'i').test(name.trim());
}

export function isNonBlockingCheck(name: string | null | undefined, patterns: readonly string[]): boolean {
    if (!name || patterns.length === 0) return false;
    return patterns.some(pattern => checkNameMatches(name, pattern));
}
