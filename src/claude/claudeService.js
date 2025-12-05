import path from 'path';
import os from 'os';
import logger from '../utils/logger.js';
import { getDefaultModel, resolveModelAlias } from '../config/modelAliases.js';
import { generateTaskImportPrompt } from './prompts/promptGenerator.js';
import { executeDockerCommand, buildClaudeDockerImage as buildDockerImageInternal } from './docker/dockerExecutor.js';
import {
    verifyWorktreeStructure,
    verifyWorktreePostExecution,
    setWorktreeOwnership,
    buildDockerArgs,
    parseStreamJsonOutput,
    storePromptInRedis,
    buildClaudePrompt,
    UsageLimitError
} from './claudeHelpers.js';

export { UsageLimitError };

const CLAUDE_DOCKER_IMAGE = process.env.CLAUDE_DOCKER_IMAGE || 'claude-code-processor:latest';
const CLAUDE_CONFIG_PATH = process.env.CLAUDE_CONFIG_PATH || path.join(os.homedir(), '.claude');
const CLAUDE_MAX_TURNS = parseInt(process.env.CLAUDE_MAX_TURNS || '1000', 10);
const CLAUDE_TIMEOUT_MS = parseInt(process.env.CLAUDE_TIMEOUT_MS || '300000', 10);


/**
 * Executes Claude Code CLI in a Docker container to analyze and fix a GitHub issue
 * @param {Object} options - Execution options
 * @param {string} options.worktreePath - Path to the Git worktree containing the repository
 * @param {Object} options.issueRef - GitHub issue reference
 * @param {string} options.githubToken - GitHub authentication token
 * @param {string} options.customPrompt - Custom prompt to use instead of default (optional)
 * @param {boolean} options.isRetry - Whether this is a retry attempt (optional)
 * @param {string} options.retryReason - Reason for retry (optional)
 * @param {string} options.branchName - The specific branch name to use (optional)
 * @param {string} options.modelName - The AI model being used (optional)
 * @param {Object} options.issueDetails - Pre-fetched issue details (optional)
 * @param {Function} options.onSessionId - Callback called when sessionId is detected (optional)
 * @param {Function} options.onContainerId - Callback called when container ID is detected (optional)
 * @returns {Promise<Object>} Claude execution result
 */
export async function executeClaudeCode(options) {
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
            worktreePath
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
        const response = {
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

        await storePromptInRedis({ claudeOutput, prompt, issueRef, model: response.model, isRetry, retryReason });

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
        logger.error({
            issueNumber: issueRef.number,
            repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
            executionTime,
            error: error.message
        }, 'Error during Claude Code execution');

        return {
            success: false,
            error: error.message,
            executionTime,
            output: null,
            logs: error.stderr || error.message
        };
    }
}

/**
 * Generates a text summary using the Claude Code Docker executor.
 * This re-uses the secure Docker setup for a text-only task.
 * @param {string} summaryRequest - The text to be summarized.
 * @param {string} worktreePath - Path to a valid worktree (required by executeClaudeCode).
 * @param {string} githubToken - GitHub authentication token.
 * @param {Object} issueRef - Issue reference for context.
 * @param {string} correlationId - Correlation ID for logging.
 * @param {string} modelAlias - The model alias (e.g., 'haiku') to use.
 * @returns {Promise<string>} The text content of the response.
 */
export async function generateTaskSummary(options) {
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
            const summary = (claudeResult.finalResult?.result || claudeResult.summary).trim().replace(/^"|"$/g, '');
            correlatedLogger.info({ summary, model }, 'Successfully generated task summary');
            return summary;
        }

        throw new Error(`Invalid summary response from Claude execution: ${claudeResult.error}`);
    } catch (error) {
        correlatedLogger.error({ error: error.message, model, promptLength: summaryPrompt.length }, 'Failed to generate task summary');
        throw error;
    }
}

/**
 * Executes a Docker command and returns the result
 * @param {string} command - Command to execute
 * @param {string[]} args - Command arguments
 * @param {Object} options - Execution options
 * @returns {Promise<Object>} Execution result
 */
export const buildClaudeDockerImage = buildDockerImageInternal;

export { generateTaskImportPrompt };

export async function runLightweightLLMAnalysis(options) {
  const { prompt, model, correlationId, worktreePath, githubToken, issueRef } = options;
  const correlatedLogger = logger.withCorrelation(correlationId);

  // Resolve model alias to actual model ID
  const { resolveModelAlias } = await import('../config/modelAliases.js');
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

    if (claudeResult.success && (claudeResult.finalResult?.result || claudeResult.summary)) {
      const analysisText = (claudeResult.finalResult?.result || claudeResult.summary).trim();
      correlatedLogger.info({
        model,
        responseLength: analysisText.length
      }, 'Lightweight LLM analysis completed successfully via Docker');
      return analysisText;
    }

    throw new Error(`Invalid analysis response from Claude execution: ${claudeResult.error}`);
  } catch (error) {
    correlatedLogger.error({ error: error.message, model }, 'Lightweight LLM analysis failed');
    throw error;
  }
}
