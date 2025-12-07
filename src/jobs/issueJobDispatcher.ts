import { Job } from 'bullmq';
import type { Logger } from 'pino';
import logger, { generateCorrelationId } from '../utils/logger.js';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import { withRetry, retryConfigs } from '../utils/retryHandler.js';
import { validateRepositoryInfo } from '../utils/prValidation.js';
import type { RepoValidationResult } from '../utils/prValidation.js';

type RepoValidation = RepoValidationResult;
import { issueQueue, type IssueJobData, type JobResult } from '../queue/taskQueue.js';
import { getDefaultModel, resolveModelAlias } from '../config/modelAliases.js';

const DEFAULT_MODEL_NAME = process.env.DEFAULT_CLAUDE_MODEL || getDefaultModel();

interface CurrentIssueData {
    data: {
        labels: Array<{ name: string }>;
    };
}

interface BaseToProcess {
    branch: string;
    label: string | null;
}

interface ModelToProcess {
    model: string;
    label: string | null;
}

export async function handleDispatch(job: Job<IssueJobData>): Promise<JobResult> {
    const { id: jobId, name: jobName, data: issueRef } = job;
    const correlationId = issueRef.correlationId || generateCorrelationId();
    const correlatedLogger: Logger = logger.withCorrelation(correlationId);
    correlatedLogger.info({ jobId, issueRef: issueRef.number }, 'Running as matrix dispatcher...');

    let octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>;
    let currentIssueData: CurrentIssueData;
    let repoValidation: RepoValidation;

    try {
        octokit = await withRetry(
            () => getAuthenticatedOctokit(),
            { ...retryConfigs.githubApi, correlationId },
            'get_authenticated_octokit_dispatcher'
        );

        currentIssueData = await withRetry(
            () => octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
                owner: issueRef.repoOwner,
                repo: issueRef.repoName,
                issue_number: issueRef.number,
            }),
            { ...retryConfigs.githubApi, correlationId },
            `get_issue_${issueRef.number}_dispatcher`
        ) as CurrentIssueData;

        repoValidation = await validateRepositoryInfo({ repoOwner: issueRef.repoOwner, repoName: issueRef.repoName, number: issueRef.number }, octokit, correlationId);
        if (!repoValidation.isValid) {
            throw new Error('Repository validation failed for dispatcher.');
        }

        const defaultBranch = repoValidation.repoData?.defaultBranch || 'main';
        const defaultModel = DEFAULT_MODEL_NAME;
        const labels = currentIssueData.data.labels.map(l => l.name);

        const baseLabels = labels.filter(l => l.startsWith('base-'));
        const llmLabels = labels.filter(l => l.startsWith('llm-'));

        const basesToProcess: BaseToProcess[] = baseLabels.length > 0
            ? baseLabels.map(l => ({ branch: l.substring('base-'.length), label: l }))
            : [{ branch: defaultBranch, label: null }];

        const modelsToProcess: ModelToProcess[] = llmLabels.length > 0
            ? llmLabels.map(l => ({
                model: resolveModelAlias(l.substring('llm-'.length)),
                label: l
              }))
            : [{ model: defaultModel, label: null }];

        let jobsEnqueued = 0;
        for (const base of basesToProcess) {
            for (const model of modelsToProcess) {
                const newJobData: IssueJobData = {
                    ...issueRef,
                    baseBranch: base.branch,
                    baseLabel: base.label,
                    modelName: model.model,
                    modelLabel: model.label,
                    isChildJob: true,
                    issuePayload: currentIssueData.data as unknown as Record<string, unknown>,
                    repoPayload: repoValidation.repoData as unknown as Record<string, unknown>
                };

                await issueQueue.add(jobName, newJobData);
                jobsEnqueued++;
                correlatedLogger.info({ jobId, issue: issueRef.number, base: base.branch, model: model.model }, 'Enqueued child job');
            }
        }

        correlatedLogger.info({ jobId, issue: issueRef.number, jobsEnqueued }, 'Matrix dispatcher job complete.');
        return { status: 'dispatched', jobsEnqueued, issueNumber: issueRef.number };

    } catch (error) {
        correlatedLogger.error({
            jobId,
            issue: issueRef.number,
            errMessage: (error as Error).message,
            stack: (error as Error).stack
        }, 'Error in matrix dispatcher, job will fail and not dispatch children');
        throw error;
    }
}
