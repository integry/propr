/**
 * The review digest: a run's changed files ranked by risk, the structured
 * validation evidence and the diff size, so a reviewer knows where to look.
 * Pure: callers collect the changes and validation result.
 */
import {
    isDependencyLockfile, isDependencyManifest, isDocumentationFile, isTestFile,
} from '@propr/shared';
import { ALWAYS_PROTECTED_PATHS, compileProtectedPathGlob, type ProtectedPathMatcher } from './autoMergePolicy.js';
import { findAddedDependencies } from './reviewDependencies.js';
import type { RepositoryValidationResult } from './repositoryValidationResult.js';
import { redactSecrets } from '../utils/secretRedaction.js';

export type ReviewRiskTier = 'high' | 'normal' | 'low';
export const REVIEW_RISK_TIERS: readonly ReviewRiskTier[] = ['high', 'normal', 'low'];

/** Why a file landed in its tier; absent for normal-risk files. */
export type ReviewRiskReason =
    | 'review_risk_paths' | 'ci_workflow' | 'propr_configuration' | 'agent_configuration' | 'lockfile'
    | 'dependency_manifest' | 'database_migration' | 'auth_path' | 'payment_path' | 'documentation' | 'test';

/** `review` in `.propr/workflow.yml`. */
export interface ReviewConfig {
    /** Repository-root-anchored globs, matched like `auto_merge.protected_paths`, that mark more paths high risk. */
    risk_paths?: string[];
}

/** One changed file; `FileChange` from the worktree monitor satisfies it. */
export interface ReviewDigestChange {
    path: string;
    linesAdded: number;
    linesRemoved: number;
    status?: 'modified' | 'added' | 'deleted' | 'renamed';
    /** Unified diff of the file; read only to find new dependencies and never copied into the digest. */
    diff?: string;
}

export interface ReviewDigestFile {
    path: string;
    status: NonNullable<ReviewDigestChange['status']>;
    linesAdded: number;
    linesRemoved: number;
    reason?: ReviewRiskReason;
}

export interface ReviewDigestTier {
    /** Every changed file in the tier. */
    count: number;
    /** The first REVIEW_DIGEST_MAX_RECORDED_FILES of them, in path order. */
    files: ReviewDigestFile[];
}

export interface ReviewDigestDependency {
    name: string;
    manifest: string;
}

/** Serialisable digest; recorded on the task timeline as written. */
export interface ReviewDigest {
    tiers: Record<ReviewRiskTier, ReviewDigestTier>;
    newDependencies: { count: number; entries: ReviewDigestDependency[] };
    /** The run's structured validation result; null when no validation commands ran. */
    validation: RepositoryValidationResult | null;
    size: { files: number; linesAdded: number; linesRemoved: number };
}

/** Bounds what the timeline event keeps; the markdown lists fewer. */
export const REVIEW_DIGEST_MAX_RECORDED_FILES = 200;
export const REVIEW_DIGEST_MAX_RECORDED_DEPENDENCIES = 100;
const MAX_PATH_LENGTH = 300;
const MAX_DEPENDENCY_NAME_LENGTH = 120;

/** Built-in high-risk globs, matched with the `protected_paths` matcher. */
const BUILT_IN_HIGH_RISK_GLOBS: ReadonlyArray<[Exclude<ReviewRiskReason, 'review_risk_paths'>, readonly string[]]> = [
    ['propr_configuration', ALWAYS_PROTECTED_PATHS],
    ['ci_workflow', [
        '.github/workflows', '.github/actions', '**/action.yml', '**/action.yaml', '.github/dependabot.yml', '.gitlab-ci.yml', '.gitlab/ci',
        '.circleci', '.buildkite', '**/Jenkinsfile', '**/Jenkinsfile.*', 'azure-pipelines.yml', 'azure-pipelines.yaml', '.azure-pipelines',
        '.travis.yml', 'bitbucket-pipelines.yml', '.drone.yml', '.woodpecker', '.woodpecker.yml', 'cloudbuild.yaml', 'cloudbuild.yml',
        'renovate.json', '.github/renovate.json', '.pre-commit-config.yaml', '.husky',
    ]],
    ['agent_configuration', [
        '**/CLAUDE.md', '**/CLAUDE.local.md', '**/AGENTS.md', '**/AGENT.md', '**/GEMINI.md', '.claude', '.codex', '.gemini', '.cursor',
        '.cursorrules', '.windsurfrules', '.clinerules', '.github/copilot-instructions.md', '.github/instructions', '.github/prompts',
        '.github/chatmodes', '.vibe', '.opencode', 'opencode.json', 'opencode.jsonc', '.mcp.json', '.aider.conf.yml',
    ]],
    ['database_migration', ['**/migrations', '**/migration', '**/db/migrate', '**/alembic/versions', '**/flyway', '**/liquibase', '**/*.migration.*']],
];

const AUTH_WORDS = new Set([
    'auth', 'authn', 'authz', 'oauth', 'oauth2', 'login', 'logout', 'signin', 'signup', 'password', 'passwords', 'passwd', 'credential',
    'credentials', 'jwt', 'saml', 'oidc', 'sso', 'permission', 'permissions', 'rbac', 'acl', 'mfa', 'totp', '2fa', 'passkey',
    'passkeys', 'webauthn', 'csrf',
]);
const PAYMENT_WORDS = new Set([
    'payment', 'payments', 'billing', 'checkout', 'invoice', 'invoices', 'stripe', 'paypal', 'braintree', 'refund', 'refunds',
    'payout', 'payouts',
]);

/** Words of a path: segments split at punctuation and camelCase boundaries. */
function pathWords(path: string): string[] {
    return path.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function sensitivePathReason(path: string): ReviewRiskReason | undefined {
    const words = pathWords(path);
    // `authentication`, `authorize`, `authService` are auth; `author` is not.
    if (words.some(word => AUTH_WORDS.has(word) || (word.startsWith('auth') && !word.startsWith('author')) || word.startsWith('authori'))) return 'auth_path';
    if (words.some(word => PAYMENT_WORDS.has(word))) return 'payment_path';
    return undefined;
}

export interface ReviewRiskClassifier {
    classify(path: string): { tier: ReviewRiskTier; reason?: ReviewRiskReason };
}

/**
 * Tiers, first match wins: `review.risk_paths`, then CI and workflow files,
 * `.propr/`, agent configuration, lockfiles, dependency manifests and
 * migrations are high; then docs and tests are low; then auth- and
 * payment-looking paths are high; everything else is normal.
 */
export function createReviewRiskClassifier(config: ReviewConfig = {}): ReviewRiskClassifier {
    const configured = (config.risk_paths ?? []).map(compileProtectedPathGlob);
    const builtIn: Array<[ReviewRiskReason, ProtectedPathMatcher[]]> = BUILT_IN_HIGH_RISK_GLOBS.map(([reason, globs]) => [reason, globs.map(compileProtectedPathGlob)]);
    return {
        classify(path) {
            if (configured.some(matcher => matcher.test(path))) return { tier: 'high', reason: 'review_risk_paths' };
            for (const [reason, matchers] of builtIn) if (matchers.some(matcher => matcher.test(path))) return { tier: 'high', reason };
            if (isDependencyLockfile(path)) return { tier: 'high', reason: 'lockfile' };
            if (isDependencyManifest(path)) return { tier: 'high', reason: 'dependency_manifest' };
            if (isTestFile(path)) return { tier: 'low', reason: 'test' };
            if (isDocumentationFile(path)) return { tier: 'low', reason: 'documentation' };
            const sensitive = sensitivePathReason(path);
            return sensitive ? { tier: 'high', reason: sensitive } : { tier: 'normal' };
        },
    };
}

function bounded(text: string, max: number): string {
    const clean = redactSecrets(text);
    return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function count(value: number): number {
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/**
 * Build the digest. Returns null when there is no diff, so callers omit the
 * section entirely. Paths and dependency names are redacted and bounded; no
 * diff content is kept.
 */
export function buildReviewDigest(
    changes: readonly ReviewDigestChange[] | null | undefined,
    validationResult: RepositoryValidationResult | null | undefined,
    riskConfig: ReviewConfig = {},
): ReviewDigest | null {
    const unique = new Map<string, ReviewDigestChange>();
    for (const change of changes ?? []) if (change?.path) unique.set(change.path, change);
    if (!unique.size) return null;
    const classifier = createReviewRiskClassifier(riskConfig);
    const tiers: Record<ReviewRiskTier, ReviewDigestTier> = { high: { count: 0, files: [] }, normal: { count: 0, files: [] }, low: { count: 0, files: [] } };
    const dependencies: ReviewDigestDependency[] = [];
    let linesAdded = 0;
    let linesRemoved = 0;
    for (const change of [...unique.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
        const { tier, reason } = classifier.classify(change.path);
        const file: ReviewDigestFile = {
            path: bounded(change.path, MAX_PATH_LENGTH), status: change.status ?? 'modified',
            linesAdded: count(change.linesAdded), linesRemoved: count(change.linesRemoved), ...(reason && { reason }),
        };
        linesAdded += file.linesAdded;
        linesRemoved += file.linesRemoved;
        tiers[tier].count++;
        if (tiers[tier].files.length < REVIEW_DIGEST_MAX_RECORDED_FILES) tiers[tier].files.push(file);
        for (const name of findAddedDependencies(change)) dependencies.push({ name: bounded(name, MAX_DEPENDENCY_NAME_LENGTH), manifest: file.path });
    }
    return {
        tiers,
        newDependencies: { count: dependencies.length, entries: dependencies.slice(0, REVIEW_DIGEST_MAX_RECORDED_DEPENDENCIES) },
        validation: validationResult?.commands.length ? validationResult : null,
        size: { files: unique.size, linesAdded, linesRemoved },
    };
}
