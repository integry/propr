import { logger } from '@propr/core';
import { generateCorrelationId } from '@propr/core';
import type { Logger } from 'pino';
import { handleError } from '@propr/core';
import { withRetry, retryConfigs } from '@propr/core';
import { getDefaultModel, resolveLlmLabel } from '@propr/core';
import { issueQueue, type IssueJobData } from '@propr/core';
import { Redis } from 'ioredis';

const AI_PRIMARY_TAG = process.env.AI_PRIMARY_TAG || 'AI';
const AI_EXCLUDE_TAGS_PROCESSING = process.env.AI_EXCLUDE_TAGS_PROCESSING || 'AI-processing';
const AI_DONE_TAG = process.env.AI_DONE_TAG || 'AI-done';
const MODEL_LABEL_PATTERN = process.env.MODEL_LABEL_PATTERN || '^llm-(.+)$';
const DEFAULT_MODEL_NAME = process.env.DEFAULT_CLAUDE_MODEL || getDefaultModel();

const redisClient = new Redis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
});

interface GitHubLabel {
    name: string;
}

interface GitHubIssue {
    id: number;
    number: number;
    title: string;
    html_url: string;
    labels: GitHubLabel[];
    created_at: string;
    updated_at: string;
}

export interface TargetConfig {
    agent: string;
    model: string;
}

export interface DetectedIssue {
    id: number;
    number: number;
    title: string;
    url: string;
    repoOwner: string;
    repoName: string;
    labels: string[];
    targetConfigs: TargetConfig[];
    createdAt: string;
    updatedAt: string;
}

interface ActivityLog {
    id: string;
    type: string;
    timestamp: string;
    repository: string;
    issueNumber: number;
    description: string;
    status: 'info' | 'success' | 'error';
}

interface EnqueueOptions {
    correlationId: string;
    correlatedLogger: Logger;
    modelName: string;
    agentAlias: string;
}

type Octokit = {
    paginate: <T>(endpoint: string, options: Record<string, unknown>) => Promise<T[]>;
};

export async function fetchIssuesForRepo(
    octokit: Octokit,
    repoFullName: string,
    correlationId: string
): Promise<DetectedIssue[]> {
    const correlatedLogger = logger.withCorrelation(correlationId);
    const [owner, repo] = repoFullName.split('/');

    if (!owner || !repo) {
        correlatedLogger.warn({ repo: repoFullName }, 'Invalid repository format. Skipping.');
        return [];
    }

    const fetchWithRetry = () => withRetry(
        async () => {
            const issues = await octokit.paginate<GitHubIssue>('GET /repos/{owner}/{repo}/issues', {
                owner,
                repo,
                state: 'open',
                labels: AI_PRIMARY_TAG,
                per_page: 100,
                sort: 'created',
                direction: 'desc'
            });

            const filteredIssues = issues.filter(issue => {
                const labelNames = issue.labels.map(label =>
                    typeof label === 'string' ? label : label.name
                );
                return !labelNames.includes(AI_EXCLUDE_TAGS_PROCESSING) &&
                       !labelNames.includes(AI_DONE_TAG);
            });

            correlatedLogger.debug({
                repo: repoFullName,
                totalIssues: issues.length,
                filteredIssues: filteredIssues.length,
                excludedLabels: [AI_EXCLUDE_TAGS_PROCESSING, AI_DONE_TAG]
            }, 'Filtered issues by labels');

            return { data: { items: filteredIssues } };
        },
        { ...retryConfigs.githubApi, correlationId },
        `fetch_issues_${repoFullName}`
    );

    try {
        const response = await fetchWithRetry();

        correlatedLogger.info({
            repo: repoFullName,
            count: response.data.items.length
        }, `Found ${response.data.items.length} matching issues.`);

        // Process issues with async resolution of LLM labels
        const issues = await Promise.all(response.data.items.map(async (issue) => {
            const identifiedConfigs: TargetConfig[] = [];
            const modelLabelRegex = new RegExp(MODEL_LABEL_PATTERN);

            for (const label of issue.labels) {
                const match = label.name.match(modelLabelRegex);
                if (match && match[1]) {
                    // Resolve both agent and model from the label suffix
                    const resolution = await resolveLlmLabel(match[1]);
                    identifiedConfigs.push({
                        agent: resolution.agentAlias,
                        model: resolution.model
                    });
                }
            }

            // If no LLM labels found, use default config
            let targetConfigs = identifiedConfigs;
            if (identifiedConfigs.length === 0) {
                const defaultResolution = await resolveLlmLabel(DEFAULT_MODEL_NAME);
                targetConfigs = [{
                    agent: defaultResolution.agentAlias,
                    model: defaultResolution.model
                }];
            }

            return {
                id: issue.id,
                number: issue.number,
                title: issue.title,
                url: issue.html_url,
                repoOwner: owner,
                repoName: repo,
                labels: issue.labels.map(l => l.name),
                targetConfigs,
                createdAt: issue.created_at,
                updatedAt: issue.updated_at
            };
        }));

        return issues;
    } catch (error) {
        handleError(error, `fetch_issues_${repoFullName}`, { correlationId });

        const err = error as { status?: number; message?: string };
        if (err.status === 403 && err.message?.includes('rate limit')) {
            correlatedLogger.warn('GitHub API rate limit likely exceeded. Consider increasing polling interval.');
        }

        return [];
    }
}

async function enqueueIssueForModel(
    issue: DetectedIssue,
    repoFullName: string,
    options: EnqueueOptions
): Promise<void> {
    const { correlationId, correlatedLogger, modelName, agentAlias } = options;
    const jobId = `issue-${issue.repoOwner}-${issue.repoName}-${issue.number}-${agentAlias}-${modelName}`;
    const issueJob: IssueJobData = {
        repoOwner: issue.repoOwner,
        repoName: issue.repoName,
        number: issue.number,
        agentAlias: agentAlias,
        modelName: modelName,
        correlationId: generateCorrelationId()
    };

    const addToQueueWithRetry = () => withRetry(
        () => issueQueue.add('processGitHubIssue', issueJob, {
            jobId,
            attempts: 3,
            backoff: { type: 'exponential', delay: 2000 },
        }),
        { ...retryConfigs.redis, correlationId },
        `add_issue_to_queue_${issue.number}_${modelName}`
    );

    await addToQueueWithRetry();

    try {
        const activity: ActivityLog = {
            id: `activity-${Date.now()}-${issue.id}-${modelName}`,
            type: 'issue_created',
            timestamp: new Date().toISOString(),
            repository: repoFullName,
            issueNumber: issue.number,
            description: `New issue #${issue.number} detected for processing with ${modelName}`,
            status: 'info'
        };
        await redisClient.lpush('system:activity:log', JSON.stringify(activity));
        await redisClient.ltrim('system:activity:log', 0, 999);
    } catch (activityError) {
        correlatedLogger.warn({ error: (activityError as Error).message }, 'Failed to log activity');
    }

    correlatedLogger.info({ jobId, issueNumber: issue.number, repository: repoFullName, modelName, issueCorrelationId: issueJob.correlationId }, 'Successfully added issue-model job to processing queue');
}

async function processIssue(
    issue: DetectedIssue,
    repoFullName: string,
    correlationId: string,
    correlatedLogger: Logger
): Promise<void> {
    correlatedLogger.info({
        issueId: issue.id, issueNumber: issue.number, issueTitle: issue.title,
        issueUrl: issue.url, repository: repoFullName, targetConfigs: issue.targetConfigs
    }, 'Detected eligible issue');

    for (const config of issue.targetConfigs) {
        correlatedLogger.info({ issueId: issue.id, issueNumber: issue.number, repository: repoFullName, agent: config.agent, model: config.model }, `Enqueueing job for agent: ${config.agent}, model: ${config.model}`);
        try {
            await enqueueIssueForModel(issue, repoFullName, {
                correlationId,
                correlatedLogger,
                modelName: config.model,
                agentAlias: config.agent
            });
        } catch (error) {
            handleError(error, `Failed to add issue ${issue.number} with agent ${config.agent} model ${config.model} to queue`, { correlationId });
        }
    }
}

export async function pollForIssues(
    octokit: Octokit,
    repos: string[]
): Promise<DetectedIssue[]> {
    const correlationId = generateCorrelationId();
    const correlatedLogger = logger.withCorrelation(correlationId);

    correlatedLogger.info('Starting GitHub issue polling cycle...');

    const allDetectedIssues: DetectedIssue[] = [];

    for (const repoFullName of repos) {
        correlatedLogger.debug({ repository: repoFullName }, 'Polling repository');

        try {
            const issues = await fetchIssuesForRepo(octokit, repoFullName, correlationId);

            for (const issue of issues) {
                await processIssue(issue, repoFullName, correlationId, correlatedLogger);
                allDetectedIssues.push(issue);
            }

        } catch (error) {
            handleError(error, `Error polling repository ${repoFullName}`, { correlationId });
        }
    }

    correlatedLogger.info({
        totalIssues: allDetectedIssues.length,
        repositories: repos.length
    }, 'Polling cycle completed');

    return allDetectedIssues;
}

export async function shutdownPolling(): Promise<void> {
    try {
        await redisClient.quit();
    } catch (error) {
        logger.error({ error: (error as Error).message }, 'Failed to shutdown polling Redis client');
    }
}
