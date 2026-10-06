/**
 * Repository auto-merge policy (`auto_merge` in `.propr/workflow.yml`) and the
 * pure, fail-closed decision on whether ProPR may arm GitHub auto-merge.
 */

export type AutoMergePolicyMethod = 'merge' | 'squash' | 'rebase';
export const AUTO_MERGE_METHODS: readonly AutoMergePolicyMethod[] = ['merge', 'squash', 'rebase'];
export const AUTO_MERGE_MAX_PROTECTED_PATHS = 200;
/** Repository policy itself always needs a human, whatever the configuration says. */
export const ALWAYS_PROTECTED_PATHS: readonly string[] = ['.propr/**'];

export interface AutoMergeConfig {
    enabled?: boolean;
    method?: AutoMergePolicyMethod;
    protected_paths?: string[];
}

export type AutoMergeReason =
    | 'armed'
    | 'skipped_protected_path'
    | 'skipped_disabled'
    | 'skipped_empty_diff'
    | 'skipped_policy_invalid'
    | 'skipped_diff_unavailable';

/** Where ProPR would arm auto-merge; recorded with each decision. */
export type AutoMergeOpportunity = 'initial_pr' | 'ultrafix_goal' | 'epic_queue_advance' | 'new_head' | 'check_merge';

/** A policy read from the base branch: absent (`config` undefined), valid, or unusable. */
export type AutoMergePolicyInput =
    | { status: 'valid'; config?: AutoMergeConfig }
    | { status: 'invalid'; error: string };

export interface AutoMergeDecisionContext {
    opportunity: AutoMergeOpportunity;
}

export interface AutoMergeDecision {
    arm: boolean;
    reason: AutoMergeReason;
    opportunity: AutoMergeOpportunity;
    /** Changed paths that matched a protected pattern (only for `skipped_protected_path`). */
    matchedPaths?: string[];
    /** Configured method; undefined means the repository default. Only set when armed. */
    method?: AutoMergePolicyMethod;
    /** Human-readable detail for invalid policy decisions. */
    detail?: string;
}

/** Validate a parsed `auto_merge` block; returns an error message or null. */
export function validateAutoMergeConfig(value: unknown): string | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return 'auto_merge must be a mapping';
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
        if (!['enabled', 'method', 'protected_paths'].includes(key)) return `unknown field auto_merge.${key}`;
    }
    if (record.enabled !== undefined && typeof record.enabled !== 'boolean') return 'auto_merge.enabled must be a boolean';
    if (record.method !== undefined && !AUTO_MERGE_METHODS.includes(record.method as AutoMergePolicyMethod)) {
        return 'auto_merge.method must be one of merge, squash or rebase';
    }
    if (record.protected_paths !== undefined) {
        const paths = record.protected_paths;
        if (!Array.isArray(paths) || paths.length > AUTO_MERGE_MAX_PROTECTED_PATHS) {
            return `auto_merge.protected_paths must be an array of at most ${AUTO_MERGE_MAX_PROTECTED_PATHS} globs`;
        }
        for (const [index, pattern] of paths.entries()) {
            if (typeof pattern !== 'string' || !pattern.trim() || pattern.includes('\0')) {
                return `auto_merge.protected_paths[${index}] must be a nonempty string without NUL bytes`;
            }
            if (normalizePath(pattern).split('/').some(part => part === '..')) {
                return `auto_merge.protected_paths[${index}] must not contain '..' segments`;
            }
            try {
                compileProtectedPathGlob(pattern);
            } catch {
                return `auto_merge.protected_paths[${index}] is not a valid glob`;
            }
        }
    }
    return null;
}

/**
 * Normalize a configured pattern. Only patterns are normalized: changed filenames
 * come from Git, where a backslash or surrounding whitespace is a literal character.
 */
function normalizePath(path: string): string {
    return path.trim().replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/^\/+/, '').replace(/\/{2,}/g, '/');
}

/** Strip trailing slashes with a linear scan (a `/\/+$/` regex backtracks quadratically). */
function trimTrailingSlashes(path: string): string {
    let end = path.length;
    while (end > 0 && path[end - 1] === '/') end--;
    return path.slice(0, end);
}

function escapeRegExp(text: string): string {
    return text.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile a protected-path glob. Patterns are anchored at the repository root:
 * `*` and `?` stay within one path segment, `**` spans any number of segments,
 * and `[...]` is a character class. `*` matches dotfiles. A pattern that matches a
 * directory protects everything below it, so `docs` and `docs/` equal `docs/**`.
 * Matching is case-insensitive so a differently cased path cannot slip through, and
 * wildcards match line terminators, which Git allows in filenames. Throws on a glob
 * that does not compile (such as a reversed `[z-a]` range); validation rejects those.
 */
export function compileProtectedPathGlob(pattern: string): RegExp {
    const glob = trimTrailingSlashes(normalizePath(pattern));
    let source = '';
    for (let index = 0; index < glob.length; index++) {
        const char = glob[index];
        if (char === '*') {
            const doubleStar = glob[index + 1] === '*';
            const atSegmentStart = index === 0 || glob[index - 1] === '/';
            const followedBySlash = glob[index + 2] === '/';
            const wholeSegment = doubleStar && atSegmentStart && (followedBySlash || index + 2 === glob.length);
            // `**/` matches zero or more directories; a trailing `**` matches anything;
            // any other `*` (including `**` inside a segment) stays within one segment.
            source += wholeSegment ? (followedBySlash ? '(?:[^/]*/)*' : '.*') : '[^/]*';
            index += wholeSegment && followedBySlash ? 2 : doubleStar ? 1 : 0;
        } else if (char === '?') {
            source += '[^/]';
        } else if (char === '[') {
            const close = glob.indexOf(']', index + 2);
            if (close === -1) { source += '\\['; continue; }
            let body = glob.slice(index + 1, close);
            const negated = body.startsWith('!') || body.startsWith('^');
            if (negated) body = body.slice(1);
            source += `[${negated ? '^/' : ''}${body.replace(/[\\\]]/g, '\\$&')}]`;
            index = close;
        } else {
            source += escapeRegExp(char);
        }
    }
    // Matching a directory protects its descendants.
    return new RegExp(`^${source}(?:/.*)?$`, 'is');
}

/**
 * Changed paths matched by any protected pattern, including the always-protected ones.
 * Filenames are matched verbatim: rewriting a literal `\\` to `/` would move the
 * file into a different directory and let it slip past segment-scoped wildcards.
 */
export function findProtectedPaths(changedFiles: readonly string[], protectedPaths: readonly string[] = []): string[] {
    const matchers = [...ALWAYS_PROTECTED_PATHS, ...protectedPaths].map(compileProtectedPathGlob);
    const matched = new Set<string>();
    for (const file of changedFiles) {
        if (matchers.some(matcher => matcher.test(file))) matched.add(file);
    }
    return [...matched].sort();
}

/**
 * Decide whether auto-merge may be armed. Every uncertainty fails closed:
 * an unusable policy, an unknown method, a missing or empty diff never arm.
 * `changedFiles` is null when the diff could not be fetched.
 */
export function decideAutoMerge(
    policy: AutoMergePolicyInput,
    changedFiles: readonly string[] | null,
    context: AutoMergeDecisionContext,
): AutoMergeDecision {
    const { opportunity } = context;
    const skip = (reason: Exclude<AutoMergeReason, 'armed'>, extra: Partial<AutoMergeDecision> = {}): AutoMergeDecision =>
        ({ arm: false, reason, opportunity, ...extra });
    if (policy.status !== 'valid') return skip('skipped_policy_invalid', { detail: policy.error });
    const config = policy.config ?? {};
    const invalid = config === null || typeof config !== 'object' ? 'auto_merge must be a mapping' : validateAutoMergeConfig(config);
    if (invalid) return skip('skipped_policy_invalid', { detail: invalid });
    if (config.enabled === false) return skip('skipped_disabled');
    if (!Array.isArray(changedFiles)) return skip('skipped_diff_unavailable');
    const files = changedFiles.filter(file => typeof file === 'string' && file !== '');
    if (files.length === 0) return skip('skipped_empty_diff');
    const matchedPaths = findProtectedPaths(files, config.protected_paths);
    if (matchedPaths.length) return skip('skipped_protected_path', { matchedPaths });
    return { arm: true, reason: 'armed', opportunity, ...(config.method ? { method: config.method } : {}) };
}

const REASON_TEXT: Record<Exclude<AutoMergeReason, 'armed'>, string> = {
    skipped_protected_path: 'the PR changes protected paths',
    skipped_disabled: '`auto_merge.enabled` is false in the base branch `.propr/workflow.yml`',
    skipped_empty_diff: 'the PR diff is empty',
    skipped_policy_invalid: 'the base branch `.propr/workflow.yml` could not be read or is invalid',
    skipped_diff_unavailable: 'the PR diff could not be fetched from GitHub',
};

const MAX_LISTED_PATHS = 5;

/** One-line explanation for a skipped decision, suitable for a PR comment. */
export function describeAutoMergeDecision(decision: AutoMergeDecision): string {
    if (decision.arm) return 'Auto-merge armed.';
    let why = REASON_TEXT[decision.reason as Exclude<AutoMergeReason, 'armed'>] ?? decision.reason;
    if (decision.reason === 'skipped_protected_path' && decision.matchedPaths?.length) {
        const listed = decision.matchedPaths.slice(0, MAX_LISTED_PATHS).map(path => `\`${path.replace(/`/g, '')}\``).join(', ');
        const more = decision.matchedPaths.length > MAX_LISTED_PATHS ? ` and ${decision.matchedPaths.length - MAX_LISTED_PATHS} more` : '';
        why += ` (${listed}${more})`;
    }
    return `⏸️ **Auto-merge not armed** (\`${decision.reason}\`): ${why}. The \`auto-merge\` label stays in place; a maintainer can review and merge or enable auto-merge manually.`;
}
