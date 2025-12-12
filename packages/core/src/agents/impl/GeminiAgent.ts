import path from 'path';
import os from 'os';
import fs from 'fs';
import logger from '../../utils/logger.js';
import { Agent, AgentConfig, AgentTaskOptions, AgentExecutionResult } from '../types.js';
import { executeDockerCommand, ExecutionResult } from '../../claude/docker/dockerExecutor.js';
import {
    verifyWorktreeStructure,
    verifyWorktreePostExecution,
    setWorktreeOwnership,
    UsageLimitError
} from '../../claude/claudeHelpers.js';
import { resolveModelAlias } from '../../config/modelAliases.js';

// Re-export UsageLimitError for convenience
export { UsageLimitError };

const DEFAULT_GEMINI_TIMEOUT_MS = 300000;

// Container path for Gemini config
const CONTAINER_CONFIG_PATH = '/home/node/.gemini';

// ANSI escape code regex for stripping terminal formatting from TUI output
const ANSI_REGEX = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

export class GeminiAgent implements Agent {
    readonly config: AgentConfig;
    private readonly timeoutMs: number;

    constructor(config: AgentConfig) {
        this.config = config;
        this.timeoutMs = parseInt(process.env.GEMINI_TIMEOUT_MS || String(DEFAULT_GEMINI_TIMEOUT_MS), 10);
    }

    async executeTask(options: AgentTaskOptions): Promise<AgentExecutionResult> {
        const {
            worktreePath,
            issueRef,
            prompt: customPrompt,
            model,
            isRetry = false,
            retryReason,
            onSessionId,
            onContainerId,
            githubToken
        } = options;

        const startTime = Date.now();
        const effectiveModel = model || this.config.defaultModel;

        logger.info({
            issueNumber: issueRef.number,
            repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
            worktreePath,
            dockerImage: this.config.dockerImage,
            agentAlias: this.config.alias,
            isRetry,
            retryReason
        }, isRetry ? 'Starting Gemini agent execution (RETRY)...' : 'Starting Gemini agent execution...');

        try {
            // Build prompt with retry context if applicable
            let prompt = customPrompt;
            if (isRetry && retryReason) {
                prompt = `${customPrompt}\n\n---\n\n**RETRY CONTEXT**: This is a retry attempt. Previous attempt failed with: ${retryReason}\n\nPlease address the issues from the previous attempt.`;
            }

            // Append /quit to ensure the session terminates
            // This is necessary because Gemini CLI is a TUI and needs explicit exit
            const stdinData = `${prompt}\n\n/quit`;

            // Set worktree ownership for container compatibility
            await setWorktreeOwnership(worktreePath, issueRef.number);

            // Verify worktree structure before execution
            const worktreeGitContent = verifyWorktreeStructure(worktreePath, issueRef.number);

            // Build Docker arguments using agent config
            const dockerArgs = this.buildDockerArgs({
                worktreePath,
                githubToken,
                modelName: effectiveModel,
                issueNumber: issueRef.number
            });

            // Execute Docker command with prompt via stdin
            const result = await executeDockerCommand('docker', dockerArgs, {
                timeout: this.timeoutMs,
                cwd: worktreePath,
                onSessionId,
                onContainerId,
                worktreePath,
                stdinData
            });

            const executionTime = Date.now() - startTime;
            logger.info({
                issueNumber: issueRef.number,
                repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
                executionTime,
                outputLength: result.stdout?.length || 0,
                success: result.exitCode === 0,
                exitCode: result.exitCode,
                agentAlias: this.config.alias
            }, 'Gemini agent execution completed');

            // Strip ANSI codes from TUI output and extract result
            const cleanedOutput = this.stripAnsiCodes(result.stdout);
            const extractedResult = this.extractGeminiResult(cleanedOutput);

            const modelUsed = effectiveModel || 'unknown';

            const response: AgentExecutionResult = {
                success: result.exitCode === 0,
                executionTimeMs: executionTime,
                logs: cleanedOutput + (result.stderr ? `\n\nSTDERR:\n${result.stderr}` : ''),
                exitCode: result.exitCode,
                rawOutput: result.stdout,
                modelUsed,
                modifiedFiles: [],
                commitMessage: null,
                summary: extractedResult ?? undefined,
                prompt
            };

            if (!response.success) {
                logger.error({
                    issueNumber: issueRef.number,
                    exitCode: result.exitCode,
                    stderr: result.stderr,
                    agentAlias: this.config.alias
                }, 'Gemini agent execution failed');
            } else {
                logger.info({
                    issueNumber: issueRef.number,
                    model: modelUsed,
                    agentAlias: this.config.alias
                }, 'Gemini agent execution succeeded');

                // Verify worktree state after successful execution
                verifyWorktreePostExecution(worktreePath, issueRef.number, worktreeGitContent);
            }

            return response;
        } catch (error) {
            const executionTime = Date.now() - startTime;
            const err = error as Error;

            // Re-throw UsageLimitError for proper handling upstream
            if (error instanceof UsageLimitError) {
                throw error;
            }

            logger.error({
                issueNumber: issueRef.number,
                repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
                executionTime,
                error: err.message,
                agentAlias: this.config.alias
            }, 'Error during Gemini agent execution');

            return {
                success: false,
                error: err.message,
                executionTimeMs: executionTime,
                logs: (error as { stderr?: string }).stderr || err.message,
                modifiedFiles: [],
                commitMessage: null,
                summary: undefined,
                modelUsed: effectiveModel || 'unknown'
            };
        }
    }

    async analyze(prompt: string, context?: string): Promise<string> {
        logger.info({
            agentAlias: this.config.alias,
            promptLength: prompt.length,
            hasContext: !!context
        }, 'Running lightweight analysis via Gemini agent...');

        const model = resolveModelAlias('haiku');

        const analysisPrompt = context
            ? `${prompt}\n\nContext:\n${context}\n\nCRITICAL: Do not modify any files. Do not run any commands. Only provide your analysis as plain text output.`
            : `${prompt}\n\nCRITICAL: Do not modify any files. Do not run any commands. Only provide your analysis as plain text output.`;

        // Append /quit to terminate the session
        const stdinData = `${analysisPrompt}\n\n/quit`;

        try {
            const dockerArgs = this.buildDockerArgs({
                worktreePath: '/tmp/gemini-analysis',
                githubToken: process.env.GITHUB_TOKEN || '',
                modelName: model,
                issueNumber: 0
            });

            const result = await executeDockerCommand('docker', dockerArgs, {
                timeout: 60000, // 1 minute timeout for analysis
                stdinData
            });

            const cleanedOutput = this.stripAnsiCodes(result.stdout);
            const extractedResult = this.extractGeminiResult(cleanedOutput);

            if (result.exitCode === 0 || extractedResult) {
                const analysisText = (extractedResult || cleanedOutput || '').trim();
                logger.info({
                    agentAlias: this.config.alias,
                    responseLength: analysisText.length,
                    model
                }, 'Lightweight analysis completed');
                return analysisText;
            }

            throw new Error(`Analysis failed: ${result.stderr || 'No result returned'}`);
        } catch (error) {
            const err = error as Error;
            logger.error({
                agentAlias: this.config.alias,
                error: err.message
            }, 'Lightweight analysis failed');
            throw error;
        }
    }

    async healthCheck(): Promise<boolean> {
        logger.debug({
            agentAlias: this.config.alias,
            dockerImage: this.config.dockerImage
        }, 'Running health check for Gemini agent...');

        try {
            const result = await executeDockerCommand('docker', [
                'images', '-q', this.config.dockerImage
            ], { timeout: 10000 });

            const imageExists = !!result.stdout.trim();

            logger.info({
                agentAlias: this.config.alias,
                dockerImage: this.config.dockerImage,
                imageExists
            }, imageExists ? 'Health check passed' : 'Health check failed: Docker image not found');

            return imageExists;
        } catch (error) {
            const err = error as Error;
            logger.error({
                agentAlias: this.config.alias,
                error: err.message
            }, 'Health check failed with error');
            return false;
        }
    }

    /**
     * Strips ANSI escape codes from output.
     * Gemini CLI is a TUI that produces ANSI-formatted output.
     */
    private stripAnsiCodes(text: string): string {
        return text.replace(ANSI_REGEX, '');
    }

    /**
     * Extracts the meaningful result from Gemini CLI output.
     * The TUI may include navigation elements, prompts, and other decorations.
     */
    private extractGeminiResult(cleanedOutput: string): string | undefined {
        // The output may contain multiple sections separated by prompts
        // We try to extract the main assistant response
        const lines = cleanedOutput.split('\n');
        const resultLines: string[] = [];
        let inResponse = false;

        for (const line of lines) {
            const trimmedLine = line.trim();

            // Skip empty lines at the beginning
            if (!inResponse && !trimmedLine) continue;

            // Skip common TUI elements
            if (trimmedLine.startsWith('>') || // User prompt indicator
                trimmedLine === '/quit' ||
                trimmedLine.startsWith('Gemini') ||
                trimmedLine.includes('Press') ||
                trimmedLine.includes('Ctrl+')) {
                continue;
            }

            // Start collecting response
            inResponse = true;
            resultLines.push(line);
        }

        const result = resultLines.join('\n').trim();
        return result || undefined;
    }

    /**
     * Builds Docker arguments for running Gemini in a container.
     */
    private buildDockerArgs(params: {
        worktreePath: string;
        githubToken: string;
        modelName?: string;
        issueNumber: number;
    }): string[] {
        const {
            worktreePath,
            githubToken,
            modelName,
            issueNumber
        } = params;

        const dockerImage = this.config.dockerImage;
        const configPath = this.config.configPath;

        // Inject any custom environment variables from config
        const envVars: string[] = [];
        if (this.config.envVars) {
            for (const [key, value] of Object.entries(this.config.envVars)) {
                envVars.push('-e', `${key}=${value}`);
            }
        }

        // Build Docker run arguments
        const dockerArgs: string[] = [
            'run', '--rm',
            '-i', // Allow stdin for piping prompt
            '--security-opt', 'no-new-privileges',
            '--cap-add', 'CHOWN',
            '--network', 'bridge',
            '--user', '0:0',
            '-v', `${worktreePath}:/home/node/workspace:rw`,
            '-v', '/tmp/git-processor:/tmp/git-processor:rw',
            '-v', `${configPath}:${CONTAINER_CONFIG_PATH}:rw`,
            '-e', `GH_TOKEN=${githubToken}`,
            '-e', `GITHUB_TOKEN=${githubToken}`,
            '-e', 'GEMINI_CLI=1', // Environment variable to indicate Gemini CLI context
            ...envVars,
            '-w', '/home/node/workspace',
            dockerImage,
            // Gemini CLI - runs as interactive TUI, we pipe prompt via stdin
            'gemini'
        ];

        // Add model selection if supported (Gemini CLI might use different mechanism)
        if (modelName) {
            logger.info({
                issueNumber,
                requestedModel: modelName,
                agentAlias: this.config.alias
            }, 'Model specified for Gemini agent (note: model selection may need manual configuration in Gemini settings)');
        } else {
            logger.debug({
                issueNumber,
                agentAlias: this.config.alias
            }, 'No model specified, Gemini agent will use default');
        }

        logger.info({
            issueNumber,
            agentAlias: this.config.alias
        }, 'Docker args built for Gemini agent');

        return dockerArgs;
    }
}
