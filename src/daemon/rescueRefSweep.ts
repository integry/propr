import {
    createGitRescueRefPruneDependencies, getAuthenticatedOctokit, getRepos, getRepoUrl, getRescueRetentionDays,
    handleError, logger, pruneRescueBundles, pruneRescueRefs,
} from '@propr/core';

type SweepOctokit = Pick<Awaited<ReturnType<typeof getAuthenticatedOctokit>>, 'auth'>;

export interface RescueSweepResult {
    refsDeleted: number;
    bundlesDeleted: number;
}

/**
 * Deletes push-salvage rescue refs (`refs/propr/rescue/*`, aged by the creation time in
 * their name) and rescue bundles older than
 * PUSH_RESCUE_RETENTION_DAYS (default 14). A retention of 0 disables the sweep.
 */
export async function sweepPushRescues(options: {
    repositories?: readonly string[];
    octokit?: SweepOctokit;
    olderThanDays?: number;
} = {}): Promise<RescueSweepResult> {
    const olderThanDays = options.olderThanDays ?? getRescueRetentionDays();
    const result: RescueSweepResult = { refsDeleted: 0, bundlesDeleted: 0 };
    if (olderThanDays <= 0) return result;

    try {
        result.bundlesDeleted = (await pruneRescueBundles({ olderThanDays })).deleted.length;
    } catch (error) {
        handleError(error, 'Failed to prune push rescue bundles');
    }

    const repositories = options.repositories ?? getRepos();
    if (repositories.length === 0) return result;
    try {
        const octokit = options.octokit ?? await getAuthenticatedOctokit();
        const { token } = await octokit.auth({ type: 'installation' }) as { token: string };
        for (const repository of repositories) {
            const [owner, repo] = repository.split('/');
            if (!owner || !repo) continue;
            try {
                const deps = createGitRescueRefPruneDependencies({
                    repoUrl: getRepoUrl({ repoOwner: owner, repoName: repo }),
                    token,
                });
                const pruned = await pruneRescueRefs(deps, { olderThanDays, repository });
                result.refsDeleted += pruned.deleted.length;
            } catch (error) {
                logger.warn({ repository, error: (error as Error).message }, 'Failed to sweep push rescue refs');
            }
        }
    } catch (error) {
        logger.warn({ error: (error as Error).message }, 'Skipped push rescue ref sweep: GitHub authentication unavailable');
    }

    if (result.refsDeleted || result.bundlesDeleted) {
        logger.info({ ...result, olderThanDays }, 'Swept expired push rescue refs and bundles');
    }
    return result;
}
