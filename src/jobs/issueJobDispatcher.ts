import { Job } from 'bullmq';
import type { Logger } from 'pino';
import { logger } from '@propr/core';
import { generateCorrelationId } from '@propr/core';
import { getAuthenticatedOctokit } from '@propr/core';
import { withRetry, retryConfigs } from '@propr/core';
import { validateRepositoryInfo } from '@propr/core';
import type { RepoValidationResult } from '@propr/core';

type RepoValidation = RepoValidationResult;
import { issueQueue, type IssueJobData, type JobResult } from '@propr/core';
import { getDefaultModel, resolveLlmLabel, loadSettings, resolveCustomLabel, getAllCustomLabels } from '@propr/core';
import { AgentRegistry } from '@propr/core';

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

async function resolveDefaultAgentForDispatcher(correlatedLogger: Logger): Promise<{ agentAlias: string; modelToUse: string | undefined }> {
    const registry = AgentRegistry.getInstance();
    await registry.ensureInitialized();

    // First, try to use the configured default agent from settings
    try {
        const settings = await loadSettings();
        if (settings.default_agent_alias) {
            const configuredAgent = registry.getAgentByAlias(settings.default_agent_alias as string);
            if (configuredAgent && configuredAgent.config.enabled) {
                const agentAlias = settings.default_agent_alias as string;
                const modelToUse = configuredAgent.config.defaultModel;
                correlatedLogger.debug({ configuredDefaultAgent: agentAlias, defaultModel: modelToUse }, 'Using default agent from settings');
                return { agentAlias, modelToUse };
            }
        }
    } catch (settingsError) {
        correlatedLogger.debug({ error: (settingsError as Error).message }, 'Failed to load default agent from settings');
    }

    // Fallback to registry default if settings didn't provide an agent
    const defaultAgent = registry.getDefaultAgent();
    const agentAlias = defaultAgent?.config.alias || 'default';
    const modelToUse = defaultAgent?.config.defaultModel;
    correlatedLogger.debug({ fallbackAgent: agentAlias, fallbackModel: modelToUse }, 'Using fallback default agent');
    return { agentAlias, modelToUse };
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

        // Get all configured custom labels from agents
        const customLabels = await getAllCustomLabels();
        const customLabelMatches = labels.filter(l =>
            customLabels.some(cl => cl.toLowerCase() === l.toLowerCase())
        );

        const basesToProcess: BaseToProcess[] = baseLabels.length > 0
            ? baseLabels.map(l => ({ branch: l.substring('base-'.length), label: l }))
            : [{ branch: defaultBranch, label: null }];

        // Resolve LLM labels and custom labels to agent + model pairs
        const agentModelsToProcess: AgentModelToProcess[] = [];

        // First, process standard llm- prefixed labels
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
        }

        // Then, process custom labels (that don't overlap with llm- labels)
        if (customLabelMatches.length > 0) {
            for (const label of customLabelMatches) {
                const resolution = await resolveCustomLabel(label);
                if (resolution) {
                    agentModelsToProcess.push({
                        agentAlias: resolution.agentAlias,
                        model: resolution.model,
                        label
                    });
                    correlatedLogger.debug({
                        label,
                        resolvedAgent: resolution.agentAlias,
                        resolvedModel: resolution.model
                    }, 'Resolved custom label');
                }
            }
        }

        // If no LLM or custom labels found, use the default agent
        if (agentModelsToProcess.length === 0) {
            // No LLM or custom labels - use default agent from settings
            const { agentAlias, modelToUse } = await resolveDefaultAgentForDispatcher(correlatedLogger);

            agentModelsToProcess.push({
                agentAlias,
                model: modelToUse || DEFAULT_MODEL_NAME,
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
