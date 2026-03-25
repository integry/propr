/**
 * Git Corruption Detection
 *
 * Pure function to detect git repository corruption errors based on error messages.
 * This module identifies 11 corruption patterns that indicate a git repository
 * needs to be re-cloned or repaired.
 *
 * Based on bug fixes: 7143b852, c4f0dfd3, 149ba58f, bb44e30f and others
 * related to git corruption handling.
 */

/**
 * Patterns that indicate git repository corruption.
 * Each pattern is a case-insensitive regex that matches common git corruption error messages.
 */
export const GIT_CORRUPTION_PATTERNS: RegExp[] = [
    // Index/pack file corruption
    /invalid index-pack output/i,

    // Repository structure corruption
    /not a git repository/i,
    /fatal: bad object/i,

    // Missing objects (blob, tree, commit)
    /missing blob/i,
    /missing tree/i,
    /missing commit/i,
    /missing object/i,

    // General corruption indicators
    /corrupted/i,
    /broken link/i,

    // SHA1/hash corruption
    /invalid sha1/i,

    // Loose object corruption
    /loose object.*corrupt/i,

    // Pack file issues
    /pack.*corrupt/i,
    /bad pack header/i,

    // Object database corruption
    /object file.*empty/i,
    /unable to read sha1 file/i,

    // Reference corruption
    /refs\/.*does not point to a valid object/i,
    /bad ref for/i,

    // Index corruption
    /index file corrupt/i,
    /index file smaller than expected/i,

    // Worktree corruption
    /worktree.*not valid/i,
    /gitdir file does not exist/i,
];

/**
 * Checks if an error message indicates git repository corruption.
 *
 * This is a pure function that performs regex matching against known
 * git corruption error patterns. It does not modify any state.
 *
 * @param error - The error to check. Can be an Error object, a string, null, or undefined.
 * @returns true if the error message matches any corruption pattern, false otherwise.
 *
 * @example
 * ```typescript
 * // Returns true for corruption errors
 * isGitCorruptionError(new Error('fatal: bad object HEAD'));
 * isGitCorruptionError('not a git repository');
 * isGitCorruptionError({ message: 'corrupted loose object' });
 *
 * // Returns false for normal git errors
 * isGitCorruptionError(new Error('merge conflict in file.txt'));
 * isGitCorruptionError('Your branch is ahead of origin/main');
 *
 * // Handles null/undefined safely
 * isGitCorruptionError(null); // false
 * isGitCorruptionError(undefined); // false
 * ```
 */
export function isGitCorruptionError(error: unknown): boolean {
    // Extract error message from various input types
    let errorMessage: string | undefined;

    if (error === null || error === undefined) {
        return false;
    }

    if (typeof error === 'string') {
        errorMessage = error;
    } else if (error instanceof Error) {
        errorMessage = error.message;
    } else if (typeof error === 'object' && 'message' in error) {
        errorMessage = String((error as { message: unknown }).message);
    }

    if (!errorMessage || typeof errorMessage !== 'string') {
        return false;
    }

    // Check against all corruption patterns
    return GIT_CORRUPTION_PATTERNS.some(pattern => pattern.test(errorMessage));
}

/**
 * Gets all corruption patterns as strings for logging/debugging purposes.
 *
 * @returns Array of pattern strings
 */
export function getCorruptionPatternStrings(): string[] {
    return GIT_CORRUPTION_PATTERNS.map(pattern => pattern.source);
}
