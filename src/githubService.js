import { getAuthenticatedOctokit } from './auth/githubAuth.js';
import logger from './utils/logger.js';
import { handleError } from './utils/errorHandler.js';
import { ensureBranchAndPush } from './git/repoManager.js';

// Configuration
const DEFAULT_BASE_BRANCH = process.env.GIT_DEFAULT_BRANCH || 'main';
const MAX_COMMENT_LENGTH = 65000; // GitHub's comment length limit
 

/**
 * Creates a Pull Request with robust git operations ensuring proper branch history
 * @param {Object} params - PR creation parameters
 * @param {string} params.owner - Repository owner
 * @param {string} params.repoName - Repository name
 * @param {string} params.branchName - Feature branch name
 * @param {string} params.baseBranch - Base branch name
 * @param {number} params.issueNumber - Issue number
 * @param {string} params.prTitle - PR title
 * @param {string} params.prBody - PR body
 * @param {string} params.worktreePath - Path to the worktree
 * @param {string} params.repoUrl - Repository URL
 * @param {string} params.authToken - GitHub auth token
 * @returns {Promise<Object>} Created PR data
 */
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
        
        // Step 1: Ensure branch is properly pushed to remote
        await ensureBranchAndPush(worktreePath, branchName, baseBranch, {
            repoUrl,
            authToken,
            tokenRefreshFn: async () => {
                const newAuth = await octokit.auth();
                return newAuth.token;
            },
            correlationId: params.correlationId || 'unknown'
        });
        
        // Step 1.5: Wait for GitHub to propagate branch data (timing fix)
        logger.debug({ branchName }, 'Waiting for GitHub to propagate branch data...');
        await new Promise(resolve => setTimeout(resolve, 3000)); // 3 second delay
        
        // Step 2: Verify branch exists on remote with retry logic
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
                
                const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000); // Exponential backoff, max 10s
                logger.debug({ 
                    branchName, 
                    attempt, 
                    delay,
                    error: branchCheckError.message 
                }, 'Branch not found, retrying...');
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
        
        // Step 2.5: Check if there are actual commits between base and head branches
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
        
        // Step 3: Create the pull request
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
            // Handle case where PR already exists for this branch
            if (prCreateError.status === 422 && prCreateError.message?.includes('A pull request already exists')) {
                logger.info({
                    owner,
                    repoName,
                    branchName,
                    error: prCreateError.message
                }, 'PR already exists for this branch, attempting to find existing PR');
                
                // Try to find the existing PR
                try {
                    const existingPRs = await octokit.request('GET /repos/{owner}/{repo}/pulls', {
                        owner,
                        repo: repoName,
                        head: `${owner}:${branchName}`,
                        state: 'open'
                    });
                    
                    if (existingPRs.data.length > 0) {
                        const existingPR = existingPRs.data[0];
                        logger.info({
                            owner,
                            repoName,
                            branchName,
                            prNumber: existingPR.number,
                            prUrl: existingPR.html_url
                        }, 'Found existing PR for branch');
                        
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
                    logger.warn({
                        error: findError.message
                    }, 'Failed to find existing PR');
                }
            }
            
            // Handle "no history in common" and "no commits between" GraphQL errors with retry logic
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
                
                // Wait longer for GitHub's internal sync and retry once
                await new Promise(resolve => setTimeout(resolve, 10000)); // 10 second delay
                
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
                throw prCreateError; // Re-throw if we can't handle it
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

/**
 * Creates a Pull Request for the given branch and issue
 * @param {Object} options - PR creation options
 * @param {string} options.owner - Repository owner
 * @param {string} options.repoName - Repository name
 * @param {string} options.branchName - Head branch name
 * @param {string} options.baseBranch - Base branch name (optional, defaults to main)
 * @param {number} options.issueNumber - Original issue number
 * @param {string} options.issueTitle - Original issue title
 * @param {string} options.commitMessage - The commit message used
 * @param {Object} options.claudeResult - Claude execution result with logs
 * @returns {Promise<{number: number, url: string, title: string}>} PR details
 */
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

        // Generate PR title and body
        const prTitle = `AI Fix for Issue #${issueNumber}: ${issueTitle}`;
        const prBody = generatePRBody(issueNumber, issueTitle, commitMessage, claudeResult);

        logger.info({
            owner,
            repoName,
            branchName,
            baseBranch,
            issueNumber,
            prTitle
        }, 'Creating pull request...');

        // Create the pull request
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

/**
 * Adds Claude execution logs as a comment to the Pull Request
 * @param {Object} options - Comment options
 * @param {string} options.owner - Repository owner
 * @param {string} options.repoName - Repository name
 * @param {number} options.prNumber - Pull request number
 * @param {Object} options.claudeResult - Claude execution result with logs
 * @param {number} options.issueNumber - Original issue number
 * @returns {Promise<void>}
 */
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

        // Generate the comment content
        const commentBody = generateClaudeLogsComment(claudeResult, issueNumber);

        logger.info({
            owner,
            repoName,
            prNumber,
            issueNumber,
            commentLength: commentBody.length
        }, 'Adding Claude logs comment to PR...');

        // Add comment to the PR
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

/**
 * Updates GitHub issue labels atomically
 * @param {Object} options - Label update options
 * @param {string} options.owner - Repository owner
 * @param {string} options.repoName - Repository name
 * @param {number} options.issueNumber - Issue number
 * @param {string[]} options.labelsToRemove - Labels to remove
 * @param {string[]} options.labelsToAdd - Labels to add
 * @returns {Promise<string[]>} Updated labels list
 */
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

        // Get current issue labels
        const issueResponse = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
            owner,
            repo: repoName,
            issue_number: issueNumber
        });

        const currentLabels = issueResponse.data.labels.map(label => label.name);

        // Calculate new labels set
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

        // Update labels atomically
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

/**
 * Generates Pull Request body content
 * @param {number} issueNumber - Original issue number
 * @param {string} issueTitle - Original issue title
 * @param {string} commitMessage - The commit message used
 * @param {Object} claudeResult - Claude execution result
 * @returns {string} PR body markdown
 */
function generatePRBody(issueNumber, issueTitle, commitMessage, claudeResult) {
    const timestamp = new Date().toISOString();
    const isSuccess = claudeResult?.success || false;
    const executionTime = Math.round((claudeResult?.executionTime || 0) / 1000);

    let body = `## 🤖 AI-Generated Solution\n\n`;
    body += `Resolves #${issueNumber}.\n\n`;
    body += `This Pull Request was automatically generated by Claude Code to address the issue: **${issueTitle}**\n\n`;
    
    body += `### 📋 Execution Summary\n\n`;
    body += `- **Status**: ${isSuccess ? '✅ Success' : '❌ Failed'}\n`;
    body += `- **Execution Time**: ${executionTime}s\n`;
    body += `- **Generated**: ${timestamp}\n`;
    
    if (claudeResult?.finalResult) {
        const result = claudeResult.finalResult;
        body += `- **Claude Turns**: ${result.num_turns || 'unknown'}\n`;
        body += `- **Cost**: $${result.cost_usd || 'unknown'}\n`;
        body += `- **Session ID**: \`${claudeResult.sessionId || 'unknown'}\`\n`;
    }
    
    body += `\n### 💬 Implementation Details\n\n`;
    if (commitMessage) {
        body += `**Commit Message:**\n\`\`\`\n${commitMessage}\n\`\`\`\n\n`;
    }
    
    if (claudeResult?.summary) {
        body += `**Summary:**\n${claudeResult.summary}\n\n`;
    }
    
    body += `**Note:** Detailed conversation logs and execution details will be added as a comment below.\n\n`;
    body += `### ⚙️ Review Guidelines\n\n`;
    body += `- Review the changes carefully before merging\n`;
    body += `- Test the implementation in your development environment\n`;
    body += `- Check that the solution addresses the original issue requirements\n`;
    body += `- Verify that no unintended changes were introduced\n\n`;
    body += `---\n*This PR was generated automatically by Claude Code. Full execution logs are available in the comments.*`;

    return body;
}

/**
 * Generates Claude logs comment content
 * @param {Object} claudeResult - Claude execution result
 * @param {number} issueNumber - Original issue number
 * @returns {string} Comment body markdown
 */
function generateClaudeLogsComment(claudeResult, issueNumber) {
    let comment = `## 🔍 Claude Code Execution Logs\n\n`;
    comment += `**Issue**: #${issueNumber}\n`;
    comment += `**Session ID**: \`${claudeResult?.sessionId || 'unknown'}\`\n`;
    comment += `**Timestamp**: ${new Date().toISOString()}\n\n`;

    // Add execution details
    if (claudeResult?.finalResult) {
        const result = claudeResult.finalResult;
        comment += `### 📊 Execution Statistics\n\n`;
        comment += `- **Success**: ${claudeResult.success ? 'Yes' : 'No'}\n`;
        comment += `- **Total Turns**: ${result.num_turns || 'unknown'}\n`;
        comment += `- **Execution Time**: ${Math.round((claudeResult.executionTime || 0) / 1000)}s\n`;
        comment += `- **Cost**: $${result.cost_usd || 'unknown'}\n`;
        comment += `- **Exit Code**: ${claudeResult.exitCode || 'unknown'}\n\n`;

        if (result.subtype === 'error_max_turns') {
            comment += `⚠️ **Note**: Maximum turns reached (${result.num_turns}). Consider breaking down complex tasks.\n\n`;
        }
    }

    // Add conversation log
    if (claudeResult?.conversationLog && claudeResult.conversationLog.length > 0) {
        comment += `### 💬 Conversation Summary\n\n`;
        comment += `Total messages exchanged: ${claudeResult.conversationLog.length}\n\n`;

        // Show latest messages (limited for readability)
        const recentMessages = claudeResult.conversationLog.slice(-5);
        comment += `<details>\n<summary>🗨️ Recent Conversation (Last 5 messages)</summary>\n\n`;
        
        let conversationSnippet = '';
        recentMessages.forEach((msg) => {
            if (msg.type === 'user') {
                const content = msg.message?.content || '[content unavailable]';
                conversationSnippet += `**User**: ${content.substring(0, 300)}${content.length > 300 ? '...' : ''}\n\n`;
            } else if (msg.type === 'assistant') {
                const content = msg.message?.content?.[0]?.text || '[content unavailable]';
                conversationSnippet += `**Claude**: ${content.substring(0, 300)}${content.length > 300 ? '...' : ''}\n\n`;
            }
        });

        // Ensure the conversation snippet doesn't make the comment too long
        if (comment.length + conversationSnippet.length > MAX_COMMENT_LENGTH - 1000) {
            conversationSnippet = conversationSnippet.substring(0, MAX_COMMENT_LENGTH - comment.length - 1000);
            conversationSnippet += '\n\n[Truncated due to length limits]\n';
        }

        comment += conversationSnippet;
        comment += `\n</details>\n\n`;
    }

    // Add raw output summary
    if (claudeResult?.rawOutput) {
        const outputLength = claudeResult.rawOutput.length;
        comment += `### 📄 Raw Output\n\n`;
        comment += `- **Output Length**: ${outputLength.toLocaleString()} characters\n`;
        
        if (outputLength > 2000) {
            comment += `- **Preview** (first 2000 chars):\n\n`;
            comment += `\`\`\`\n${claudeResult.rawOutput.substring(0, 2000)}\n...\n[Output truncated]\n\`\`\`\n\n`;
        } else {
            comment += `- **Full Output**:\n\n`;
            comment += `\`\`\`\n${claudeResult.rawOutput}\n\`\`\`\n\n`;
        }
    }

    // Add modified files info
    if (claudeResult?.modifiedFiles && claudeResult.modifiedFiles.length > 0) {
        comment += `### 📝 Modified Files\n\n`;
        claudeResult.modifiedFiles.forEach(file => {
            comment += `- \`${file}\`\n`;
        });
        comment += '\n';
    }

    // Ensure comment doesn't exceed GitHub's limit
    if (comment.length > MAX_COMMENT_LENGTH) {
        const truncatePoint = MAX_COMMENT_LENGTH - 200;
        comment = comment.substring(0, truncatePoint);
        comment += '\n\n[Comment truncated due to GitHub length limits]\n';
        comment += `\nFull logs are available in the system logs.`;
    }

    comment += `---\n*Generated by Claude Code*`;

    return comment;
}

/**
 * Complete post-processing workflow for successful Claude execution
 * @param {Object} options - Post-processing options
 * @param {string} options.owner - Repository owner
 * @param {string} options.repoName - Repository name
 * @param {string} options.branchName - Branch name
 * @param {number} options.issueNumber - Issue number
 * @param {string} options.issueTitle - Issue title
 * @param {string} options.commitMessage - Commit message used
 * @param {Object} options.claudeResult - Claude execution result
 * @param {string[]} options.processingTags - Tags to remove (e.g., ['AI-processing'])
 * @param {string[]} options.completionTags - Tags to add (e.g., ['AI-done'])
 * @returns {Promise<{pr: Object, updatedLabels: string[]}>} Post-processing results
 */
export async function completePostProcessing(options) {
    const {
        owner,
        repoName,
        branchName,
        baseBranch,
        issueNumber,
        issueTitle,
        commitMessage,
        claudeResult,
        processingTags = ['AI-processing'],
        completionTags = ['AI-done'],
        worktreePath,
        repoUrl,
        authToken
    } = options;

    let prInfo = null;
    let updatedLabels = [];

    try {
        logger.info({
            owner,
            repoName,
            issueNumber,
            branchName
        }, 'Starting post-processing workflow...');

        // Step 1: Create Pull Request with robust git operations
        // First check if Claude already created a PR for this branch
        logger.info({
            owner,
            repoName,
            branchName
        }, 'Checking if PR already exists for branch...');
        
        try {
            const existingPRs = await getAuthenticatedOctokit().then(octokit => 
                octokit.request('GET /repos/{owner}/{repo}/pulls', {
                    owner,
                    repo: repoName,
                    head: `${owner}:${branchName}`,
                    state: 'open'
                })
            );
            
            if (existingPRs.data.length > 0) {
                const existingPR = existingPRs.data[0];
                logger.info({
                    owner,
                    repoName,
                    branchName,
                    prNumber: existingPR.number,
                    prUrl: existingPR.html_url
                }, 'Found existing PR created by Claude, using it instead of creating new one');
                
                prInfo = {
                    number: existingPR.number,
                    url: existingPR.html_url,
                    title: existingPR.title,
                    state: existingPR.state
                };
            } else {
                // No existing PR found, create one
                if (worktreePath && baseBranch && repoUrl && authToken) {
                    // Use robust PR creation with git operations
                    const prResult = await createPullRequestRobust({
                        owner,
                        repoName,
                        branchName,
                        baseBranch,
                        issueNumber,
                        prTitle: `AI Fix for Issue #${issueNumber}: ${issueTitle}`,
                        prBody: generatePRBody(issueNumber, issueTitle, commitMessage, claudeResult),
                        worktreePath,
                        repoUrl,
                        authToken
                    });
                    
                    // Handle case where PR creation was skipped due to no commits
                    if (prResult.skipPR) {
                        logger.info({
                            owner,
                            repoName,
                            branchName,
                            issueNumber,
                            reason: prResult.error
                        }, 'PR creation skipped - no commits found between branches');
                        
                        // No PR created, just continue with label updates
                        prInfo = null;
                    } else {
                        prInfo = prResult.pr;
                    }
                } else {
                    // Fallback to basic PR creation
                    prInfo = await createPullRequest({
                        owner,
                        repoName,
                        branchName,
                        issueNumber,
                        issueTitle,
                        commitMessage,
                        claudeResult
                    });
                }
            }
        } catch (checkError) {
            logger.warn({
                error: checkError.message
            }, 'Failed to check for existing PR, proceeding with creation');
            
            // Fallback to normal PR creation
            if (worktreePath && baseBranch && repoUrl && authToken) {
                const prResult = await createPullRequestRobust({
                    owner,
                    repoName,
                    branchName,
                    baseBranch,
                    issueNumber,
                    prTitle: `AI Fix for Issue #${issueNumber}: ${issueTitle}`,
                    prBody: generatePRBody(issueNumber, issueTitle, commitMessage, claudeResult),
                    worktreePath,
                    repoUrl,
                    authToken
                });
                
                // Handle case where PR creation was skipped due to no commits
                if (prResult.skipPR) {
                    logger.info({
                        owner,
                        repoName,
                        branchName,
                        issueNumber,
                        reason: prResult.error
                    }, 'PR creation skipped in fallback - no commits found between branches');
                    
                    prInfo = null;
                } else {
                    prInfo = prResult.pr;
                }
            } else {
                prInfo = await createPullRequest({
                    owner,
                    repoName,
                    branchName,
                    issueNumber,
                    issueTitle,
                    commitMessage,
                    claudeResult
                });
            }
        }

        // Step 2: Add Claude logs as PR comment
        await addClaudeLogsComment({
            owner,
            repoName,
            prNumber: prInfo.number,
            claudeResult,
            issueNumber
        });

        // Step 3: Update issue labels
        updatedLabels = await updateIssueLabels({
            owner,
            repoName,
            issueNumber,
            labelsToRemove: processingTags,
            labelsToAdd: completionTags
        });

        logger.info({
            owner,
            repoName,
            issueNumber,
            prNumber: prInfo.number,
            prUrl: prInfo.url
        }, 'Post-processing workflow completed successfully');

        return {
            pr: prInfo,
            updatedLabels
        };

    } catch (error) {
        // If post-processing fails, try to update labels to indicate failure
        try {
            await updateIssueLabels({
                owner,
                repoName,
                issueNumber,
                labelsToRemove: processingTags,
                labelsToAdd: ['AI-failed-post-processing']
            });
        } catch (labelError) {
            logger.warn({
                issueNumber,
                error: labelError.message
            }, 'Failed to update labels after post-processing failure');
        }

        handleError(error, `Post-processing failed for issue #${issueNumber}`);
        throw error;
    }
}