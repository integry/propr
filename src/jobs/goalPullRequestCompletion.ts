import {
    appendVisualPreviewSection,
    formatSubscriptionUsage,
    getAuthenticatedOctokit,
    getDetailedUsageStats,
    getModelName,
    logger,
    redactSecrets,
    sanitizeAgentReport,
    retryConfigs,
    VISUAL_PREVIEW_DIRECTORY,
    VISUAL_PREVIEW_MARKER,
    withRetry,
    type AgentExecutionResult,
} from '@propr/core';

interface CompletedGoal {
    goal_id: string;
    repository: string;
    objective: string;
    branch_name: string | null;
}

interface GoalPullRequestCompletionDependencies {
    getOctokit(): Promise<Awaited<ReturnType<typeof getAuthenticatedOctokit>>>;
    retry<T>(operation: () => Promise<T>, operationName: string): Promise<T>;
}

const defaultDependencies: GoalPullRequestCompletionDependencies = {
    getOctokit: getAuthenticatedOctokit,
    retry: async (operation, operationName) => await withRetry(
        operation,
        retryConfigs.githubApi,
        operationName,
    ),
};

function formatDuration(milliseconds: number): string {
    const seconds = Math.max(0, Math.floor(milliseconds / 1000));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainder = seconds % 60;
    if (hours > 0) return `${hours}h ${minutes}m ${remainder}s`;
    if (minutes > 0) return `${minutes}m ${remainder}s`;
    return `${remainder}s`;
}

function cleanSummary(summary: string | undefined): string {
    if (!summary?.trim()) return 'The goal agent completed the requested implementation.';
    return sanitizeAgentReport(redactSecrets(summary))
        .split('\n')
        .filter(line => !line.replaceAll('\\', '/').includes(`${VISUAL_PREVIEW_DIRECTORY}/`))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .slice(0, 6000)
        || 'The goal agent completed the requested implementation.';
}

function buildChangedFilesSection(files: string[]): string {
    const uniqueFiles = [...new Set(files.map(file => file.trim()).filter(Boolean))];
    if (uniqueFiles.length === 0) return '';
    const displayed = uniqueFiles.slice(0, 20).map(file => `- \`${file.replaceAll('`', '\\`')}\``);
    if (uniqueFiles.length > displayed.length) displayed.push(`- …and ${uniqueFiles.length - displayed.length} more`);
    return `\n\n## Files Changed\n\n${displayed.join('\n')}`;
}

function buildImplementationDetails(result: AgentExecutionResult): string {
    const model = result.providerModel || result.modelUsed;
    const stats = getDetailedUsageStats({
        tokenUsage: result.tokenUsage,
        conversationLog: result.conversationLog,
    });
    const lines = [
        `* **Model:** ${getModelName(model)}${result.reasoningLevel ? ` (${result.reasoningLevel})` : ''}`,
        `* **Time:** ${formatDuration(result.executionTimeMs)}`,
    ];
    if (stats.totalTokens > 0) {
        lines.push(`* **Tokens:** ${stats.totalTokens.toLocaleString()} (${stats.totalInputWithCache.toLocaleString()} in / ${stats.outputTokens.toLocaleString()} out)`);
    }
    if (result.cost != null && result.cost > 0) lines.push(`* **Cost:** $${result.cost.toFixed(2)}`);
    const subscriptionUsage = formatSubscriptionUsage(result.usageMetrics);
    if (subscriptionUsage) lines.push(`* **Subscription usage:** ${subscriptionUsage}`);
    if (result.modifiedFiles.length > 0) {
        lines.push(`* **Files changed:** ${new Set(result.modifiedFiles).size.toLocaleString()}`);
    }
    return lines.join('\n');
}

export function buildCompletedGoalPullRequestBody(
    goal: CompletedGoal,
    result: AgentExecutionResult,
): string {
    const metadata = [
        `**Goal:** ${redactSecrets(goal.objective)}`,
        goal.branch_name ? `**Branch:** \`${goal.branch_name.replaceAll('`', '\\`')}\`` : '',
        `**Goal ID:** \`${goal.goal_id}\``,
    ].filter(Boolean).join('\n');
    return [
        '## Goal Implementation Summary',
        '',
        '✅ **Goal completed successfully.**',
        '',
        metadata,
        '',
        '## Summary of Changes',
        '',
        `${cleanSummary(result.summary)}${buildChangedFilesSection(result.modifiedFiles)}`,
        '',
        '---',
        '',
        '### 🤖 Implementation Details',
        '',
        buildImplementationDetails(result),
        '',
        '---',
        '',
        '### 💡 Need changes?',
        '',
        'Comment on this PR to request refinements — the AI agent monitors comments and will update the implementation based on your feedback.',
        '',
        '---',
        '*This PR description was updated automatically by [ProPR](https://propr.dev) after the goal completed.*',
    ].join('\n');
}

function visualPreviewSection(body: string): string {
    const markerIndex = body.lastIndexOf(VISUAL_PREVIEW_MARKER);
    return markerIndex < 0 ? '' : body.slice(markerIndex).trim();
}

/** Update the completed goal PR without allowing GitHub post-processing to invalidate successful goal work. */
export async function updateCompletedGoalPullRequest(
    goal: CompletedGoal,
    pullRequestNumber: number,
    result: AgentExecutionResult,
    dependencies: GoalPullRequestCompletionDependencies = defaultDependencies,
): Promise<void> {
    const [owner, repo] = goal.repository.split('/');
    try {
        const octokit = await dependencies.getOctokit();
        const current = await dependencies.retry(
            () => octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
                owner, repo, pull_number: pullRequestNumber,
            }) as Promise<{ data: { body?: string | null } }>,
            `get_completed_goal_pr_${pullRequestNumber}`,
        );
        const body = appendVisualPreviewSection(
            buildCompletedGoalPullRequestBody(goal, result),
            visualPreviewSection(current.data.body || ''),
        );
        await dependencies.retry(
            () => octokit.request('PATCH /repos/{owner}/{repo}/pulls/{pull_number}', {
                owner, repo, pull_number: pullRequestNumber, body,
            }),
            `update_completed_goal_pr_${pullRequestNumber}`,
        );
        logger.info({ repository: goal.repository, prNumber: pullRequestNumber }, 'Updated completed goal PR description');
    } catch (error) {
        logger.warn({
            repository: goal.repository,
            prNumber: pullRequestNumber,
            error: (error as Error).message,
        }, 'Failed to update completed goal PR description after retries');
    }
}
