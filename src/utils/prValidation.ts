import { Octokit } from '@octokit/core';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import logger from './logger.js';
import { handleError } from './errorHandler.js';
import { withRetry, retryConfigs } from './retryHandler.js';

export interface PRInfo {
    number: number;
    url: string;
    title: string;
    state: string;
}

export interface PRValidationResult {
    isValid: boolean;
    pr?: PRInfo;
    error?: string;
}

export interface ValidatePRCreationOptions {
    owner: string;
    repoName: string;
    branchName: string;
    expectedPrNumber?: number;
    correlationId: string;
}

export async function validatePRCreation(options: ValidatePRCreationOptions): Promise<PRValidationResult> {
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
                    error: (directCheckError as Error).message
                }, 'Direct PR validation failed, falling back to branch search');
            }
        }

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
                const pr = prs[0];
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
                error: (searchError as Error).message
            }, 'PR search validation failed');
        }

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
                error: (branchError as Error).message
            }, 'Branch existence check failed');
        }

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
        const errorMessage = `PR validation failed: ${(error as Error).message}`;
        handleError(error, errorMessage, { correlationId });

        return {
            isValid: false,
            error: errorMessage
        };
    }
}

export interface IssueRef {
    repoOwner: string;
    repoName: string;
    number: number;
}

export interface CurrentIssueData {
    title: string;
    html_url: string;
    body?: string | null;
}

export interface GenerateEnhancedClaudePromptOptions {
    issueRef: IssueRef;
    currentIssueData: CurrentIssueData;
    worktreePath: string;
    branchName: string;
    baseBranch: string;
}

export function generateEnhancedClaudePrompt(options: GenerateEnhancedClaudePromptOptions): string {
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

export interface RepoData {
    fullName: string;
    defaultBranch: string;
    private: boolean;
    cloneUrl: string;
}

export interface RepoValidationResult {
    isValid: boolean;
    repoData?: RepoData;
    error?: string;
}

export async function validateRepositoryInfo(issueRef: IssueRef, octokit: InstanceType<typeof Octokit>, correlationId: string): Promise<RepoValidationResult> {
    const correlatedLogger = logger.withCorrelation(correlationId);

    try {
        const repoResponse = await withRetry(
            () => octokit.request('GET /repos/{owner}/{repo}', {
                owner: issueRef.repoOwner,
                repo: issueRef.repoName
            }),
            { ...retryConfigs.githubApi, correlationId },
            `validate_repo_${issueRef.repoOwner}_${issueRef.repoName}`
        );

        const repoData = repoResponse.data;

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
        const errorMessage = `Repository validation failed: ${(error as Error).message}`;
        handleError(error, errorMessage, { issueRef, correlationId });

        return {
            isValid: false,
            error: errorMessage
        };
    }
}
