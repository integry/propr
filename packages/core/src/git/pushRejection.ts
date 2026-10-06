import { redactAuthenticatedGitUrl } from './redactGitUrl.js';

/** Why a remote refused a push, coarse enough for a reviewer to act on without logs. */
export type PushRejectionClass =
    | 'push_protection'
    | 'ruleset_or_branch_protection'
    | 'non_fast_forward'
    | 'auth'
    | 'network'
    | 'unknown';

export interface PushRejectionDiagnosis {
    classification: PushRejectionClass;
    /** One sentence describing the rejection and what unblocks it. */
    summary: string;
    /** GitHub secret scanning bypass links, verbatim from the remote output. */
    unblockUrls: string[];
    /** Redacted remote output, capped so it fits failure summaries and comments. */
    excerpt: string;
}

const EXCERPT_LIMIT = 1500;

const PUSH_PROTECTION = /GITHUB PUSH PROTECTION|Push cannot contain secrets|GH009: Secrets detected|secret-scanning\/unblock-secret/i;
const RULESET_OR_BRANCH_PROTECTION = /GH013|GH006|Repository rule violations|Protected branch update failed|protected branch hook declined|Cannot update this protected ref|Changes must be made through a pull request|push declined due to repository rule violations|required status checks? .*expected|Cannot force-push to this branch/i;
const NON_FAST_FORWARD = /\(non-fast-forward\)|\(fetch first\)|non-fast-forward|tip of your current branch is behind|remote contains work that you do not|\(stale info\)/i;
const AUTH = /Authentication failed|Invalid username or (?:password|token)|could not read (?:Username|Password)|returned error: 40[13]\b|HTTP 40[13]\b|\b40[13] (?:Unauthorized|Forbidden)\b|Bad credentials|HTTP Basic: Access denied|Permission to \S+ denied to|write access to repository not granted|Resource not accessible by integration|token (?:has )?expired|refusing to allow .* to create or update workflow/i;
const NETWORK = /network error|timed out|Connection reset|Connection refused|Connection timed out|Operation timed out|Could not resolve host|Failed to connect to|unable to access .*: (?:Recv|Send) failure|RPC failed|unexpected disconnect|early EOF|remote end hung up unexpectedly|gnutls_handshake|SSL_ERROR|TLS connection|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|returned error: 50[0234]\b|HTTP 50[0234]\b/i;
// URLs are found per token rather than with one unanchored pattern over the whole
// output, which backtracks polynomially on long runs of 'http://' (CodeQL js/polynomial-redos).
const URL_DELIMITERS = /[\s'"<>)]+/;
const URL_SCHEME = /https?:\/\//i;
const UNBLOCK_PATH = '/secret-scanning/unblock-secret/';
const TRAILING_PUNCTUATION = '.,;:';

const SUMMARIES: Record<PushRejectionClass, string> = {
    push_protection: 'GitHub secret scanning push protection blocked the push because the commits contain a detected secret. Remove the secret from the commits, or allow it through the unblock URL, then push again.',
    ruleset_or_branch_protection: 'A repository ruleset or branch protection rule rejected the push. Review the rule violations in the remote output, or push the commits to a different branch.',
    non_fast_forward: 'The remote branch moved while the task ran (non-fast-forward). Fetch the branch, integrate the new commits, and push again.',
    auth: 'The remote rejected the credentials (401/403 or an expired installation token), or the GitHub App lacks write permission for this ref.',
    network: 'The push failed because of a network or transport error before GitHub accepted it.',
    unknown: 'The push failed for a reason ProPR could not classify. See the remote output below.',
};

function errorText(error: unknown): string {
    if (typeof error === 'string') return error;
    if (error instanceof Error) {
        const parts = [error.message];
        // simple-git exposes the remote output separately on some failures.
        const { stdout, stderr } = error as Error & { stdout?: unknown; stderr?: unknown };
        if (typeof stderr === 'string' && !error.message.includes(stderr)) parts.push(stderr);
        if (typeof stdout === 'string' && stdout && !error.message.includes(stdout)) parts.push(stdout);
        return parts.join('\n');
    }
    return String(error ?? '');
}

export function classifyPushRejectionText(output: string): PushRejectionClass {
    if (PUSH_PROTECTION.test(output)) return 'push_protection';
    if (RULESET_OR_BRANCH_PROTECTION.test(output)) return 'ruleset_or_branch_protection';
    if (NON_FAST_FORWARD.test(output)) return 'non_fast_forward';
    if (AUTH.test(output)) return 'auth';
    if (NETWORK.test(output)) return 'network';
    return 'unknown';
}

export function extractUnblockUrls(output: string): string[] {
    const urls: string[] = [];
    for (const token of output.split(URL_DELIMITERS)) {
        const start = token.search(URL_SCHEME);
        if (start === -1) continue;
        const candidate = token.slice(start);
        const schemeLength = candidate.indexOf('//') + 2;
        const pathIndex = candidate.toLowerCase().indexOf(UNBLOCK_PATH, schemeLength + 1);
        if (pathIndex === -1 || pathIndex + UNBLOCK_PATH.length >= candidate.length) continue;
        let end = candidate.length;
        while (end > 0 && TRAILING_PUNCTUATION.includes(candidate[end - 1])) end--;
        urls.push(candidate.slice(0, end));
    }
    return [...new Set(urls)];
}

/** Parses git's push error output. Accepts an Error, simple-git error or raw text. */
export function classifyPushError(error: unknown): PushRejectionDiagnosis {
    const output = redactAuthenticatedGitUrl(errorText(error));
    const classification = classifyPushRejectionText(output);
    const excerpt = output.length > EXCERPT_LIMIT ? `${output.slice(0, EXCERPT_LIMIT)}… [truncated]` : output;
    return {
        classification,
        summary: SUMMARIES[classification],
        unblockUrls: classification === 'push_protection' ? extractUnblockUrls(output) : [],
        excerpt: excerpt.trim(),
    };
}

const LABELS: Record<PushRejectionClass, string> = {
    push_protection: 'Secret scanning push protection',
    ruleset_or_branch_protection: 'Ruleset or branch protection',
    non_fast_forward: 'Non-fast-forward',
    auth: 'Authentication / permission',
    network: 'Network error',
    unknown: 'Unknown',
};

export function formatPushRejectionClass(classification: PushRejectionClass): string {
    return LABELS[classification] ?? classification;
}
