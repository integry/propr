import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHooklessGit, getRepoUrl } from '@propr/core';
import type { PullRequestGitTarget } from './prGitTarget.js';

/** Only an explicit authorization denial permits adopting a contribution. */
export function isPublicationPermissionDenied(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    if (/rate limit|abuse detection|secondary rate|non-fast-forward|fetch first|GH013|GH006/i.test(message)) return false;
    return /write access to repository not granted|permission to .+ denied to |resource not accessible by integration|you are not allowed to push code to this project|not authorized to push|permission denied.*refs\/heads/i.test(message);
}

function authenticatedUrl(target: PullRequestGitTarget, token: string): string {
    return getRepoUrl(target).replace('https://', `https://x-access-token:${token}@`);
}

function sanitizedError(error: unknown, token: string): Error {
    return new Error((error instanceof Error ? error.message : String(error))
        .replaceAll(token, '[REDACTED]')
        .replace(/https:\/\/[^\s@]+@/g, 'https://[REDACTED]@'));
}

/** Uses the very same installation/relay token and HTTPS transport as worker publication.
 * A dry run checks receive-pack authorization without modifying the contributor's ref.
 * Server-side rules can still reject the real update, so publication checks again.
 */
export async function checkPullRequestHeadWritable(worktreePath: string, target: PullRequestGitTarget, token: string, head = 'HEAD'): Promise<void> {
    try {
        await createHooklessGit(worktreePath).raw([
            'push', '--dry-run', '--porcelain',
            authenticatedUrl(target, token), `${head}:refs/heads/${target.branchName}`,
        ]);
    } catch (error) {
        throw sanitizedError(error, token);
    }
}

/** Publish the current HEAD, including already-produced implementation commits.
 * Never checkout the destination branch: it may already exist in another worktree.
 * Merge concurrent continuation work to preserve all original commit identities.
 */
export async function pushContinuationHead(worktreePath: string, target: PullRequestGitTarget, token: string) {
    const git = createHooklessGit(worktreePath);
    const url = authenticatedUrl(target, token);
    const push = () => git.raw(['push', url, `HEAD:refs/heads/${target.branchName}`]);
    try {
        try {
            await push();
        } catch (error) {
            if (!/non-fast-forward|fetch first|remote contains work that you do not/i.test((error as Error).message)) throw error;
            await git.raw(['fetch', url, `refs/heads/${target.branchName}`]);
            try {
                await git.raw(['merge', '--no-edit', 'FETCH_HEAD']);
            } catch (mergeError) {
                await git.raw(['merge', '--abort']).catch(() => undefined);
                throw mergeError;
            }
            await push();
        }
        return { rebased: false, commitHash: (await git.revparse(['HEAD'])).trim() };
    } catch (error) {
        throw sanitizedError(error, token);
    }
}

/** Only commits the destination lacks are stored in the database: those beyond the
 * captured contribution and beyond any continuation history that is already published.
 * Every excluded commit must exist in the recovering worktree, which fetches only the
 * destination branch: the captured SHA is reachable through the PR ref or the
 * continuation branch, and a published tip stays on that branch. A base-branch tip
 * has no such guarantee, so an agent-side base merge is bundled once and then excluded
 * by the next follow-up's published tip.
 */
export async function createPublicationBundle(worktreePath: string, sourceSha: string, publishedTips: readonly string[] = []): Promise<string | null> {
    const git = createHooklessGit(worktreePath);
    const exclusions = [...new Set([sourceSha, ...publishedTips])].map(sha => `^${sha}`);
    if (Number((await git.raw(['rev-list', '--count', 'HEAD', ...exclusions])).trim()) === 0) return null;
    const directory = await mkdtemp(path.join(tmpdir(), 'propr-publication-'));
    const bundlePath = path.join(directory, 'publication.bundle');
    try {
        await git.raw(['bundle', 'create', bundlePath, 'HEAD', ...exclusions]);
        return (await readFile(bundlePath)).toString('base64');
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

export async function restorePublicationBundle(worktreePath: string, bundle: string): Promise<void> {
    const directory = await mkdtemp(path.join(tmpdir(), 'propr-publication-'));
    const bundlePath = path.join(directory, 'publication.bundle');
    const git = createHooklessGit(worktreePath);
    try {
        await writeFile(bundlePath, Buffer.from(bundle, 'base64'));
        await git.raw(['fetch', bundlePath, 'HEAD']);
        try {
            await git.raw(['merge', '--no-edit', 'FETCH_HEAD']);
        } catch (error) {
            await git.raw(['merge', '--abort']).catch(() => undefined);
            throw error;
        }
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}
