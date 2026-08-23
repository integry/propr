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

function supportsRuntimeEnforcedRepositoryInspection(agent: Agent): boolean {
    switch (agent.config.type) {
        case 'claude':
        case 'codex':
        case 'opencode':
        case 'vibe':
        case 'antigravity':
            // Scout analysis disables every built-in tool and exposes only the
            // path-validating repository MCP server from the runtime adapter.
            return true;
        default:
            return false;
    }
}

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
    fastAnalysisModel: string;
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

type ScoutCandidateSource = 'dedicated context model' | 'fast analysis model' | 'reviewer model';

interface ScoutCandidate {
    source: ScoutCandidateSource;
    assignment: ScoutAssignment;
}

async function resolveConfiguredCandidate(
    model: string,
    source: Exclude<ScoutCandidateSource, 'reviewer model'>,
    correlatedLogger: Logger,
): Promise<ScoutCandidate | null> {
    if (!model.trim()) return null;
    try {
        const resolution = await resolveLlmLabel(model);
        return {
            source,
            assignment: { agentAlias: resolution.agentAlias, model: resolution.model },
        };
    } catch (error) {
        correlatedLogger.warn({
            model,
            source,
            error: (error as Error).message,
        }, 'Could not resolve context scout model candidate');
        return null;
    }
}

function getRepositoryConfinedAgent(options: PrepareRelatedReviewContextOptions, candidate: ScoutCandidate): Agent | null {
    const agent = options.registry.getAgentByAlias(candidate.assignment.agentAlias);
    if (!agent) {
        options.correlatedLogger.warn({
            source: candidate.source,
            agentAlias: candidate.assignment.agentAlias,
        }, 'Context scout model candidate is unavailable; trying the next candidate');
        return null;
    }
    if (!supportsRuntimeEnforcedRepositoryInspection(agent)) {
        options.correlatedLogger.info({
            source: candidate.source,
            agentAlias: candidate.assignment.agentAlias,
            agentType: agent.config.type,
        }, 'Context scout model candidate cannot enforce repository-only inspection; trying the next candidate');
        return null;
    }
    return agent;
}

async function selectScoutCandidate(options: PrepareRelatedReviewContextOptions): Promise<{ candidate: ScoutCandidate; agent: Agent } | null> {
    const consideredCandidates: ScoutCandidate[] = [];
    const configuredCandidates: Array<{ model: string; source: Exclude<ScoutCandidateSource, 'reviewer model'> }> = [
        { model: options.configuredModel, source: 'dedicated context model' },
        { model: options.fastAnalysisModel, source: 'fast analysis model' },
    ];
    for (const configuredCandidate of configuredCandidates) {
        const candidate = await resolveConfiguredCandidate(
            configuredCandidate.model,
            configuredCandidate.source,
            options.correlatedLogger,
        );
        if (!candidate) continue;
        consideredCandidates.push(candidate);
        const agent = getRepositoryConfinedAgent(options, candidate);
        if (agent) return { candidate, agent };
    }
    const reviewerCandidate: ScoutCandidate = { source: 'reviewer model', assignment: options.fallbackAssignment };
    consideredCandidates.push(reviewerCandidate);
    const reviewerAgent = getRepositoryConfinedAgent(options, reviewerCandidate);
    if (reviewerAgent) return { candidate: reviewerCandidate, agent: reviewerAgent };

    options.correlatedLogger.info({
        candidates: consideredCandidates.map(candidate => ({
            source: candidate.source,
            agentAlias: candidate.assignment.agentAlias,
            model: candidate.assignment.model,
        })),
    }, 'No context scout candidate can enforce repository-only inspection; using deterministic review context');
    return null;
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
    if (!supportsRuntimeEnforcedRepositoryInspection(options.agent)) {
        throw new Error(`Context scouting is unavailable for agent type: ${options.agent.config.type}`);
    }
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
    const selection = await selectScoutCandidate(options);
    if (!selection) return '';
    const { assignment } = selection.candidate;
    const { agent } = selection;

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
