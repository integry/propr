import { getAuthenticatedOctokit } from '../auth/githubAuth.js';

/**
 * Evidence about which epic PR carries a merged child: merge timestamps,
 * and merge-commit containment when two merges share a second.
 */

export interface EpicProgressOctokit {
    request: (route: string, parameters: Record<string, unknown>) => Promise<{ data: unknown }>;
    paginate?: (route: string, parameters: Record<string, unknown>) => Promise<unknown[]>;
}

export interface RepositoryContext {
    owner: string;
    repo: string;
}

interface ChildContext extends RepositoryContext {
    /** Null for the aggregate epic PR merge. */
    mergedChildPrNumber: number | null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

/** Thrown when same-second inclusion cannot be settled; the caller retries rather than reporting exclusion. */
export class EpicMergeEvidenceUnresolvedError extends Error {
    constructor(detail: string) {
        super(`Same-second epic merge inclusion could not be resolved: ${detail}`);
        this.name = 'EpicMergeEvidenceUnresolvedError';
    }
}

/** The epic PR's head commit as GitHub preserves it after the merge, before any squash or rebase rewrite. */
export function epicHeadSha(pr: { head?: { sha?: unknown } | null } | null | undefined): string | null {
    return pr && isRecord(pr.head) && typeof pr.head.sha === 'string' && pr.head.sha.length > 0 ? pr.head.sha : null;
}

/**
 * Timestamps have one-second resolution, so a child merged in the same
 * second as an epic cannot be ordered by time. GitHub's compare API settles
 * it against the epic PR's head: that is the epic branch tip that was
 * merged, preserved on the PR after the merge whatever the merge method, so
 * the child's merge commit is its ancestor exactly when the epic included it.
 * The epic's merge commit is unsuitable, as squash and rebase merges rewrite
 * history and would report an included child as excluded. Missing commits or
 * an unknown comparison leave the question unresolved and throw, so the
 * caller keeps its obligation instead of treating the child as excluded.
 */
export async function isMergeContained(
    octokit: EpicProgressOctokit,
    { owner, repo }: RepositoryContext,
    childMergeCommitSha: string | null | undefined,
    epicHeadCommitSha: string | null | undefined,
): Promise<boolean> {
    if (!childMergeCommitSha) throw new EpicMergeEvidenceUnresolvedError('child merge commit unavailable');
    if (!epicHeadCommitSha) throw new EpicMergeEvidenceUnresolvedError('epic head commit unavailable');
    let comparison: unknown;
    try {
        comparison = (await octokit.request('GET /repos/{owner}/{repo}/compare/{basehead}', {
            owner, repo, basehead: `${epicHeadCommitSha}...${childMergeCommitSha}`,
        })).data;
    } catch (error) {
        if ((error as { status?: number }).status === 404) {
            throw new EpicMergeEvidenceUnresolvedError(`commits ${epicHeadCommitSha} or ${childMergeCommitSha} unknown`);
        }
        throw error;
    }
    if (!isRecord(comparison) || typeof comparison.ahead_by !== 'number') throw new EpicMergeEvidenceUnresolvedError('comparison incomplete');
    return comparison.ahead_by === 0;
}

type Octokit = Awaited<ReturnType<typeof getAuthenticatedOctokit>>;

/** Immutable once the child has merged; read once per update and reused. */
export interface ChildMergeEvidence {
    defaultBranch: string;
    childMergedAt: string | null;
    childMergeCommitSha: string | null;
}

export type ChildMergeEvidenceSource = ChildMergeEvidence | (() => Promise<ChildMergeEvidence>);

export async function readChildMergeEvidence(
    octokit: Octokit, { owner, repo }: RepositoryContext, childPrNumber: number,
): Promise<ChildMergeEvidence> {
    const defaultBranch = (await octokit.request('GET /repos/{owner}/{repo}', { owner, repo })).data.default_branch;
    const child = (await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
        owner, repo, pull_number: childPrNumber,
    })).data;
    return { defaultBranch, childMergedAt: child.merged_at, childMergeCommitSha: child.merge_commit_sha ?? null };
}

/** A merged epic can only carry a child that merged before it. */
export async function canCarryChild(
    octokit: Octokit,
    context: ChildContext,
    pr: { state: string; merged_at: string | null; base?: { ref: string }; head?: { sha?: string | null } | null },
    evidence?: ChildMergeEvidenceSource,
): Promise<boolean> {
    if (pr.state === 'open') return true;
    if (!pr.merged_at || context.mergedChildPrNumber === null) return false;
    const { defaultBranch, childMergedAt, childMergeCommitSha } = typeof evidence === 'function' ? await evidence()
        : evidence ?? await readChildMergeEvidence(octokit, context, context.mergedChildPrNumber);
    if (pr.base?.ref !== defaultBranch || !childMergedAt) return false;
    // Missing, invalid, or later timestamps do not establish that the child
    // was included; an equal one needs the epic's pre-merge head to settle it.
    const childTime = Date.parse(childMergedAt);
    const epicTime = Date.parse(pr.merged_at);
    if (childTime < epicTime) return true;
    return childTime === epicTime
        && await isMergeContained(octokit as unknown as EpicProgressOctokit, context, childMergeCommitSha, epicHeadSha(pr));
}

/**
 * The most recently merged epic PR of the branch into the default branch.
 * Used when GitHub refuses a successor because the branch has no commits
 * beyond the default branch: everything on it, including the child, has
 * then already shipped through that epic.
 */
export async function findLatestMergedEpicPRNumber(
    octokit: Octokit, { owner, repo, epicBranch, defaultBranch }: RepositoryContext & { epicBranch: string; defaultBranch: string },
): Promise<number | null> {
    const pulls = await octokit.paginate('GET /repos/{owner}/{repo}/pulls', {
        owner, repo, head: `${owner}:${epicBranch}`, base: defaultBranch, state: 'closed', per_page: 100,
    });
    let latest: { number: number; mergedAt: number } | null = null;
    for (const pr of pulls) {
        const mergedAt = pr.merged_at ? Date.parse(pr.merged_at) : NaN;
        if (Number.isFinite(mergedAt) && (!latest || mergedAt > latest.mergedAt)) latest = { number: pr.number, mergedAt };
    }
    return latest?.number ?? null;
}

/** Prefer an open Epic PR; reuse a merged one only for an included child. */
export async function findEpicPRNumber(
    octokit: Octokit, context: ChildContext & { epicBranch: string },
    evidence?: ChildMergeEvidenceSource,
): Promise<number | null> {
    const { owner, repo, epicBranch } = context;
    const pulls = await octokit.paginate('GET /repos/{owner}/{repo}/pulls', {
        owner, repo,
        head: `${owner}:${epicBranch}`,
        state: 'all',
        per_page: 100,
    });
    const open = pulls.find(pr => pr.state === 'open');
    if (open) return open.number;
    const candidates = pulls.filter(pr => pr.merged_at && Number.isFinite(Date.parse(pr.merged_at)))
        .sort((a, b) => Date.parse(a.merged_at!) - Date.parse(b.merged_at!));
    if (candidates.length === 0 || context.mergedChildPrNumber === null) return null;
    const loaded = typeof evidence === 'function' ? await evidence()
        : evidence ?? await readChildMergeEvidence(octokit, context, context.mergedChildPrNumber);
    for (const pr of candidates) {
        if (await canCarryChild(octokit, context, pr, loaded)) return pr.number;
    }
    return null;
}
