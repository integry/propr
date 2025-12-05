import logger from './logger.js';
import { withRetry, retryConfigs } from './retryHandler.js';
import { makeIdempotent } from './errorHandler.js';

/**
 * Idempotent GitHub label operations
 */
export class IdempotentGitHubOps {
    constructor(octokit, correlationId) {
        this.octokit = octokit;
        this.correlationId = correlationId;
        this.correlatedLogger = logger.withCorrelation(correlationId);
    }

    /**
     * Idempotently adds a label to an issue
     * @param {string} owner - Repository owner
     * @param {string} repo - Repository name
     * @param {number} issueNumber - Issue number
     * @param {string} label - Label to add
     * @returns {Promise<boolean>} True if label was added or already existed
     */
    async addLabel(owner, repo, issueNumber, label) {
        const checkLabelExists = async () => {
            try {
                const issue = await this.octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
                    owner,
                    repo,
                    issue_number: issueNumber,
                });
                return issue.data.labels.some(l => l.name === label);
            } catch {
                return false; // Assume label doesn't exist if we can't check
            }
        };

        const addLabelOperation = async () => {
            return await withRetry(
                () => this.octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
                    owner,
                    repo,
                    issue_number: issueNumber,
                    labels: [label],
                }),
                { ...retryConfigs.githubApi, correlationId: this.correlationId },
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
                error: error.message
            }, 'Failed to add label to issue');
            throw error;
        }
    }

    /**
     * Idempotently removes a label from an issue
     * @param {string} owner - Repository owner
     * @param {string} repo - Repository name
     * @param {number} issueNumber - Issue number
     * @param {string} label - Label to remove
     * @returns {Promise<boolean>} True if label was removed or didn't exist
     */
    async removeLabel(owner, repo, issueNumber, label) {
        const checkLabelNotExists = async () => {
            try {
                const issue = await this.octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
                    owner,
                    repo,
                    issue_number: issueNumber,
                });
                return !issue.data.labels.some(l => l.name === label);
            } catch {
                return true; // Assume label doesn't exist if we can't check
            }
        };

        const removeLabelOperation = async () => {
            return await withRetry(
                () => this.octokit.request('DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}', {
                    owner,
                    repo,
                    issue_number: issueNumber,
                    name: label,
                }),
                { ...retryConfigs.githubApi, correlationId: this.correlationId },
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
            // Ignore 404 errors (label already doesn't exist)
            if (error.status === 404) {
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
                error: error.message
            }, 'Failed to remove label from issue');
            throw error;
        }
    }

    /**
     * Idempotently adds a comment to an issue
     * @param {string} owner - Repository owner
     * @param {string} repo - Repository name
     * @param {number} issueNumber - Issue number
     * @param {string} body - Comment body
     * @param {string} idempotencyKey - Unique key to prevent duplicate comments
     * @returns {Promise<object>} Comment data
     */
    async addComment(owner, repo, issueNumber, options = {}) {
        const { body, idempotencyKey: providedIdempotencyKey = null } = options;
        let idempotencyKey = providedIdempotencyKey;
        // If no idempotency key provided, use a hash of the comment body
        if (!idempotencyKey) {
            const crypto = await import('crypto');
            idempotencyKey = crypto.createHash('md5').update(body).digest('hex').substring(0, 8);
        }

        const checkCommentExists = async () => {
            try {
                // Fetch ALL comments using pagination to ensure we don't miss any
                const comments = await this.octokit.paginate('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                    owner,
                    repo,
                    issue_number: issueNumber,
                    per_page: 100
                });

                // Check if a comment with the idempotency key already exists
                const keyPattern = `<!-- idempotency-key: ${idempotencyKey} -->`;
                return comments.find(comment => comment.body.includes(keyPattern));
            } catch {
                return null; // Assume comment doesn't exist if we can't check
            }
        };

        const addCommentOperation = async () => {
            const bodyWithKey = `${body}\n\n<!-- idempotency-key: ${idempotencyKey} -->`;

            return await withRetry(
                () => this.octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                    owner,
                    repo,
                    issue_number: issueNumber,
                    body: bodyWithKey,
                }),
                { ...retryConfigs.githubApi, correlationId: this.correlationId },
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
                error: error.message
            }, 'Failed to add comment to issue');
            throw error;
        }
    }

    /**
     * Idempotently checks if a PR exists for a branch
     * @param {string} owner - Repository owner
     * @param {string} repo - Repository name
     * @param {string} head - Head branch (e.g., "username:branch-name")
     * @returns {Promise<object|null>} PR data if exists, null otherwise
     */
    async checkPRExists(owner, repo, head) {
        try {
            const prs = await withRetry(
                () => this.octokit.request('GET /repos/{owner}/{repo}/pulls', {
                    owner,
                    repo,
                    head,
                    state: 'all',
                    per_page: 10
                }),
                { ...retryConfigs.githubApi, correlationId: this.correlationId },
                `check_pr_exists_${head}`
            );

            return prs.data.length > 0 ? prs.data[0] : null;
        } catch (error) {
            this.correlatedLogger.warn({
                owner,
                repo,
                head,
                error: error.message
            }, 'Failed to check if PR exists');
            return null;
        }
    }
}

/**
 * Idempotent Git operations
 */
export class IdempotentGitOps {
    constructor(correlationId) {
        this.correlationId = correlationId;
        this.correlatedLogger = logger.withCorrelation(correlationId);
    }

    /**
     * Idempotently ensures a repository is cloned/updated
     * @param {string} repoUrl - Repository URL
     * @param {string} localPath - Local path for the repository
     * @returns {Promise<string>} Local repository path
     */
    async ensureRepoCloned(repoUrl, localPath) {
        const fs = await import('fs');
        const path = await import('path');

        const checkRepoExists = async () => {
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

        // If repository doesn't exist, we need to clone it
        // This should be handled by the existing ensureRepoCloned function
        throw new Error('Repository does not exist and cloning should be handled by existing function');
    }

    /**
     * Idempotently creates a worktree
     * @param {string} repoPath - Repository path
     * @param {string} worktreePath - Worktree path
     * @param {string} branchName - Branch name
     * @returns {Promise<boolean>} True if worktree was created or already exists
     */
    async ensureWorktreeExists(repoPath, worktreePath, branchName) {
        const fs = await import('fs');

        const checkWorktreeExists = async () => {
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

        return false; // Let the existing function handle creation
    }
}

export default {
    IdempotentGitHubOps,
    IdempotentGitOps
};