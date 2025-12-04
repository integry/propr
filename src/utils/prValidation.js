import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import logger from './logger.js';
import { handleError } from './errorHandler.js';
import { withRetry, retryConfigs } from './retryHandler.js';

/**
 * Validates that a Pull Request was successfully created
 * @param {Object} options - Validation options
 * @param {string} options.owner - Repository owner
 * @param {string} options.repoName - Repository name
 * @param {string} options.branchName - Head branch name
 * @param {number} options.expectedPrNumber - Expected PR number (optional)
 * @param {string} options.correlationId - Correlation ID for logging
 * @returns {Promise<{isValid: boolean, pr?: Object, error?: string}>} Validation result
 */
export async function validatePRCreation(options) {
    const {
        owner,
        repoName,
        branchName,
        expectedPrNumber,
        correlationId
    } = options;

    const correlatedLogger = logger.withCorrelation(correlationId);

    try {
        const octokit = await getAuthenticatedOctokit();

        // Method 1: If we have an expected PR number, check it directly
        if (expectedPrNumber) {
            try {
                const prResponse = await withRetry(
                    () => octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
                        owner,
                        repo: repoName,
                        pull_number: expectedPrNumber
                    }),
                    { ...retryConfigs.githubApi, correlationId },
                    `validate_pr_direct_${expectedPrNumber}`
                );

                const pr = prResponse.data;
                if (pr.head.ref === branchName && pr.state === 'open') {
                    correlatedLogger.info({
                        owner,
                        repoName,
                        branchName,
                        prNumber: pr.number,
                        prUrl: pr.html_url
                    }, 'PR validation successful - direct check');

                    return {
                        isValid: true,
                        pr: {
                            number: pr.number,
                            url: pr.html_url,
                            title: pr.title,
                            state: pr.state
                        }
                    };
                }
            } catch (directCheckError) {
                correlatedLogger.warn({
                    owner,
                    repoName,
                    expectedPrNumber,
                    error: directCheckError.message
                }, 'Direct PR validation failed, falling back to branch search');
            }
        }

        // Method 2: Search for PRs with the head branch
        try {
            const prListResponse = await withRetry(
                () => octokit.request('GET /repos/{owner}/{repo}/pulls', {
                    owner,
                    repo: repoName,
                    state: 'open',
                    head: `${owner}:${branchName}`,
                    per_page: 10
                }),
                { ...retryConfigs.githubApi, correlationId },
                `validate_pr_search_${branchName}`
            );

            const prs = prListResponse.data;
            if (prs.length > 0) {
                const pr = prs[0]; // Take the first (most recent) PR
                correlatedLogger.info({
                    owner,
                    repoName,
                    branchName,
                    prNumber: pr.number,
                    prUrl: pr.html_url,
                    foundPrs: prs.length
                }, 'PR validation successful - branch search');

                return {
                    isValid: true,
                    pr: {
                        number: pr.number,
                        url: pr.html_url,
                        title: pr.title,
                        state: pr.state
                    }
                };
            }
        } catch (searchError) {
            correlatedLogger.warn({
                owner,
                repoName,
                branchName,
                error: searchError.message
            }, 'PR search validation failed');
        }

        // Method 3: Check if branch exists on remote (indicates push succeeded but PR creation failed)
        try {
            const branchResponse = await withRetry(
                () => octokit.request('GET /repos/{owner}/{repo}/branches/{branch}', {
                    owner,
                    repo: repoName,
                    branch: branchName
                }),
                { ...retryConfigs.githubApi, correlationId },
                `validate_branch_exists_${branchName}`
            );

            if (branchResponse.data) {
                correlatedLogger.warn({
                    owner,
                    repoName,
                    branchName,
                    branchSha: branchResponse.data.commit.sha
                }, 'Branch exists on remote but no PR found - PR creation likely failed');

                return {
                    isValid: false,
                    error: 'Branch pushed successfully but PR creation failed'
                };
            }
        } catch (branchError) {
            correlatedLogger.warn({
                owner,
                repoName,
                branchName,
                error: branchError.message
            }, 'Branch existence check failed');
        }

        // No PR found and validation methods exhausted
        correlatedLogger.warn({
            owner,
            repoName,
            branchName,
            expectedPrNumber
        }, 'PR validation failed - no PR found for branch');

        return {
            isValid: false,
            error: 'No pull request found for the branch'
        };

    } catch (error) {
        const errorMessage = `PR validation failed: ${error.message}`;
        handleError(error, errorMessage, { owner, repoName, branchName, correlationId });
        
        return {
            isValid: false,
            error: errorMessage
        };
    }
}

/**
 * Generates enhanced Claude prompt with explicit repository metadata
 * @param {Object} options - Prompt enhancement options
 * @param {Object} options.issueRef - Issue reference object
 * @param {string} options.currentIssueData - Current issue data from GitHub API
 * @param {string} options.worktreePath - Path to the Git worktree
 * @param {string} options.branchName - Branch name for the issue
 * @param {string} options.baseBranch - Base branch name
 * @returns {string} Enhanced prompt for Claude
 */
export function generateEnhancedClaudePrompt(options) {
    const {
        issueRef,
        currentIssueData,
        worktreePath,
        branchName,
        baseBranch
    } = options;

    const prompt = `Please analyze and fix the following GitHub issue:

**REPOSITORY INFORMATION (CRITICAL - USE EXACTLY AS PROVIDED):**
- Repository Owner: ${issueRef.repoOwner}
- Repository Name: ${issueRef.repoName}
- Full Repository: ${issueRef.repoOwner}/${issueRef.repoName}
- Working Directory: ${worktreePath}
- Current Branch: ${branchName}
- Base Branch: ${baseBranch}

**ISSUE DETAILS:**
- Issue Number: #${issueRef.number}
- Issue Title: ${currentIssueData.title}
- Issue URL: ${currentIssueData.html_url}

**ISSUE DESCRIPTION:**
${currentIssueData.body || 'No description provided'}

**IMPORTANT INSTRUCTIONS:**
1. First, use \`gh issue view ${issueRef.number}\` to get the full issue details
2. Use \`gh issue view ${issueRef.number} --comments\` to read all issue comments for additional context
   (Note: Operational comments from gitfixio bot are automatically filtered out)
3. You are working in the directory: ${worktreePath}
4. Make your changes and commit them to the current branch: ${branchName}
5. When creating a Pull Request, use EXACTLY these details:
   - Repository: ${issueRef.repoOwner}/${issueRef.repoName}
   - Head branch: ${branchName}
   - Base branch: ${baseBranch}
   - DO NOT hallucinate or guess repository names
6. The PR should reference issue #${issueRef.number}
7. Test your changes thoroughly before creating the PR

Please analyze the complete issue and comments, implement a solution, and create a Pull Request with the exact repository information provided above.`;

    return prompt;
}

/**
 * Validates repository information to ensure it's correct before Claude execution
 * @param {Object} issueRef - Issue reference object
 * @param {Object} octokit - Authenticated Octokit instance
 * @param {string} correlationId - Correlation ID for logging
 * @returns {Promise<{isValid: boolean, repoData?: Object, error?: string}>} Validation result
 */
export async function validateRepositoryInfo(issueRef, octokit, correlationId) {
    const correlatedLogger = logger.withCorrelation(correlationId);
    
    try {
        // Verify repository exists and is accessible
        const repoResponse = await withRetry(
            () => octokit.request('GET /repos/{owner}/{repo}', {
                owner: issueRef.repoOwner,
                repo: issueRef.repoName
            }),
            { ...retryConfigs.githubApi, correlationId },
            `validate_repo_${issueRef.repoOwner}_${issueRef.repoName}`
        );

        const repoData = repoResponse.data;
        
        // Verify issue exists in this repository
        await withRetry(
            () => octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
                owner: issueRef.repoOwner,
                repo: issueRef.repoName,
                issue_number: issueRef.number
            }),
            { ...retryConfigs.githubApi, correlationId },
            `validate_issue_${issueRef.number}`
        );

        correlatedLogger.info({
            owner: issueRef.repoOwner,
            repoName: issueRef.repoName,
            issueNumber: issueRef.number,
            repoFullName: repoData.full_name,
            defaultBranch: repoData.default_branch
        }, 'Repository and issue validation successful');

        return {
            isValid: true,
            repoData: {
                fullName: repoData.full_name,
                defaultBranch: repoData.default_branch,
                private: repoData.private,
                cloneUrl: repoData.clone_url
            }
        };

    } catch (error) {
        const errorMessage = `Repository validation failed: ${error.message}`;
        handleError(error, errorMessage, { issueRef, correlationId });
        
        return {
            isValid: false,
            error: errorMessage
        };
    }
}