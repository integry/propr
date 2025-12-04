import { getAuthenticatedOctokit } from '../auth/githubAuth.js'; 
import logger from '../utils/logger.js';
import { ensureBranchAndPush } from '../git/repoManager.js';
import { handleError } from '../utils/errorHandler.js';

const DEFAULT_BASE_BRANCH = process.env.GIT_DEFAULT_BRANCH || 'main';

async function findExistingPRForBranch(octokit, repoContext, errorMessage) {
    const { owner, repoName, branchName } = repoContext;
    logger.info({ owner, repoName, branchName, error: errorMessage }, 'PR already exists for this branch, attempting to find existing PR');
    
    try {
        const existingPRs = await octokit.request('GET /repos/{owner}/{repo}/pulls', {
            owner,
            repo: repoName,
            head: `${owner}:${branchName}`,
            state: 'open'
        });
        
        if (existingPRs.data.length > 0) {
            const existingPR = existingPRs.data[0];
            logger.info({ owner, repoName, branchName, prNumber: existingPR.number, prUrl: existingPR.html_url }, 'Found existing PR for branch');
            
            return {
                success: true,
                pr: {
                    number: existingPR.number,
                    url: existingPR.html_url,
                    title: existingPR.title,
                    state: existingPR.state
                }
            };
        }
    } catch (findError) {
        logger.warn({ error: findError.message }, 'Failed to find existing PR');
    }
    return null;
}

export async function createPullRequestRobust(params) {
    const { 
        owner, 
        repoName, 
        branchName, 
        baseBranch, 
        issueNumber, 
        prTitle, 
        prBody,
        worktreePath,
        repoUrl,
        authToken
    } = params;
    
    const octokit = await getAuthenticatedOctokit();
    
    try {
        logger.info({
            owner,
            repoName,
            branchName,
            baseBranch,
            issueNumber,
            prTitle
        }, 'Creating pull request with robust git operations...');
        
        await ensureBranchAndPush(worktreePath, branchName, baseBranch, {
            repoUrl,
            authToken,
            tokenRefreshFn: async () => {
                const newAuth = await octokit.auth();
                return newAuth.token;
            },
            correlationId: params.correlationId || 'unknown'
        });
        
        logger.debug({ branchName }, 'Waiting for GitHub to propagate branch data...');
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        const maxRetries = 5;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                await octokit.request('GET /repos/{owner}/{repo}/branches/{branch}', {
                    owner,
                    repo: repoName,
                    branch: branchName
                });
                logger.debug({ branchName, attempt }, 'Confirmed branch exists on remote');
                break;
            } catch (branchCheckError) {
                if (attempt === maxRetries) {
                    throw new Error(`Branch '${branchName}' does not exist on remote after ${maxRetries} attempts: ${branchCheckError.message}`);
                }
                
                const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
                logger.debug({ 
                    branchName, 
                    attempt, 
                    delay,
                    error: branchCheckError.message 
                }, 'Branch not found, retrying...');
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
        
        try {
            const compareResult = await octokit.request('GET /repos/{owner}/{repo}/compare/{base}...{head}', {
                owner,
                repo: repoName,
                base: baseBranch,
                head: branchName
            });
            
            if (compareResult.data.ahead_by === 0) {
                logger.warn({
                    owner,
                    repoName,
                    branchName,
                    baseBranch,
                    aheadBy: compareResult.data.ahead_by
                }, 'No commits found between base and head branch - skipping PR creation');
                
                return {
                    success: false,
                    error: 'No commits between base and head branch',
                    skipPR: true
                };
            }
            
            logger.debug({
                branchName,
                baseBranch,
                aheadBy: compareResult.data.ahead_by,
                behindBy: compareResult.data.behind_by
            }, 'Confirmed commits exist between branches');
            
        } catch (compareError) {
            logger.warn({
                branchName,
                baseBranch,
                error: compareError.message
            }, 'Could not compare branches, proceeding with PR creation anyway');
        }
        
        let response;
        try {
            response = await octokit.request('POST /repos/{owner}/{repo}/pulls', {
                owner,
                repo: repoName,
                title: prTitle,
                head: branchName,
                base: baseBranch,
                body: prBody,
                draft: false
            });
        } catch (prCreateError) {
            if (prCreateError.status === 422 && prCreateError.message?.includes('A pull request already exists')) {
                const existingResult = await findExistingPRForBranch(octokit, { owner, repoName, branchName }, prCreateError.message);
                if (existingResult) return existingResult;
            }
            
            if ((prCreateError.status === 422 || prCreateError.status === 400) && 
                (prCreateError.message?.includes('no history in common') || 
                 prCreateError.message?.includes('does not have any commits') ||
                 prCreateError.message?.includes('No commits between') ||
                 prCreateError.message?.includes('Head sha can\'t be blank') ||
                 prCreateError.message?.includes('Base sha can\'t be blank'))) {
                
                logger.warn({
                    owner,
                    repoName,
                    branchName,
                    baseBranch,
                    error: prCreateError.message
                }, 'Branch has no history in common with base branch, waiting for GitHub sync...');
                
                await new Promise(resolve => setTimeout(resolve, 10000));
                
                try {
                    response = await octokit.request('POST /repos/{owner}/{repo}/pulls', {
                        owner,
                        repo: repoName,
                        title: prTitle,
                        head: branchName,
                        base: baseBranch,
                        body: prBody,
                        draft: false
                    });
                    
                    logger.info({
                        owner,
                        repoName,
                        branchName,
                        baseBranch
                    }, 'PR creation succeeded after retry for history sync issue');
                    
                } catch (retryError) {
                    logger.error({
                        owner,
                        repoName,
                        branchName,
                        baseBranch,
                        originalError: prCreateError.message,
                        retryError: retryError.message
                    }, 'PR creation failed even after retry for history sync issue');
                    throw retryError;
                }
            } else {
                throw prCreateError;
            }
        }
        
        const prData = response.data;
        
        logger.info({
            owner,
            repoName,
            issueNumber,
            prNumber: prData.number,
            prUrl: prData.html_url,
            branchName,
            baseBranch
        }, 'Pull request created successfully');
        
        return {
            success: true,
            pr: {
                number: prData.number,
                url: prData.html_url,
                title: prData.title,
                state: prData.state
            }
        };
        
    } catch (error) {
        logger.error({
            owner,
            repoName,
            branchName,
            baseBranch,
            issueNumber,
            error: error.message
        }, 'Failed to create pull request');
        
        handleError(error, `Failed to create pull request for ${owner}/${repoName}#${issueNumber}`);
        throw error;
    }
}

export async function createPullRequest(options) {
    const {
        owner,
        repoName,
        branchName,
        baseBranch = DEFAULT_BASE_BRANCH,
        issueNumber,
        issueTitle,
        commitMessage,
        claudeResult
    } = options;

    try {
        const octokit = await getAuthenticatedOctokit();

        const prTitle = `AI Fix for Issue #${issueNumber}: ${issueTitle}`;
        const { generatePRBody } = await import('./prFormatters.js');
        const prBody = generatePRBody(issueNumber, issueTitle, commitMessage, claudeResult);

        logger.info({
            owner,
            repoName,
            branchName,
            baseBranch,
            issueNumber,
            prTitle
        }, 'Creating pull request...');

        const response = await octokit.request('POST /repos/{owner}/{repo}/pulls', {
            owner,
            repo: repoName,
            title: prTitle,
            head: branchName,
            base: baseBranch,
            body: prBody,
            draft: false
        });

        const prData = response.data;

        logger.info({
            owner,
            repoName,
            issueNumber,
            prNumber: prData.number,
            prUrl: prData.html_url,
            branchName
        }, 'Pull request created successfully');

        return {
            number: prData.number,
            url: prData.html_url,
            title: prData.title
        };

    } catch (error) {
        handleError(error, `Failed to create pull request for issue #${issueNumber}`);
        throw error;
    }
}

export async function addClaudeLogsComment(options) {
    const {
        owner,
        repoName,
        prNumber,
        claudeResult,
        issueNumber
    } = options;

    try {
        const octokit = await getAuthenticatedOctokit();

        const { generateClaudeLogsComment } = await import('./prFormatters.js');
        const commentBody = generateClaudeLogsComment(claudeResult, issueNumber);

        logger.info({
            owner,
            repoName,
            prNumber,
            issueNumber,
            commentLength: commentBody.length
        }, 'Adding Claude logs comment to PR...');

        await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner,
            repo: repoName,
            issue_number: prNumber,
            body: commentBody
        });

        logger.info({
            owner,
            repoName,
            prNumber,
            issueNumber
        }, 'Claude logs comment added successfully');

    } catch (error) {
        handleError(error, `Failed to add Claude logs comment to PR #${prNumber}`);
        throw error;
    }
}

export async function updateIssueLabels(options) {
    const {
        owner,
        repoName,
        issueNumber,
        labelsToRemove = [],
        labelsToAdd = []
    } = options;

    try {
        const octokit = await getAuthenticatedOctokit();

        const issueResponse = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
            owner,
            repo: repoName,
            issue_number: issueNumber
        });

        const currentLabels = issueResponse.data.labels.map(label => label.name);

        const updatedLabels = [
            ...currentLabels.filter(label => !labelsToRemove.includes(label)),
            ...labelsToAdd.filter(label => !currentLabels.includes(label))
        ];

        logger.info({
            owner,
            repoName,
            issueNumber,
            currentLabels,
            labelsToRemove,
            labelsToAdd,
            updatedLabels
        }, 'Updating issue labels...');

        await octokit.request('PUT /repos/{owner}/{repo}/issues/{issue_number}/labels', {
            owner,
            repo: repoName,
            issue_number: issueNumber,
            labels: updatedLabels
        });

        logger.info({
            owner,
            repoName,
            issueNumber,
            updatedLabels
        }, 'Issue labels updated successfully');

        return updatedLabels;

    } catch (error) {
        handleError(error, `Failed to update labels for issue #${issueNumber}`);
        throw error;
    }
}
