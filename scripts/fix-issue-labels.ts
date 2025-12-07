#!/usr/bin/env tsx

import { getAuthenticatedOctokit } from '@gitfix/core';
import { logger } from '@gitfix/core';

const AI_PROCESSING_TAG = process.env.AI_PROCESSING_TAG || 'AI-processing';
const AI_DONE_TAG = process.env.AI_DONE_TAG || 'AI-done';

interface PullRequest {
    number: number;
    title: string;
    html_url: string;
    body?: string | null;
    head: {
        ref: string;
    };
}

async function fixIssueLabels(owner: string, repo: string, issueNumber: number): Promise<void> {
    try {
        const octokit = await getAuthenticatedOctokit();
        
        logger.info({ owner, repo, issueNumber }, 'Fixing issue labels...');
        
        try {
            await octokit.request('DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}', {
                owner,
                repo,
                issue_number: issueNumber,
                name: AI_PROCESSING_TAG,
            });
            logger.info({ issueNumber, tag: AI_PROCESSING_TAG }, 'Removed processing tag');
        } catch (removeError) {
            const err = removeError as Error;
            logger.warn({ error: err.message }, 'Failed to remove processing tag (might not exist)');
        }
        
        await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
            owner,
            repo,
            issue_number: issueNumber,
            labels: [AI_DONE_TAG],
        });
        logger.info({ issueNumber, tag: AI_DONE_TAG }, 'Added done tag');
        
        const prs = await octokit.request('GET /repos/{owner}/{repo}/pulls', {
            owner,
            repo,
            state: 'open',
            per_page: 20
        });
        
        const relatedPR = (prs.data as PullRequest[]).find(pr => 
            pr.title.includes(`#${issueNumber}`) || 
            pr.body?.includes(`#${issueNumber}`) ||
            pr.head.ref.includes(issueNumber.toString())
        );
        
        if (relatedPR) {
            logger.info({
                issueNumber,
                prNumber: relatedPR.number,
                prUrl: relatedPR.html_url,
                prTitle: relatedPR.title
            }, 'Found related PR');
            
            await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                owner,
                repo,
                issue_number: issueNumber,
                body: `🤖 **Issue Processing Completed**

A pull request has been created to address this issue: #${relatedPR.number}

**PR Details:**
- **Title**: ${relatedPR.title}
- **URL**: ${relatedPR.html_url}
- **Branch**: \`${relatedPR.head.ref}\`

Please review the changes and merge when ready.

---
*Labels updated manually after successful processing*`
            });
            
            logger.info({ issueNumber, prNumber: relatedPR.number }, 'Added comment linking to PR');
        } else {
            logger.warn({ issueNumber }, 'No related PR found');
        }
        
        logger.info({ owner, repo, issueNumber }, 'Issue labels fixed successfully');
        
    } catch (error) {
        const err = error as Error;
        logger.error({ 
            owner, 
            repo, 
            issueNumber, 
            error: err.message 
        }, 'Failed to fix issue labels');
        throw error;
    }
}

const [owner, repo, issueNumber] = process.argv.slice(2);

if (!owner || !repo || !issueNumber) {
    console.error('Usage: tsx scripts/fix-issue-labels.ts <owner> <repo> <issueNumber>');
    console.error('Example: tsx scripts/fix-issue-labels.ts integry forex 346');
    process.exit(1);
}

fixIssueLabels(owner, repo, parseInt(issueNumber, 10))
    .then(() => {
        console.log('Issue labels fixed successfully');
        process.exit(0);
    })
    .catch((error: Error) => {
        console.error('Failed to fix issue labels:', error.message);
        process.exit(1);
    });
