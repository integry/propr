import logger, { generateCorrelationId } from '../utils/logger.js';
import { handleError } from '../utils/errorHandler.js';
import { withRetry, retryConfigs } from '../utils/retryHandler.js';
import { issueQueue } from '../queue/taskQueue.js';
import { getPrimaryProcessingLabels, loadPrimaryProcessingLabelsFromConfig } from './configLoader.js';

export async function processDetectedIssue(issue, correlationId, redisClient) {
    const correlatedLogger = logger.withCorrelation(correlationId);
    const repoFullName = `${issue.repoOwner}/${issue.repoName}`;

    let primaryProcessingLabels = getPrimaryProcessingLabels();
    if (primaryProcessingLabels.length === 0) {
        await loadPrimaryProcessingLabelsFromConfig();
        primaryProcessingLabels = getPrimaryProcessingLabels();
    }

    const allExcludeLabels = [];
    for (const label of primaryProcessingLabels) {
        allExcludeLabels.push(`${label}-processing`);
        allExcludeLabels.push(`${label}-done`);
    }

    if (allExcludeLabels.some(excludeLabel => issue.labels.includes(excludeLabel))) {
        correlatedLogger.debug({ issueNumber: issue.number, repository: repoFullName }, 'Issue has exclude labels, skipping');
        return;
    }

    const triggeringLabel = primaryProcessingLabels.find(pl => issue.labels.includes(pl));

    if (!triggeringLabel) {
        correlatedLogger.info({
            issueNumber: issue.number,
            repository: repoFullName,
            issueLabels: issue.labels,
            expectedLabels: primaryProcessingLabels
        }, 'Issue does not have any primary processing label, skipping');
        return;
    }

    correlatedLogger.info({
        issueId: issue.id,
        issueNumber: issue.number,
        issueTitle: issue.title,
        issueUrl: issue.url,
        repository: repoFullName,
        labels: issue.labels,
        triggeringLabel: triggeringLabel
    }, 'Detected eligible issue');

    const activeJobs = await issueQueue.getActive();
    const waitingJobs = await issueQueue.getWaiting();
    const existingJobs = [...activeJobs, ...waitingJobs];

    const jobExists = existingJobs.some(job =>
        job.name === 'processGitHubIssue' &&
        job.data.number === issue.number &&
        job.data.repoOwner === issue.repoOwner &&
        job.data.repoName === issue.repoName &&
        !job.data.isChildJob
    );

    if (jobExists) {
        correlatedLogger.debug({ issueNumber: issue.number, repository: repoFullName }, 'A parent job for this issue is already active or waiting, skipping duplicate');
        return;
    }

    correlatedLogger.info({
        issueId: issue.id,
        issueNumber: issue.number,
        repository: repoFullName,
        triggeringLabel: triggeringLabel
    }, 'Enqueueing parent job for matrix dispatch');

    try {
        const timestamp = Date.now();
        const jobId = `issue-${issue.repoOwner}-${issue.repoName}-${issue.number}-${timestamp}`;
        const issueJob = {
            repoOwner: issue.repoOwner,
            repoName: issue.repoName,
            number: issue.number,
            triggeringLabel: triggeringLabel,
            correlationId: generateCorrelationId()
        };

        const addToQueueWithRetry = () => withRetry(
            () => issueQueue.add('processGitHubIssue', issueJob, {
                jobId,
                attempts: 3,
                backoff: { type: 'exponential', delay: 2000 },
            }),
            { ...retryConfigs.redis, correlationId },
            `add_issue_to_queue_${issue.number}`
        );

        await addToQueueWithRetry();

        try {
            const activity = {
                id: `activity-${timestamp}-${issue.id}`,
                type: 'issue_created',
                timestamp: new Date().toISOString(),
                repository: repoFullName,
                issueNumber: issue.number,
                description: `New issue #${issue.number} detected for matrix processing`,
                status: 'info'
            };
            await redisClient.lpush('system:activity:log', JSON.stringify(activity));
            await redisClient.ltrim('system:activity:log', 0, 999);
        } catch (activityError) {
            correlatedLogger.warn({ error: activityError.message }, 'Failed to log activity');
        }

        correlatedLogger.info({
            jobId,
            issueNumber: issue.number,
            repository: repoFullName,
            issueCorrelationId: issueJob.correlationId
        }, 'Successfully added parent job to processing queue');

    } catch (error) {
        handleError(error, `Failed to add issue ${issue.number} to queue`, { correlationId });
    }
}

export async function fetchIssuesForRepo(octokit, repoFullName, correlationId) {
    const correlatedLogger = logger.withCorrelation(correlationId);
    const [owner, repo] = repoFullName.split('/');

    if (!owner || !repo) {
        correlatedLogger.warn({ repo: repoFullName }, 'Invalid repository format. Skipping.');
        return [];
    }

    const primaryProcessingLabels = getPrimaryProcessingLabels();
    const allExcludeLabels = [];
    for (const label of primaryProcessingLabels) {
        allExcludeLabels.push(`${label}-processing`);
        allExcludeLabels.push(`${label}-done`);
    }

    const fetchWithRetry = () => withRetry(
        async () => {
            const allIssues = [];

            for (const primaryLabel of primaryProcessingLabels) {
                const issues = await octokit.paginate('GET /repos/{owner}/{repo}/issues', {
                    owner,
                    repo,
                    state: 'open',
                    labels: primaryLabel,
                    per_page: 100,
                    sort: 'created',
                    direction: 'desc'
                });

                for (const issue of issues) {
                    if (!allIssues.find(i => i.id === issue.id)) {
                        allIssues.push(issue);
                    }
                }
            }

            const filteredIssues = allIssues.filter(issue => {
                if (issue.pull_request) return false;

                const labelNames = issue.labels.map(label =>
                    typeof label === 'string' ? label : label.name
                );

                return !allExcludeLabels.some(excludeLabel => labelNames.includes(excludeLabel));
            });

            const pullRequestCount = allIssues.filter(issue => issue.pull_request).length;

            correlatedLogger.debug({
                repo: repoFullName,
                totalIssues: allIssues.length,
                pullRequests: pullRequestCount,
                filteredIssues: filteredIssues.length,
                excludedLabels: allExcludeLabels
            }, 'Filtered issues (excluding PRs and labels)');

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

        return response.data.items.map(issue => ({
            id: issue.id,
            number: issue.number,
            title: issue.title,
            url: issue.html_url,
            repoOwner: owner,
            repoName: repo,
            labels: issue.labels.map(l => l.name),
            createdAt: issue.created_at,
            updatedAt: issue.updated_at
        }));
    } catch (error) {
        handleError(error, `fetch_issues_${repoFullName}`, { correlationId });

        if (error.status === 403 && error.message && error.message.includes('rate limit')) {
            correlatedLogger.warn('GitHub API rate limit likely exceeded. Consider increasing polling interval.');
        }

        return [];
    }
}
