import logger from './logger.js';
import { withRetry, retryConfigs, type RetryOptions } from './retryHandler.js';
import { makeIdempotent } from './errorHandler.js';
import type { Logger } from 'pino';

interface Label {
    name: string;
}

interface Issue {
    data: {
        labels: Label[];
    };
}

interface Comment {
    body: string;
}

interface PR {
    data: Array<{
        number: number;
        url: string;
        [key: string]: unknown;
    }>;
}

interface Octokit {
    request: <T = unknown>(route: string, options?: Record<string, unknown>) => Promise<T>;
    paginate: <T = unknown>(route: string, options?: Record<string, unknown>) => Promise<T[]>;
}

/**
 * Idempotent GitHub label operations
 */
export class IdempotentGitHubOps {
    private octokit: Octokit;
    private correlationId: string;
    private correlatedLogger: Logger;

    constructor(octokit: Octokit, correlationId: string) {
        this.octokit = octokit;
        this.correlationId = correlationId;
        this.correlatedLogger = logger.withCorrelation(correlationId);
    }

    /**
     * Idempotently adds a label to an issue
     * @param owner - Repository owner
     * @param repo - Repository name
     * @param issueNumber - Issue number
     * @param label - Label to add
     * @returns True if label was added or already existed
     */
    async addLabel(owner: string, repo: string, issueNumber: number, label: string): Promise<boolean> {
        const checkLabelExists = async (): Promise<boolean> => {
            try {
                const issue = await this.octokit.request<Issue>('GET /repos/{owner}/{repo}/issues/{issue_number}', {
                    owner,
                    repo,
                    issue_number: issueNumber,
                });
                return issue.data.labels.some(l => l.name === label);
            } catch {
                return false;
            }
        };

        const addLabelOperation = async (): Promise<unknown> => {
            return await withRetry(
                () => this.octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
                    owner,
                    repo,
                    issue_number: issueNumber,
                    labels: [label],
                }),
                { ...retryConfigs.githubApi, correlationId: this.correlationId } as RetryOptions,
                `add_label_${label}_to_issue_${issueNumber}`
            );
        };

        const idempotentAdd = makeIdempotent(
            addLabelOperation,
            checkLabelExists,
            `add_label_${label}`
        );

        try {
            await idempotentAdd();
            this.correlatedLogger.info({
                owner,
                repo,
                issueNumber,
                label
            }, 'Label added to issue (idempotent)');
            return true;
        } catch (error) {
            this.correlatedLogger.error({
                owner,
                repo,
                issueNumber,
                label,
                error: (error as Error).message
            }, 'Failed to add label to issue');
            throw error;
        }
    }

    /**
     * Idempotently removes a label from an issue
     * @param owner - Repository owner
     * @param repo - Repository name
     * @param issueNumber - Issue number
     * @param label - Label to remove
     * @returns True if label was removed or didn't exist
     */
    async removeLabel(owner: string, repo: string, issueNumber: number, label: string): Promise<boolean> {
        const checkLabelNotExists = async (): Promise<boolean> => {
            try {
                const issue = await this.octokit.request<Issue>('GET /repos/{owner}/{repo}/issues/{issue_number}', {
                    owner,
                    repo,
                    issue_number: issueNumber,
                });
                return !issue.data.labels.some(l => l.name === label);
            } catch {
                return true;
            }
        };

        const removeLabelOperation = async (): Promise<unknown> => {
            return await withRetry(
                () => this.octokit.request('DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}', {
                    owner,
                    repo,
                    issue_number: issueNumber,
                    name: label,
                }),
                { ...retryConfigs.githubApi, correlationId: this.correlationId } as RetryOptions,
                `remove_label_${label}_from_issue_${issueNumber}`
            );
        };

        const idempotentRemove = makeIdempotent(
            removeLabelOperation,
            checkLabelNotExists,
            `remove_label_${label}`
        );

        try {
            await idempotentRemove();
            this.correlatedLogger.info({
                owner,
                repo,
                issueNumber,
                label
            }, 'Label removed from issue (idempotent)');
            return true;
        } catch (error) {
            const err = error as { status?: number; message?: string };
            if (err.status === 404) {
                this.correlatedLogger.debug({
                    owner,
                    repo,
                    issueNumber,
                    label
                }, 'Label already does not exist on issue');
                return true;
            }

            this.correlatedLogger.error({
                owner,
                repo,
                issueNumber,
                label,
                error: err.message
            }, 'Failed to remove label from issue');
            throw error;
        }
    }

    /**
     * Idempotently adds a comment to an issue
     * @param owner - Repository owner
     * @param repo - Repository name
     * @param issueNumber - Issue number
     * @param options - Comment options including body and optional idempotency key
     * @returns Comment data
     */
    async addComment(
        owner: string,
        repo: string,
        issueNumber: number,
        options: { body: string; idempotencyKey?: string | null } = { body: '' }
    ): Promise<unknown> {
        const { body, idempotencyKey: providedIdempotencyKey = null } = options;
        let idempotencyKey = providedIdempotencyKey;

        if (!idempotencyKey) {
            const crypto = await import('crypto');
            idempotencyKey = crypto.createHash('md5').update(body).digest('hex').substring(0, 8);
        }

        const checkCommentExists = async (): Promise<Comment | null> => {
            try {
                const comments = await this.octokit.paginate<Comment>('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                    owner,
                    repo,
                    issue_number: issueNumber,
                    per_page: 100
                });

                const keyPattern = `<!-- idempotency-key: ${idempotencyKey} -->`;
                return comments.find(comment => comment.body.includes(keyPattern)) ?? null;
            } catch {
                return null;
            }
        };

        const addCommentOperation = async (): Promise<unknown> => {
            const bodyWithKey = `${body}\n\n<!-- idempotency-key: ${idempotencyKey} -->`;

            return await withRetry(
                () => this.octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                    owner,
                    repo,
                    issue_number: issueNumber,
                    body: bodyWithKey,
                }),
                { ...retryConfigs.githubApi, correlationId: this.correlationId } as RetryOptions,
                `add_comment_to_issue_${issueNumber}`
            );
        };

        const idempotentAdd = makeIdempotent(
            addCommentOperation,
            checkCommentExists,
            `add_comment_${idempotencyKey}`
        );

        try {
            const result = await idempotentAdd();
            this.correlatedLogger.info({
                owner,
                repo,
                issueNumber,
                idempotencyKey
            }, 'Comment added to issue (idempotent)');
            return result;
        } catch (error) {
            this.correlatedLogger.error({
                owner,
                repo,
                issueNumber,
                idempotencyKey,
                error: (error as Error).message
            }, 'Failed to add comment to issue');
            throw error;
        }
    }

    /**
     * Idempotently checks if a PR exists for a branch
     * @param owner - Repository owner
     * @param repo - Repository name
     * @param head - Head branch (e.g., "username:branch-name")
     * @returns PR data if exists, null otherwise
     */
    async checkPRExists(owner: string, repo: string, head: string): Promise<{ number: number; url: string } | null> {
        try {
            const prs = await withRetry(
                () => this.octokit.request<PR>('GET /repos/{owner}/{repo}/pulls', {
                    owner,
                    repo,
                    head,
                    state: 'all',
                    per_page: 10
                }),
                { ...retryConfigs.githubApi, correlationId: this.correlationId } as RetryOptions,
                `check_pr_exists_${head}`
            );

            return prs.data.length > 0 ? prs.data[0] as { number: number; url: string } : null;
        } catch (error) {
            this.correlatedLogger.warn({
                owner,
                repo,
                head,
                error: (error as Error).message
            }, 'Failed to check if PR exists');
            return null;
        }
    }
}

/**
 * Idempotent Git operations
 */
export class IdempotentGitOps {
    private correlationId: string;
    private correlatedLogger: Logger;

    constructor(correlationId: string) {
        this.correlationId = correlationId;
        this.correlatedLogger = logger.withCorrelation(correlationId);
    }

    /**
     * Idempotently ensures a repository is cloned/updated
     * @param repoUrl - Repository URL
     * @param localPath - Local path for the repository
     * @returns Local repository path
     */
    async ensureRepoCloned(repoUrl: string, localPath: string): Promise<string> {
        const fs = await import('fs');
        const path = await import('path');

        const checkRepoExists = async (): Promise<boolean> => {
            try {
                const gitDir = path.join(localPath, '.git');
                return fs.existsSync(gitDir);
            } catch {
                return false;
            }
        };

        if (await checkRepoExists()) {
            this.correlatedLogger.debug({
                repoUrl,
                localPath
            }, 'Repository already exists, skipping clone');
            return localPath;
        }

        throw new Error('Repository does not exist and cloning should be handled by existing function');
    }

    /**
     * Idempotently creates a worktree
     * @param repoPath - Repository path
     * @param worktreePath - Worktree path
     * @param branchName - Branch name
     * @returns True if worktree was created or already exists
     */
    async ensureWorktreeExists(repoPath: string, worktreePath: string, branchName: string): Promise<boolean> {
        const fs = await import('fs');

        const checkWorktreeExists = async (): Promise<boolean> => {
            try {
                return fs.existsSync(worktreePath);
            } catch {
                return false;
            }
        };

        if (await checkWorktreeExists()) {
            this.correlatedLogger.debug({
                repoPath,
                worktreePath,
                branchName
            }, 'Worktree already exists, skipping creation');
            return true;
        }

        return false;
    }
}

export default {
    IdempotentGitHubOps,
    IdempotentGitOps
};
