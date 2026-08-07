import {
    createWorktreeFromExistingBranch,
    ensureGitRepository,
    ensureRepoCloned,
    getRepoUrl,
    resolveLlmLabel,
} from '@propr/core';
import type { Agent, AgentRegistry, AnalysisResult, WorktreeInfo } from '@propr/core';
import type { Logger } from 'pino';
import { validateAndExtractScoutContext } from './reviewContextScoutValidation.js';

const MAX_SCOUT_DIFF_CHARS = 120_000;
const MAX_REFERENCES = 12;
const SCOUT_TIMEOUT_MS = 30 * 60 * 1000;

export interface GatherReviewContextOptions {
    agent: Agent;
    model: string;
    worktreePath: string;
    prDiff: string;
    changedFiles: string[];
    originalTaskSpec: string;
    pullRequestNumber: number;
    repoOwner: string;
    repoName: string;
    taskId: string;
    correlationId: string;
    correlatedLogger: Logger;
}

interface ScoutAssignment {
    agentAlias: string;
    model: string;
}

interface PrepareRelatedReviewContextOptions {
    registry: AgentRegistry;
    fallbackAssignment: ScoutAssignment;
    configuredModel: string;
    state: { localRepoPath: string | undefined; worktreeInfo: WorktreeInfo | undefined };
    githubToken: string;
    branchName: string;
    prDiff: string;
    changedFiles: string[];
    originalTaskSpec: string;
    pullRequestNumber: number;
    repoOwner: string;
    repoName: string;
    taskId: string;
    correlationId: string;
    correlatedLogger: Logger;
}

function buildScoutPrompt(options: Pick<GatherReviewContextOptions, 'prDiff' | 'originalTaskSpec' | 'pullRequestNumber' | 'repoOwner' | 'repoName'>): string {
    const diff = options.prDiff.length > MAX_SCOUT_DIFF_CHARS
        ? `${options.prDiff.slice(0, MAX_SCOUT_DIFF_CHARS)}\n\n[Scout diff input truncated; inspect changed files and repository references directly.]`
        : options.prDiff;
    return `You are a read-only context scout for pull request #${options.pullRequestNumber} in ${options.repoOwner}/${options.repoName}.

Your only job is to locate unchanged repository code that a separate reviewer should inspect to understand the changed behavior. Search the repository for direct callers, consumers, contracts, types, schemas, configuration, repository instructions, and tests that constrain the changed paths.

Do not review or score the pull request. Do not identify bugs, blockers, fixes, redesigns, or general improvements. Do not select changed files because their full contents are already supplied separately. Return only high-signal references whose raw contents materially clarify the PR's changed control/data paths. Prefer narrow ranges and at most ${MAX_REFERENCES} references.

Return exactly this JSON shape:
{"references":[{"path":"relative/path.ts","startLine":1,"endLine":40,"relationship":"direct caller","reason":"why this unchanged range clarifies changed behavior"}]}

Original PR objective:
${options.originalTaskSpec || '(not available)'}

Base-to-head PR diff:
${diff || '(not available)'}`;
}

export async function gatherReviewContext(options: GatherReviewContextOptions): Promise<{ context: string; analysisResult: AnalysisResult }> {
    const analysisResult = await options.agent.analyze(buildScoutPrompt(options), {
        model: options.model,
        taskId: options.taskId,
        prNumber: options.pullRequestNumber,
        executionType: 'pr-review-context-scout',
        correlationId: options.correlationId,
        repository: `${options.repoOwner}/${options.repoName}`,
        responseFormat: 'json',
        timeoutMs: SCOUT_TIMEOUT_MS,
        readOnlyWorkspacePath: options.worktreePath,
        allowReadOnlyCommands: true,
    });
    if (!analysisResult.success) {
        throw new Error(analysisResult.error || 'Context scout analysis failed');
    }
    const context = await validateAndExtractScoutContext(options.worktreePath, options.changedFiles, analysisResult.response);
    options.correlatedLogger.info({
        pullRequestNumber: options.pullRequestNumber,
        model: analysisResult.modelUsed,
        contextLength: context.length,
    }, 'PR review context scout completed');
    return { context, analysisResult };
}

export async function prepareRelatedReviewContext(options: PrepareRelatedReviewContextOptions): Promise<string> {
    let assignment = options.fallbackAssignment;
    if (options.configuredModel) {
        try {
            const resolution = await resolveLlmLabel(options.configuredModel);
            if (options.registry.getAgentByAlias(resolution.agentAlias)) {
                assignment = { agentAlias: resolution.agentAlias, model: resolution.model };
            } else {
                options.correlatedLogger.warn({ configuredModel: options.configuredModel }, 'Configured context scout agent is unavailable; using the review model');
            }
        } catch (error) {
            options.correlatedLogger.warn({
                configuredModel: options.configuredModel,
                error: (error as Error).message,
            }, 'Could not resolve configured context scout model; using the review model');
        }
    }
    const agent = options.registry.getAgentByAlias(assignment.agentAlias);
    if (!agent) throw new Error(`Context scout agent not found: ${assignment.agentAlias}`);

    await ensureGitRepository(options.correlatedLogger);
    const repoUrl = getRepoUrl({ repoOwner: options.repoOwner, repoName: options.repoName });
    options.state.localRepoPath = await ensureRepoCloned({
        repoUrl,
        owner: options.repoOwner,
        repoName: options.repoName,
        authToken: options.githubToken,
    });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    options.state.worktreeInfo = await createWorktreeFromExistingBranch(options.state.localRepoPath, options.branchName, {
        worktreeDirName: `pr-${options.pullRequestNumber}-review-context-${timestamp}`,
        owner: options.repoOwner,
        repoName: options.repoName,
    });
    const result = await gatherReviewContext({
        agent,
        model: assignment.model,
        worktreePath: options.state.worktreeInfo.worktreePath,
        prDiff: options.prDiff,
        changedFiles: options.changedFiles,
        originalTaskSpec: options.originalTaskSpec,
        pullRequestNumber: options.pullRequestNumber,
        repoOwner: options.repoOwner,
        repoName: options.repoName,
        taskId: options.taskId,
        correlationId: options.correlationId,
        correlatedLogger: options.correlatedLogger,
    });
    return result.context;
}
