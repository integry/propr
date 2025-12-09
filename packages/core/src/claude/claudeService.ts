import path from 'path';
import os from 'os';
import logger from '../utils/logger.js';
import { getDefaultModel, resolveModelAlias } from '../config/modelAliases.js';
import { generateTaskImportPrompt, IssueRef, IssueDetails } from './prompts/promptGenerator.js';
import { executeDockerCommand, buildClaudeDockerImage as buildDockerImageInternal } from './docker/dockerExecutor.js';
import {
    verifyWorktreeStructure,
    verifyWorktreePostExecution,
    setWorktreeOwnership,
    buildDockerArgs,
    parseStreamJsonOutput,
    storePromptInRedis,
    buildClaudePrompt,
    UsageLimitError,
    ClaudeOutput,
    ConversationLogEntry,
    ClaudeOutputResult
} from './claudeHelpers.js';

export { UsageLimitError };
export type { IssueRef, IssueDetails };

const CLAUDE_DOCKER_IMAGE: string = process.env.CLAUDE_DOCKER_IMAGE || 'claude-code-processor:latest';
const CLAUDE_CONFIG_PATH: string = process.env.CLAUDE_CONFIG_PATH || path.join(os.homedir(), '.claude');
const CLAUDE_MAX_TURNS: number = parseInt(process.env.CLAUDE_MAX_TURNS || '1000', 10);
const CLAUDE_TIMEOUT_MS: number = parseInt(process.env.CLAUDE_TIMEOUT_MS || '300000', 10);

export interface ExecuteClaudeCodeOptions {
    worktreePath: string;
    issueRef: IssueRef;
    githubToken: string;
    customPrompt?: string;
    isRetry?: boolean;
    retryReason?: string;
    branchName?: string;
    modelName?: string;
    issueDetails?: IssueDetails;
    onSessionId?: (sessionId: string, conversationId?: string) => void;
    onContainerId?: (containerId: string, containerName: string) => void;
}

export interface ClaudeCodeResponse {
    success: boolean;
    executionTime: number;
    output: ClaudeOutput | null;
    logs: string;
    exitCode?: number | null;
    rawOutput?: string;
    conversationLog?: ConversationLogEntry[];
    sessionId?: string | null;
    conversationId?: string;
    model?: string;
    finalResult?: ClaudeOutputResult | null;
    modifiedFiles: string[];
    commitMessage: string | null;
    summary: string | null;
    prompt?: string;
    error?: string;
}

export interface GenerateTaskSummaryOptions {
    summaryRequest: string;
    worktreePath: string;
    githubToken: string;
    issueRef: IssueRef;
    correlationId: string;
    modelAlias?: string;
}

export interface RunLightweightLLMAnalysisOptions {
    prompt: string;
    model: string;
    correlationId: string;
    worktreePath: string;
    githubToken: string;
    issueRef: IssueRef;
}

export async function executeClaudeCode(options: ExecuteClaudeCodeOptions): Promise<ClaudeCodeResponse> {
    const { worktreePath, issueRef, githubToken, customPrompt, isRetry = false, retryReason, branchName, modelName, issueDetails, onSessionId, onContainerId } = options;
    const startTime = Date.now();

    logger.info({
        issueNumber: issueRef.number,
        repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
        worktreePath,
        dockerImage: CLAUDE_DOCKER_IMAGE,
        isRetry,
        retryReason
    }, isRetry ? 'Starting Claude Code execution (RETRY)...' : 'Starting Claude Code execution...');

    try {
        const prompt = buildClaudePrompt({ customPrompt, issueRef, branchName, modelName, issueDetails, isRetry, retryReason });
        await setWorktreeOwnership(worktreePath, issueRef.number);
        const worktreeGitContent = verifyWorktreeStructure(worktreePath, issueRef.number);

        const dockerArgs = buildDockerArgs({
            worktreePath,
            githubToken,
            prompt,
            modelName,
            issueNumber: issueRef.number,
            CLAUDE_DOCKER_IMAGE,
            CLAUDE_CONFIG_PATH,
            CLAUDE_MAX_TURNS
        });

        const result = await executeDockerCommand('docker', dockerArgs, {
            timeout: CLAUDE_TIMEOUT_MS,
            cwd: worktreePath,
            onSessionId,
            onContainerId,
            worktreePath,
            stdinData: prompt // Always pass prompt via stdin
        });

        const executionTime = Date.now() - startTime;
        logger.info({
            issueNumber: issueRef.number,
            repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
            executionTime,
            outputLength: result.stdout?.length || 0,
            success: result.exitCode === 0,
            exitCode: result.exitCode
        }, 'Claude Code execution completed');

        const claudeOutput = parseStreamJsonOutput(result);
        const response: ClaudeCodeResponse = {
            success: claudeOutput.success,
            executionTime,
            output: claudeOutput,
            logs: result.stderr || '',
            exitCode: result.exitCode,
            rawOutput: result.stdout,
            conversationLog: claudeOutput.conversationLog || [],
            sessionId: claudeOutput.sessionId,
            conversationId: claudeOutput.conversationId,
            model: claudeOutput.model || process.env.CLAUDE_MODEL || getDefaultModel(),
            finalResult: claudeOutput.finalResult,
            modifiedFiles: [],
            commitMessage: null,
            summary: claudeOutput.finalResult?.result || null,
            prompt: prompt
        };

        await storePromptInRedis({ claudeOutput, prompt, issueRef, model: response.model!, isRetry, retryReason });

        if (!response.success) {
            logger.error({ issueNumber: issueRef.number, exitCode: result.exitCode, stderr: result.stderr }, 'Claude Code execution failed');
        } else {
            logger.info({
                issueNumber: issueRef.number,
                conversationTurns: response.conversationLog?.length || 0,
                model: response.model
            }, 'Claude Code execution succeeded');
            verifyWorktreePostExecution(worktreePath, issueRef.number, worktreeGitContent);
        }

        return response;
    } catch (error) {
        const executionTime = Date.now() - startTime;
        const err = error as Error;
        logger.error({
            issueNumber: issueRef.number,
            repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
            executionTime,
            error: err.message
        }, 'Error during Claude Code execution');

        return {
            success: false,
            error: err.message,
            executionTime,
            output: null,
            logs: (error as { stderr?: string }).stderr || err.message,
            modifiedFiles: [],
            commitMessage: null,
            summary: null
        };
    }
}

export async function generateTaskSummary(options: GenerateTaskSummaryOptions): Promise<string> {
    const { summaryRequest, worktreePath, githubToken, issueRef, correlationId, modelAlias = 'haiku' } = options;
    const correlatedLogger = logger.withCorrelation(correlationId);
    correlatedLogger.info({ modelAlias, issueRef: issueRef.number }, 'Generating task summary via Docker executor...');

    const model = resolveModelAlias(modelAlias);

    const summaryPrompt = `Please provide a one-sentence summary for the following request, focusing on the main action. Your output must be ONLY the summary string itself, with no other text.

REQUEST:
${summaryRequest}

CRITICAL: Do not modify any files. Do not run any commands. Only output the summary.`;

    try {
        const claudeResult = await executeClaudeCode({
            worktreePath: worktreePath,
            issueRef: issueRef,
            githubToken: githubToken,
            customPrompt: summaryPrompt,
            branchName: 'summary-generation',
            modelName: model,
        });

        if (claudeResult.success && (claudeResult.finalResult?.result || claudeResult.summary)) {
            const summary = (claudeResult.finalResult?.result || claudeResult.summary)!.trim().replace(/^"|"$/g, '');
            correlatedLogger.info({ summary, model }, 'Successfully generated task summary');
            return summary;
        }

        throw new Error(`Invalid summary response from Claude execution: ${claudeResult.error}`);
    } catch (error) {
        const err = error as Error;
        correlatedLogger.error({ error: err.message, model, promptLength: summaryPrompt.length }, 'Failed to generate task summary');
        throw error;
    }
}

export const buildClaudeDockerImage = buildDockerImageInternal;

export { generateTaskImportPrompt };

export async function runLightweightLLMAnalysis(options: RunLightweightLLMAnalysisOptions): Promise<string> {
    const { prompt, model, correlationId, worktreePath, githubToken, issueRef } = options;
    const correlatedLogger = logger.withCorrelation(correlationId);

    const resolvedModel = resolveModelAlias(model);

    correlatedLogger.info({ model, resolvedModel }, 'Running lightweight LLM analysis via Docker...');

    try {
        const analysisPrompt = `${prompt}

CRITICAL: Do not modify any files. Do not run any commands. Only provide your analysis as plain text output.`;

        const claudeResult = await executeClaudeCode({
            worktreePath: worktreePath,
            issueRef: issueRef,
            githubToken: githubToken,
            customPrompt: analysisPrompt,
            branchName: 'analysis-generation',
            modelName: resolvedModel,
        });

        // Check for results even if exitCode was non-zero - Claude may have produced valid output
        if (claudeResult.finalResult?.result || claudeResult.summary) {
            const analysisText = (claudeResult.finalResult?.result || claudeResult.summary)!.trim();
            correlatedLogger.info({
                model,
                responseLength: analysisText.length,
                exitCode: claudeResult.exitCode
            }, 'Lightweight LLM analysis completed via Docker');
            return analysisText;
        }

        // Log detailed error info
        correlatedLogger.error({
            exitCode: claudeResult.exitCode,
            rawOutputLength: claudeResult.rawOutput?.length,
            rawOutputPreview: claudeResult.rawOutput?.substring(0, 500),
            logs: claudeResult.logs?.substring(0, 500),
            finalResult: claudeResult.finalResult
        }, 'Claude execution did not produce valid result');

        throw new Error(`Invalid analysis response from Claude execution: ${claudeResult.error || 'No result returned'}`);
    } catch (error) {
        const err = error as Error;
        correlatedLogger.error({ error: err.message, model }, 'Lightweight LLM analysis failed');
        throw error;
    }
}
