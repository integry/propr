import { cleanupWorktree, createHooklessGit, getAuthenticatedOctokit, logger } from '@propr/core';
import { createPullRequestHeadWorktree, pushPullRequestHeadBranch } from './prGitOperations.js';
import type { PublicationCompletion } from './prCommentPostExecution.js';
import { resolvePullRequestGitTarget } from './prGitTarget.js';
import {
    announceContinuation, continuationStatus, continuationTarget, ensurePRContinuation, findPRContinuation,
    isEmptyPullRequestError, reserveContinuation, savePublicationCheckpoint,
    type ContinuationRecord, type Contribution, type PublishContinuationHead, type PullRequestReference,
} from './prContinuation.js';
import { checkPullRequestHeadWritable, createPublicationBundle, restorePublicationBundle, isPublicationPermissionDenied, pushContinuationHead } from './prPublicationGit.js';

/** One publication session spans preflight, agent execution and the final push.
 * Discussion/comment identity stays with the request; only the mutable Git target changes.
 */
export class PullRequestPublication {
    continuation?: ContinuationRecord;
    /** Continuation commit the worktree started from or last published. Everything
     * reachable from it is already on the destination branch, so checkpoints exclude it.
     * Unset for a contributor-branch worktree: after final-push adoption only the
     * captured SHA is known to exist upstream.
     */
    private publishedHead?: string;

    constructor(
        private readonly octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>,
        private readonly ref: PullRequestReference,
        private readonly source: Contribution,
    ) {}

    get pendingCompletion(): PublicationCompletion | undefined {
        return this.continuation?.publication_completion
            ? JSON.parse(this.continuation.publication_completion) as PublicationCompletion : undefined;
    }

    async finishCompletion() {
        if (this.continuation) await savePublicationCheckpoint(this.continuation, null, null);
    }

    get target() { return this.continuation ? continuationTarget(this.continuation) : resolvePullRequestGitTarget(this.source.head, this.ref); }
    get status() { return continuationStatus(this.continuation); }

    private async adopt(publishHead?: PublishContinuationHead) {
        this.continuation = await ensurePRContinuation(this.octokit, this.ref, this.source, publishHead);
    }

    /** Before implementation there is no HEAD that could make the continuation PR
     * non-empty. When the base already contains the captured SHA, GitHub rejects the
     * PR; keep the reservation and its branch as the destination and let push() create
     * the PR once implementation has a checkpointed HEAD.
     */
    private async adoptBeforeImplementation() {
        try {
            await this.adopt();
        } catch (error) {
            if (!isEmptyPullRequestError(error)) throw error;
            const reservation = await findPRContinuation(this.ref);
            if (!reservation) throw error;
            this.continuation = reservation;
        }
    }

    async announce() {
        if (!this.continuation?.continuation_pr) return;
        try {
            await announceContinuation(this.octokit, this.continuation);
        } catch (error) {
            // comment_id remains unset so delivery can be retried independently.
            logger.warn({ error: (error as Error).message, sourcePR: this.continuation.source_pr }, 'Continuation announcement pending retry');
        }
    }

    /** Restores the checkpoint into the worktree and publishes it. Idempotent: a
     * branch that already contains the commits merges and pushes as up to date.
     */
    private async publishCheckpoint(worktreePath: string, token: string) {
        await restorePublicationBundle(worktreePath, this.continuation!.publication_bundle!);
        const result = await pushContinuationHead(worktreePath, this.target, token);
        this.publishedHead = result.commitHash;
        return result;
    }

    private async recover(worktreePath: string, token: string) {
        if (this.continuation?.publication_bundle) {
            const result = await this.publishCheckpoint(worktreePath, token);
            await this.markPublished(result.commitHash);
        }
        await this.announce();
    }

    /** A push can succeed without its acknowledgement/checkpoint update. GitHub
     * retains the PR head even after merge and branch deletion; compare against
     * that commit before requiring an open PR or preparing a branch worktree.
     */
    async reconcilePublication(): Promise<void> {
        const record = this.continuation;
        if (!record?.publication_bundle) return;
        // createPublicationBundle stores HEAD in the bundle header. Restrict the
        // lookup to that header, never the binary pack or completion metadata.
        const header = Buffer.from(record.publication_bundle, 'base64').toString('latin1').split('\n\n', 1)[0];
        const checkpointHead = /^([a-f0-9]{40}) HEAD$/m.exec(header)?.[1];
        if (!checkpointHead) throw new Error('Publication checkpoint has no valid HEAD');
        const { repoOwner: owner, repoName: repo } = continuationTarget(record);
        const pr = record.continuation_pr
            ? (await this.octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', { owner, repo, pull_number: record.continuation_pr })).data
            : (await this.octokit.paginate('GET /repos/{owner}/{repo}/pulls', {
                owner, repo, head: `${owner}:${record.branch_name}`, state: 'all', per_page: 100,
            })).find(pr => pr.body?.includes(`<!-- propr-continuation:${record.source_pr}:${record.source_sha} -->`));
        if (!pr) return;
        if (pr.head.ref !== record.branch_name || pr.base.ref !== record.base_branch || pr.head.repo?.full_name.toLowerCase() !== record.repository) {
            throw new Error(`Continuation PR #${pr.number} has an unexpected Git target`);
        }
        if (!pr.head.sha || !/^[a-f0-9]{40}$/i.test(pr.head.sha)) throw new Error('Continuation PR has no valid head SHA');
        const comparison = await this.octokit.request('GET /repos/{owner}/{repo}/compare/{basehead}', {
            owner, repo, basehead: `${checkpointHead}...${pr.head.sha}`,
        }).then(response => response.data).catch(error => {
            // An unpublished checkpoint commit may not exist remotely yet.
            if ((error as { status?: number }).status === 404) return undefined;
            throw error;
        });
        if (!comparison) return;
        if (comparison.status !== 'ahead' && comparison.status !== 'identical') return;
        // Recover the mapping too when PR creation's acknowledgement was lost.
        this.continuation = await findPRContinuation({ repoOwner: owner, repoName: repo, pullRequestNumber: pr.number }, this.octokit);
        if (!this.continuation) throw new Error('Cannot resolve published continuation');
        await this.markPublished(pr.head.sha);
    }

    private async createWorktree(worktreeDirName: string, token: string) {
        const checkpointBaseline = this.continuation?.source_sha ?? (this.target.isFork ? this.source.head.sha : undefined);
        if (this.target.isFork && (!checkpointBaseline || !/^[a-f0-9]{40}$/i.test(checkpointBaseline))) throw new Error('Cannot prepare fork publication without its exact head SHA');
        const prepared = await createPullRequestHeadWorktree({ target: this.target, authToken: token, worktreeDirName, checkpointBaseline });
        // The worktree was just fetched from the continuation branch, so its HEAD is published.
        this.publishedHead = this.continuation ? (await createHooklessGit(prepared.worktreeInfo.worktreePath).revparse(['HEAD'])).trim() : undefined;
        return prepared;
    }

    async prepare(worktreeDirName: string) {
        const { token } = await this.octokit.auth({ type: 'installation' }) as { token: string };
        let prepared: Awaited<ReturnType<typeof createPullRequestHeadWorktree>> | undefined;
        const discard = async () => {
            if (prepared) await cleanupWorktree(prepared.localRepoPath, prepared.worktreeInfo.worktreePath, prepared.worktreeInfo.branchName);
            prepared = undefined;
        };
        try {
            // Resolve an existing mapping before checking permissions: once adopted,
            // later requests must not silently switch back to the contributor's branch.
            const existing = await findPRContinuation(this.ref);
            if (existing) {
                this.continuation = existing;
                // A checkpoint without a PR means creation failed earlier. If the base now
                // contains the captured SHA, GitHub rejects the branch as empty; the saved
                // commits are published first. The checkpoint stays until both succeed.
                if (existing.publication_bundle) {
                    await this.adopt(async () => {
                        prepared = await this.createWorktree(worktreeDirName, token);
                        await this.publishCheckpoint(prepared.worktreeInfo.worktreePath, token);
                    });
                } else {
                    await this.adoptBeforeImplementation();
                }
            }
            prepared ??= await this.createWorktree(worktreeDirName, token);
            if (!this.target.isFork) {
                await this.recover(prepared.worktreeInfo.worktreePath, token);
                return prepared;
            }
        } catch (error) {
            await discard();
            throw error;
        }
        try {
            await checkPullRequestHeadWritable(prepared.worktreeInfo.worktreePath, this.target, token);
            return prepared;
        } catch (error) {
            await discard();
            if (!isPublicationPermissionDenied(error)) throw error;
            await this.adoptBeforeImplementation();
            await this.announce();
            return this.createWorktree(worktreeDirName, token);
        }
    }

    private async markPublished(commitHash: string) {
        const completion = this.pendingCompletion;
        if (completion?.commitResult) completion.commitResult.commitHash = commitHash;
        await savePublicationCheckpoint(this.continuation!, null, completion ? JSON.stringify(completion) : undefined);
    }

    async push(worktreePath: string, completion?: PublicationCompletion) {
        const { token } = await this.octokit.auth({ type: 'installation' }) as { token: string };
        if (!this.continuation) {
            try {
                return await pushPullRequestHeadBranch({ worktreePath, target: this.target, authToken: token });
            } catch (error) {
                if (!this.target.isFork || !isPublicationPermissionDenied(error)) throw error;
                this.continuation = await findPRContinuation(this.ref) || await reserveContinuation(this.ref, this.source);
            }
        }
        // Save the actual Git objects before any fallible adoption API request. Checkpoint
        // continuation implementations too, including failed remote pushes. Follow-ups on
        // an existing continuation bundle only commits beyond its published tip, never the
        // whole history since the captured contribution.
        const bundle = await createPublicationBundle(worktreePath, this.continuation!.source_sha, this.publishedHead ? [this.publishedHead] : []);
        await savePublicationCheckpoint(this.continuation!, bundle, completion ? JSON.stringify(completion) : undefined);
        // A reservation without a PR comes from final-push adoption or from a preflight
        // where the base already contained the captured SHA. This HEAD is published to
        // the reserved branch first when GitHub would otherwise reject the PR as empty.
        if (!this.continuation!.continuation_pr) await this.adopt(target => pushContinuationHead(worktreePath, target, token));
        // Publish the existing HEAD directly. No checkout, reset, cherry-pick or agent rerun.
        const result = await pushContinuationHead(worktreePath, this.target, token);
        await this.markPublished(result.commitHash);
        await this.announce();
        return result;
    }
}
