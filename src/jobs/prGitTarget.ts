export interface PullRequestHeadRepository {
    name?: string | null;
    full_name?: string | null;
    owner?: { login?: string | null } | null;
}

export interface PullRequestHead {
    ref: string;
    sha?: string;
    repo?: PullRequestHeadRepository | null;
}

export interface PullRequestGitTarget {
    branchName: string;
    repoOwner: string;
    repoName: string;
    isFork: boolean;
}

/**
 * Resolve the repository that actually owns a pull request's head branch.
 *
 * GitHub reports fork PRs through the base repository API, but the mutable
 * branch still lives in the contributor's fork. Git operations therefore must
 * use head.repo rather than the base repository that owns the PR conversation.
 */
export function resolvePullRequestGitTarget(
    head: PullRequestHead,
    baseRepository: { repoOwner: string; repoName: string },
): PullRequestGitTarget {
    const branchName = head.ref?.trim();
    if (!branchName) {
        throw new Error('Cannot process pull request: the head branch is unavailable');
    }

    if (!head.repo) {
        throw new Error('Cannot process pull request: the head repository is unavailable or has been deleted');
    }

    const [fullNameOwner, fullNameRepo] = head.repo.full_name?.split('/', 2) ?? [];
    const repoOwner = head.repo.owner?.login?.trim() || fullNameOwner?.trim();
    const repoName = head.repo.name?.trim() || fullNameRepo?.trim();
    if (!repoOwner || !repoName) {
        throw new Error('Cannot process pull request: GitHub did not return a complete head repository identity');
    }

    return {
        branchName,
        repoOwner,
        repoName,
        isFork: repoOwner.toLowerCase() !== baseRepository.repoOwner.toLowerCase()
            || repoName.toLowerCase() !== baseRepository.repoName.toLowerCase(),
    };
}
