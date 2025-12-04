import logger, { generateCorrelationId } from '../utils/logger.js';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import { withRetry, retryConfigs } from '../utils/retryHandler.js';
import { validateRepositoryInfo } from '../utils/prValidation.js';
import { issueQueue } from '../queue/taskQueue.js';
import { getDefaultModel, resolveModelAlias } from '../config/modelAliases.js';

const DEFAULT_MODEL_NAME = process.env.DEFAULT_CLAUDE_MODEL || getDefaultModel();

export async function handleDispatch(job) {
    const { id: jobId, name: jobName, data: issueRef } = job;
    const correlationId = issueRef.correlationId || generateCorrelationId();
    const correlatedLogger = logger.withCorrelation(correlationId);
    correlatedLogger.info({ jobId, issueRef: issueRef.number }, 'Running as matrix dispatcher...');

    let octokit;
    let currentIssueData;
    let repoValidation;

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
        );

        repoValidation = await validateRepositoryInfo(issueRef, octokit, correlationId);
        if (!repoValidation.isValid) {
            throw new Error('Repository validation failed for dispatcher.');
        }

        const defaultBranch = repoValidation.repoData.defaultBranch;
        const defaultModel = DEFAULT_MODEL_NAME;
        const labels = currentIssueData.data.labels.map(l => l.name);

        const baseLabels = labels.filter(l => l.startsWith('base-'));
        const llmLabels = labels.filter(l => l.startsWith('llm-'));

        const basesToProcess = baseLabels.length > 0
            ? baseLabels.map(l => ({ branch: l.substring('base-'.length), label: l }))
            : [{ branch: defaultBranch, label: null }];

        const modelsToProcess = llmLabels.length > 0
            ? llmLabels.map(l => ({
                model: resolveModelAlias(l.substring('llm-'.length)),
                label: l
              }))
            : [{ model: defaultModel, label: null }];

        let jobsEnqueued = 0;
        for (const base of basesToProcess) {
            for (const model of modelsToProcess) {
                const newJobData = {
                    ...issueRef,
                    baseBranch: base.branch,
                    baseLabel: base.label,
                    modelName: model.model,
                    modelLabel: model.label,
                    isChildJob: true,
                    issuePayload: currentIssueData.data,
                    repoPayload: repoValidation.repoData
                };

                await issueQueue.add(jobName, newJobData);
                jobsEnqueued++;
                correlatedLogger.info({ jobId, issue: issueRef.number, base: base.branch, model: model.model }, 'Enqueued child job');
            }
        }

        correlatedLogger.info({ jobId, issue: issueRef.number, jobsEnqueued }, 'Matrix dispatcher job complete.');

    } catch (error) {
        correlatedLogger.error({ 
            jobId, 
            issue: issueRef.number,
            errMessage: error.message, 
            stack: error.stack
        }, 'Error in matrix dispatcher, job will fail and not dispatch children');
        throw error;
    }
}
