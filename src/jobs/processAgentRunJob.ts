import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { AgentCapability, AgentRunState } from '@propr/shared';
import {
    AgentRegistry,
    getAgentRunById,
    getAuthenticatedOctokit,
    getStateManager,
    listPreviousReports,
    logger,
    transitionAgentRun,
    UsageLimitError,
    validateAgentDefinitionRuntime,
    TaskStates,
    type Agent,
    type AgentExecutionResult,
    type AgentRunJobData,
    type AgentTaskOptions,
    type IssueRef,
    type JobResult,
    type StoredAgentDefinition,
    type StoredAgentRun,
    type WorkerStateManager,
} from '@propr/core';
import { advanceAfterReport } from './agentRuns/autonomy.js';
import { buildAgentReportPrompt, extractAgentReport } from './agentRuns/reportPrompt.js';
import { prepareAgentRunWorkspace, splitRepository, type AgentRunWorkspace, type PrepareAgentRunWorkspace } from './agentRuns/workspace.js';
import type { GitHubToken } from './githubTypes.js';
import { compactNotificationRecap } from './notificationRecap.js';
import { resolveDefaultAgentAndModel } from './prCommentAgentUtils.js';
import { defaultRunCostCapDeps, withRunCostCap, writeTimelineEvent } from './runCostCap.js';

/**
 * Report-run executor for ProPR Agents.
 *
 * Turns a queued `agent_runs` row into an ordinary isolated task run (visible
 * in the Tasks UI, cancellable with `stopTaskExecution`) and stores the
 * agent's free-form report. Nothing is committed or pushed: the worktree
 * branch exists only so the shared worktree helpers can be reused.
 */

export const AGENT_RUN_USAGE_LIMIT_REASON = 'provider usage limit reached; trigger again later';

/** Capability-derived tool restrictions for the report run; enforced by agents once issue 8 lands. */
export interface AgentRunToolPolicy {
    capabilities: AgentCapability[];
    /** The report run never writes to the repository or GitHub. */
    readOnly: true;
}

export interface ResolvedAgentRunAgent {
    agent: Pick<Agent, 'executeTask'>;
    alias: string;
    model: string | undefined;
}

export type AgentRunStateManager = Pick<WorkerStateManager, 'createTaskStateIfAbsent' | 'updateTaskState' | 'markTaskCompleted' | 'markTaskFailed' | 'markTaskCancelled'>;

export interface AgentRunProcessorDeps {
    getRun: (runId: string) => Promise<StoredAgentRun | undefined>;
    transitionRun: typeof transitionAgentRun;
    validateDefinition: (definition: StoredAgentDefinition) => Promise<string | null>;
    listPreviousReports: typeof listPreviousReports;
    stateManager: () => AgentRunStateManager;
    /** Installation token and octokit used for cloning; read-only scoped inside agent containers. */
    getGitHubAccess: () => Promise<{ token: string; octokit: unknown }>;
    prepareWorkspace: PrepareAgentRunWorkspace;
    resolveAgent: (definition: StoredAgentDefinition, log: Logger) => Promise<ResolvedAgentRunAgent>;
    buildPrompt: typeof buildAgentReportPrompt;
    /** Runs the agent inside the instance spend cap (`default_max_cost_usd`). */
    withCostCap: <T>(target: { taskId: string; repoOwner: string; repoName: string; modelName?: string; logger: Logger }, operation: () => Promise<T>) => Promise<T>;
    advanceAfterReport: (run: StoredAgentRun) => Promise<StoredAgentRun | null>;
}

async function defaultResolveAgent(definition: StoredAgentDefinition, log: Logger): Promise<ResolvedAgentRunAgent> {
    const registry = AgentRegistry.getInstance();
    await registry.ensureInitialized();
    if (definition.agentAlias === null) {
        const { resolvedAlias, resolvedModel } = await resolveDefaultAgentAndModel(registry, log);
        const agent = registry.getAgentByAlias(resolvedAlias);
        if (!agent) throw new Error(`Configured default agent not found: ${resolvedAlias}`);
        return { agent, alias: resolvedAlias, model: resolvedModel };
    }
    const agent = registry.getAgentByAlias(definition.agentAlias);
    if (!agent) throw new Error(`Agent not found: ${definition.agentAlias}`);
    return { agent, alias: definition.agentAlias, model: definition.modelName ?? agent.config.defaultModel ?? undefined };
}

export const defaultAgentRunProcessorDeps: AgentRunProcessorDeps = {
    getRun: runId => getAgentRunById(runId),
    transitionRun: transitionAgentRun,
    validateDefinition: definition => validateAgentDefinitionRuntime(definition),
    listPreviousReports,
    stateManager: () => getStateManager(),
    getGitHubAccess: async () => {
        const octokit = await getAuthenticatedOctokit();
        const token = await octokit.auth({ type: 'installation' }) as GitHubToken;
        return { token: token.token, octokit };
    },
    prepareWorkspace: prepareAgentRunWorkspace,
    resolveAgent: defaultResolveAgent,
    buildPrompt: buildAgentReportPrompt,
    // A report run has no issue or pull request to comment on, so a spend-cap
    // stop is recorded on the task timeline only.
    withCostCap: (target, operation) => withRunCostCap(
        { ...target, number: 0, kind: 'issue' },
        () => operation(),
        { ...defaultRunCostCapDeps, recordExceeded: (capTarget, snapshot) => writeTimelineEvent(capTarget, snapshot) },
    ),
    advanceAfterReport: run => advanceAfterReport(run),
};

export function agentRunReportTaskId(runId: string): string {
    return `agent-run-${runId}-report`;
}

export function agentRunIssueRef(definition: StoredAgentDefinition): IssueRef {
    const primary = definition.repositories[0];
    const { owner, repo } = primary ? splitRepository(primary) : { owner: '', repo: '' };
    return {
        number: 0,
        repoOwner: owner,
        repoName: repo,
        type: 'agent-run',
        title: `Agent: ${definition.name}`,
        subtitle: 'Report run',
    };
}

/** First line of the report with content, compacted for the Inbox; a bare "Summary" heading is skipped. */
export function agentReportRecap(report: string): string | undefined {
    for (const line of report.split(/\r?\n/)) {
        const recap = compactNotificationRecap(line);
        if (recap) return recap;
    }
    return undefined;
}

function failureMessage(result: AgentExecutionResult): string {
    const detail = result.error?.trim() || (result.exitCode != null ? `exit code ${result.exitCode}` : '');
    return detail ? `Agent execution failed: ${detail}` : 'Agent execution failed';
}

class AgentRunReportError extends Error {}

export function createAgentRunProcessor(overrides: Partial<AgentRunProcessorDeps> = {}) {
    const deps: AgentRunProcessorDeps = { ...defaultAgentRunProcessorDeps, ...overrides };

    async function failRun(runId: string, from: AgentRunState[], reason: string, log: Logger): Promise<void> {
        try {
            const failed = await deps.transitionRun(runId, from, 'failed', { failureReason: reason });
            if (!failed) log.info({ runId }, 'Agent run left its state before it could be marked failed');
        } catch (error) {
            log.error({ runId, err: error }, 'Could not mark agent run failed');
        }
    }

    return async function processAgentRun(job: Job<AgentRunJobData>): Promise<JobResult> {
        const { runId, correlationId } = job.data;
        const log: Logger = logger.withCorrelation(correlationId);

        // 1. A run cancelled or skipped before pickup does nothing.
        const run = await deps.getRun(runId);
        if (!run || run.state !== 'queued') {
            log.info({ runId, state: run?.state ?? null }, 'Agent run is not queued; skipping');
            return { status: 'skipped', runId, correlationId };
        }

        // 2. Execute the definition as it was when the run was triggered.
        const definition = run.definitionSnapshot;
        const invalid = definition ? await deps.validateDefinition(definition) : 'The agent definition snapshot is unreadable';
        if (!definition || invalid) {
            await failRun(runId, ['queued'], invalid ?? 'The agent definition snapshot is unreadable', log);
            return { status: 'failed', runId, reason: invalid, correlationId };
        }

        // 3. The receipt in the Tasks UI.
        const taskId = agentRunReportTaskId(runId);
        const issueRef = agentRunIssueRef(definition);
        const stateManager = deps.stateManager();
        await stateManager.createTaskStateIfAbsent(taskId, issueRef, correlationId, job.id === undefined ? null : String(job.id));

        // 4. Claim the run; null means it was cancelled in the meantime.
        const running = await deps.transitionRun(runId, ['queued'], 'running', { reportTaskId: taskId });
        if (!running) {
            log.info({ runId, taskId }, 'Agent run was cancelled before it started');
            await stateManager.markTaskCancelled(taskId, 'system', { reason: 'Agent run was cancelled before it started' });
            return { status: 'cancelled', runId, taskId, correlationId };
        }

        let workspace: AgentRunWorkspace | undefined;
        try {
            await stateManager.updateTaskState(taskId, TaskStates.PROCESSING, { reason: 'Preparing agent workspace' });
            const { token, octokit } = await deps.getGitHubAccess();

            // 5. Sandboxed checkout, or an empty git directory without repository_read.
            workspace = await deps.prepareWorkspace({ runId, definition, githubToken: token, octokit, logger: log });

            // 6. Previous reports and the prompt.
            const previousReports = definition.includePreviousReports
                ? await deps.listPreviousReports(definition.id, {
                    limit: definition.previousReportsLimit,
                    beforeCreatedAt: run.createdAt,
                    excludeRunId: runId,
                })
                : [];
            const prompt = deps.buildPrompt({
                definition,
                run: { id: run.id, trigger: run.trigger, triggerSource: run.triggerSource, createdAt: run.createdAt },
                previousReports,
                attachments: workspace.attachments,
                workspace: workspace.promptWorkspace,
            });

            // 7. Execute in a container within the spend cap.
            const { agent, alias, model } = await deps.resolveAgent(definition, log);
            await stateManager.updateTaskState(taskId, TaskStates.CLAUDE_EXECUTION, { reason: `Running agent ${alias}` });
            const toolPolicy: AgentRunToolPolicy = { capabilities: [...definition.capabilities], readOnly: true };
            const options: AgentTaskOptions & { toolPolicy: AgentRunToolPolicy } = {
                worktreePath: workspace.worktreePath,
                issueRef,
                prompt,
                model,
                githubToken: token,
                branchName: workspace.branchName,
                taskId,
                toolPolicy,
                metadata: { agentRunId: runId, agentDefinitionId: definition.id },
            };
            const result = await deps.withCostCap(
                { taskId, repoOwner: issueRef.repoOwner, repoName: issueRef.repoName, modelName: model, logger: log },
                () => agent.executeTask(options),
            );

            // 8. The report is the agent's final message.
            if (!result.success) throw new AgentRunReportError(failureMessage(result));
            const report = extractAgentReport(result);
            if (!report.trim()) throw new AgentRunReportError('The agent finished without a report');

            // 9. Store the report, then advance by autonomy mode.
            await stateManager.updateTaskState(taskId, TaskStates.POST_PROCESSING, { reason: 'Storing agent report' });
            const reported = await deps.transitionRun(runId, ['running'], 'report_ready', { report });
            if (!reported) {
                log.info({ runId, taskId }, 'Agent run was cancelled before its report was stored');
                return { status: 'cancelled', runId, taskId, correlationId };
            }
            const advanced = await deps.advanceAfterReport(reported);

            // 10. Close the task.
            await stateManager.markTaskCompleted(taskId, { status: 'complete', notificationRecap: agentReportRecap(report) });
            log.info({ runId, taskId, agentAlias: alias, model, state: advanced?.state ?? reported.state }, 'Agent run report stored');
            return { status: 'complete', runId, taskId, state: advanced?.state ?? reported.state, correlationId };
        } catch (error) {
            const usageLimit = error instanceof UsageLimitError;
            const reason = usageLimit ? AGENT_RUN_USAGE_LIMIT_REASON : (error as Error).message;
            log[error instanceof AgentRunReportError ? 'warn' : 'error']({ runId, taskId, err: error }, 'Agent run report failed');
            await failRun(runId, ['running', 'report_ready'], reason, log);
            try {
                await stateManager.markTaskFailed(taskId, usageLimit ? new Error(reason) : error as Error);
            } catch (stateError) {
                log.error({ runId, taskId, err: stateError }, 'Could not mark agent run task failed');
            }
            return { status: 'failed', runId, taskId, reason, correlationId };
        } finally {
            // 11. Nothing was committed or pushed; just remove the workspace.
            await workspace?.cleanup();
        }
    };
}

export const processAgentRunJob = createAgentRunProcessor();

/**
 * Placeholder for the acting phase (issue 10). The run is failed explicitly so
 * it does not stay `acting` forever.
 */
export async function processAgentActionJob(job: Job<AgentRunJobData>): Promise<JobResult> {
    const message = `Not implemented: agent run ${job.data.phase} phase`;
    try {
        await transitionAgentRun(job.data.runId, ['acting'], 'failed', { failureReason: message });
    } catch (error) {
        logger.error({ runId: job.data.runId, err: error }, 'Could not mark agent run failed');
    }
    throw new Error(message);
}
