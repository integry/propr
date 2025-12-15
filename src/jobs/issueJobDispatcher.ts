import { Job } from 'bullmq';
import type { Logger } from 'pino';
import { logger } from '@gitfix/core';
import { generateCorrelationId } from '@gitfix/core';
import { getAuthenticatedOctokit } from '@gitfix/core';
import { withRetry, retryConfigs } from '@gitfix/core';
import { validateRepositoryInfo } from '@gitfix/core';
import type { RepoValidationResult } from '@gitfix/core';

type RepoValidation = RepoValidationResult;
import { issueQueue, type IssueJobData, type JobResult } from '@gitfix/core';
import { getDefaultModel, resolveLlmLabel } from '@gitfix/core';
import { AgentRegistry } from '@gitfix/core';

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

interface AgentModelToProcess {
    agentAlias: string;
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
        const labels = currentIssueData.data.labels.map(l => l.name);

        const baseLabels = labels.filter(l => l.startsWith('base-'));
        const llmLabels = labels.filter(l => l.startsWith('llm-'));

        const basesToProcess: BaseToProcess[] = baseLabels.length > 0
            ? baseLabels.map(l => ({ branch: l.substring('base-'.length), label: l }))
            : [{ branch: defaultBranch, label: null }];

        // Resolve LLM labels to agent + model pairs
        const agentModelsToProcess: AgentModelToProcess[] = [];
        if (llmLabels.length > 0) {
            for (const label of llmLabels) {
                const llmPart = label.substring('llm-'.length);
                const resolution = await resolveLlmLabel(llmPart);
                agentModelsToProcess.push({
                    agentAlias: resolution.agentAlias,
                    model: resolution.model,
                    label
                });
                correlatedLogger.debug({
                    label,
                    resolvedAgent: resolution.agentAlias,
                    resolvedModel: resolution.model
                }, 'Resolved LLM label');
            }
        } else {
            // No LLM labels - use default agent
            const registry = AgentRegistry.getInstance();
            await registry.ensureInitialized();
            const defaultAgent = registry.getDefaultAgent();
            agentModelsToProcess.push({
                agentAlias: defaultAgent?.config.alias || 'default',
                model: defaultAgent?.config.defaultModel || DEFAULT_MODEL_NAME,
                label: null
            });
        }

        let jobsEnqueued = 0;
        for (const base of basesToProcess) {
            for (const agentModel of agentModelsToProcess) {
                const newJobData: IssueJobData = {
                    ...issueRef,
                    baseBranch: base.branch,
                    baseLabel: base.label,
                    agentAlias: agentModel.agentAlias,
                    modelName: agentModel.model,
                    modelLabel: agentModel.label,
                    isChildJob: true,
                    issuePayload: currentIssueData.data as unknown as Record<string, unknown>,
                    repoPayload: repoValidation.repoData as unknown as Record<string, unknown>
                };

                await issueQueue.add(jobName, newJobData);
                jobsEnqueued++;
                correlatedLogger.info({
                    jobId,
                    issue: issueRef.number,
                    base: base.branch,
                    agent: agentModel.agentAlias,
                    model: agentModel.model
                }, 'Enqueued child job');
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
