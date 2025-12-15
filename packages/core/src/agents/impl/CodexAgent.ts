import logger from '../../utils/logger.js';
import { Agent, AgentConfig, AgentTaskOptions, AgentExecutionResult } from '../types.js';
import { executeDockerCommand } from '../../claude/docker/dockerExecutor.js';
import {
    verifyWorktreeStructure,
    verifyWorktreePostExecution,
    setWorktreeOwnership,
    UsageLimitError
} from '../../claude/claudeHelpers.js';
import { resolveModelAlias } from '../../config/modelAliases.js';
import { resolveConfigPath } from '../../config/configRepoManager.js';

// Re-export UsageLimitError for convenience
export { UsageLimitError };

const DEFAULT_CODEX_MAX_TURNS = 1000;
const DEFAULT_CODEX_TIMEOUT_MS = 300000;

// Container path for Codex config
const CONTAINER_CONFIG_PATH = '/home/node/.codex';

/**
 * Parsed event from Codex JSON output
 */
interface CodexEvent {
    type?: string;
    role?: string;
    content?: string;
    tool?: string;
    params?: Record<string, unknown>;
    message?: string;
    status?: string;
    result?: string;
}

/**
 * Parsed output from Codex execution
 */
interface CodexParsedOutput {
    success: boolean;
    logs: string;
    result?: string;
    error?: string;
}

export class CodexAgent implements Agent {
    readonly config: AgentConfig;
    private readonly maxTurns: number;
    private readonly timeoutMs: number;

    constructor(config: AgentConfig) {
        this.config = config;
        this.maxTurns = parseInt(process.env.CODEX_MAX_TURNS || String(DEFAULT_CODEX_MAX_TURNS), 10);
        this.timeoutMs = parseInt(process.env.CODEX_TIMEOUT_MS || String(DEFAULT_CODEX_TIMEOUT_MS), 10);
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
        }, isRetry ? 'Starting Codex agent execution (RETRY)...' : 'Starting Codex agent execution...');

        try {
            // Build prompt with retry context if applicable
            let prompt = customPrompt;
            if (isRetry && retryReason) {
                prompt = `${customPrompt}\n\n---\n\n**RETRY CONTEXT**: This is a retry attempt. Previous attempt failed with: ${retryReason}\n\nPlease address the issues from the previous attempt.`;
            }

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
                stdinData: prompt
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
            }, 'Codex agent execution completed');

            // Parse the NDJSON output
            const parsedOutput = this.parseCodexOutput(result.stdout);

            const modelUsed = effectiveModel || 'unknown';

            const response: AgentExecutionResult = {
                success: parsedOutput.success && result.exitCode === 0,
                executionTimeMs: executionTime,
                logs: parsedOutput.logs + (result.stderr ? `\n\nSTDERR:\n${result.stderr}` : ''),
                exitCode: result.exitCode,
                rawOutput: result.stdout,
                modelUsed,
                modifiedFiles: [],
                commitMessage: null,
                summary: parsedOutput.result ?? undefined,
                prompt,
                error: parsedOutput.error
            };

            if (!response.success) {
                logger.error({
                    issueNumber: issueRef.number,
                    exitCode: result.exitCode,
                    stderr: result.stderr,
                    agentAlias: this.config.alias
                }, 'Codex agent execution failed');
            } else {
                logger.info({
                    issueNumber: issueRef.number,
                    model: modelUsed,
                    agentAlias: this.config.alias
                }, 'Codex agent execution succeeded');

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
            }, 'Error during Codex agent execution');

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
        }, 'Running lightweight analysis via Codex agent...');

        const model = resolveModelAlias('haiku');

        const analysisPrompt = context
            ? `${prompt}\n\nContext:\n${context}\n\nCRITICAL: Do not modify any files. Do not run any commands. Only provide your analysis as plain text output.`
            : `${prompt}\n\nCRITICAL: Do not modify any files. Do not run any commands. Only provide your analysis as plain text output.`;

        try {
            const dockerArgs = this.buildDockerArgs({
                worktreePath: '/tmp/codex-analysis',
                githubToken: process.env.GITHUB_TOKEN || '',
                modelName: model,
                issueNumber: 0
            });

            const result = await executeDockerCommand('docker', dockerArgs, {
                timeout: 60000, // 1 minute timeout for analysis
                stdinData: analysisPrompt
            });

            const parsedOutput = this.parseCodexOutput(result.stdout);

            if (parsedOutput.success || parsedOutput.result) {
                const analysisText = (parsedOutput.result || '').trim();
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
        }, 'Running health check for Codex agent...');

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
     * Parses Codex NDJSON output into structured data.
     * Codex with --json outputs newline-delimited JSON events.
     */
    private parseCodexOutput(stdout: string): CodexParsedOutput {
        let logs = '';
        let result: string | undefined;
        let isError = false;
        let errorMessage: string | undefined;

        const lines = stdout.split('\n');
        for (const line of lines) {
            if (!line.trim()) continue;

            try {
                const event: CodexEvent = JSON.parse(line);

                if (event.type === 'message') {
                    logs += `[${event.role || 'unknown'}] ${event.content || ''}\n`;
                } else if (event.type === 'tool_use') {
                    logs += `[Tool] ${event.tool} params: ${JSON.stringify(event.params)}\n`;
                } else if (event.type === 'error') {
                    isError = true;
                    errorMessage = event.message;
                    logs += `[Error] ${event.message}\n`;
                } else if (event.type === 'result') {
                    result = event.result || event.content;
                    if (event.status === 'error') {
                        isError = true;
                        errorMessage = event.message || 'Unknown error';
                    }
                } else {
                    // Handle other event types or unknown types
                    logs += `[${event.type || 'unknown'}] ${JSON.stringify(event)}\n`;
                }
            } catch {
                // Fallback for non-JSON lines (e.g., strict system errors)
                logs += line + '\n';
            }
        }

        return {
            success: !isError,
            logs,
            result,
            error: errorMessage
        };
    }

    /**
     * Builds Docker arguments for running Codex in a container.
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
        const configPath = resolveConfigPath(this.config.configPath);

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
            ...envVars,
            '-w', '/home/node/workspace',
            dockerImage,
            // Codex CLI arguments
            'codex', 'exec',
            '--json',                    // Output newline-delimited JSON events
            '--full-auto',               // Skip manual approvals
            '--sandbox', 'workspace-write', // Allow file edits in workspace
            '--cd', '/home/node/workspace', // Set working directory
            '-'                          // Read prompt from stdin
        ];

        // Add model if specified
        if (modelName) {
            const codexIndex = dockerArgs.indexOf('codex');
            dockerArgs.splice(codexIndex + 2, 0, '--model', modelName);
            logger.info({
                issueNumber,
                requestedModel: modelName,
                agentAlias: this.config.alias
            }, 'Using specific model for Codex agent execution');
        } else {
            logger.debug({
                issueNumber,
                agentAlias: this.config.alias
            }, 'No model specified, Codex agent will use default');
        }

        logger.info({
            issueNumber,
            agentAlias: this.config.alias
        }, 'Docker args built for Codex agent');

        return dockerArgs;
    }
}
