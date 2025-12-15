import path from 'path';
import os from 'os';
import fs from 'fs';
import logger from '../../utils/logger.js';
import { Agent, AgentConfig, AgentTaskOptions, AgentExecutionResult } from '../types.js';
import { executeDockerCommand } from '../../claude/docker/dockerExecutor.js';
import {
    verifyWorktreeStructure,
    verifyWorktreePostExecution,
    setWorktreeOwnership,
    parseStreamJsonOutput,
    storePromptInRedis,
    buildClaudePrompt,
    UsageLimitError
} from '../../claude/claudeHelpers.js';
import { resolveModelAlias, getDefaultModel } from '../../config/modelAliases.js';
import { resolveConfigPath } from '../../config/configRepoManager.js';

// Re-export UsageLimitError for convenience
export { UsageLimitError };

const DEFAULT_CLAUDE_MAX_TURNS = 1000;
const DEFAULT_CLAUDE_TIMEOUT_MS = 300000;

export class ClaudeAgent implements Agent {
    readonly config: AgentConfig;
    private readonly maxTurns: number;
    private readonly timeoutMs: number;

    constructor(config: AgentConfig) {
        this.config = config;
        this.maxTurns = parseInt(process.env.CLAUDE_MAX_TURNS || String(DEFAULT_CLAUDE_MAX_TURNS), 10);
        this.timeoutMs = parseInt(process.env.CLAUDE_TIMEOUT_MS || String(DEFAULT_CLAUDE_TIMEOUT_MS), 10);
    }

    async executeTask(options: AgentTaskOptions): Promise<AgentExecutionResult> {
        const {
            worktreePath,
            issueRef,
            prompt: customPrompt,
            model,
            systemPrompt,
            isRetry = false,
            retryReason,
            branchName,
            issueDetails,
            onSessionId,
            onContainerId,
            githubToken,
            tools
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
        }, isRetry ? 'Starting Claude agent execution (RETRY)...' : 'Starting Claude agent execution...');

        try {
            // Build the prompt using the helper (includes safety rules)
            const prompt = buildClaudePrompt({
                customPrompt,
                issueRef,
                branchName,
                modelName: effectiveModel,
                issueDetails,
                isRetry,
                retryReason
            });

            // Set worktree ownership for container compatibility
            await setWorktreeOwnership(worktreePath, issueRef.number);

            // Verify worktree structure before execution
            const worktreeGitContent = verifyWorktreeStructure(worktreePath, issueRef.number);

            // Build Docker arguments using agent config
            const dockerArgs = this.buildDockerArgs({
                worktreePath,
                githubToken,
                modelName: effectiveModel,
                issueNumber: issueRef.number,
                systemPrompt,
                tools
            });

            // Execute Docker command
            const result = await executeDockerCommand('docker', dockerArgs, {
                timeout: this.timeoutMs,
                cwd: worktreePath,
                onSessionId,
                onContainerId,
                worktreePath,
                stdinData: prompt // Pass prompt via stdin to avoid E2BIG
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
            }, 'Claude agent execution completed');

            // Parse the streaming JSON output
            const claudeOutput = parseStreamJsonOutput(result);

            const modelUsed = claudeOutput.model || effectiveModel || getDefaultModel();

            const response: AgentExecutionResult = {
                success: claudeOutput.success,
                executionTimeMs: executionTime,
                logs: result.stderr || '',
                exitCode: result.exitCode,
                rawOutput: result.stdout,
                sessionId: claudeOutput.sessionId ?? undefined,
                conversationId: claudeOutput.conversationId,
                modelUsed,
                cost: claudeOutput.finalResult?.total_cost_usd || claudeOutput.finalResult?.cost_usd,
                modifiedFiles: [],
                commitMessage: null,
                summary: claudeOutput.finalResult?.result ?? undefined,
                prompt
            };

            // Store prompt in Redis for audit trail
            await storePromptInRedis({
                claudeOutput,
                prompt,
                issueRef,
                model: modelUsed,
                isRetry,
                retryReason
            });

            if (!response.success) {
                logger.error({
                    issueNumber: issueRef.number,
                    exitCode: result.exitCode,
                    stderr: result.stderr,
                    agentAlias: this.config.alias
                }, 'Claude agent execution failed');
            } else {
                logger.info({
                    issueNumber: issueRef.number,
                    model: modelUsed,
                    agentAlias: this.config.alias
                }, 'Claude agent execution succeeded');

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
            }, 'Error during Claude agent execution');

            return {
                success: false,
                error: err.message,
                executionTimeMs: executionTime,
                logs: (error as { stderr?: string }).stderr || err.message,
                modifiedFiles: [],
                commitMessage: null,
                summary: undefined,
                modelUsed: this.config.defaultModel || getDefaultModel()
            };
        }
    }

    async analyze(prompt: string, context?: string): Promise<string> {
        logger.info({
            agentAlias: this.config.alias,
            promptLength: prompt.length,
            hasContext: !!context
        }, 'Running lightweight analysis via Claude agent...');

        const model = resolveModelAlias('haiku');

        const analysisPrompt = context
            ? `${prompt}\n\nContext:\n${context}\n\nCRITICAL: Do not modify any files. Do not run any commands. Only provide your analysis as plain text output.`
            : `${prompt}\n\nCRITICAL: Do not modify any files. Do not run any commands. Only provide your analysis as plain text output.`;

        // For analysis, we use a minimal Docker execution with a temporary worktree path
        const tempPath = '/tmp/claude-analysis';

        try {
            const dockerArgs = this.buildDockerArgs({
                worktreePath: tempPath,
                githubToken: process.env.GITHUB_TOKEN || '',
                modelName: model,
                issueNumber: 0,
                systemPrompt: 'You are a helpful assistant.',
                tools: ''
            });

            const result = await executeDockerCommand('docker', dockerArgs, {
                timeout: 60000, // 1 minute timeout for analysis
                stdinData: analysisPrompt
            });

            const claudeOutput = parseStreamJsonOutput(result);

            if (claudeOutput.finalResult?.result || claudeOutput.success) {
                const analysisText = (claudeOutput.finalResult?.result || '').trim();
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
        }, 'Running health check for Claude agent...');

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
     * Builds Docker arguments for running Claude in a container.
     * This is a private method specific to ClaudeAgent as different agents
     * will construct Docker arguments differently.
     */
    private buildDockerArgs(params: {
        worktreePath: string;
        githubToken: string;
        modelName?: string;
        issueNumber: number;
        systemPrompt?: string;
        tools?: string;
    }): string[] {
        const {
            worktreePath,
            githubToken,
            modelName,
            issueNumber,
            systemPrompt,
            tools
        } = params;

        // Use config values instead of environment defaults
        const dockerImage = this.config.dockerImage;
        const configPath = resolveConfigPath(this.config.configPath);

        // Inject any custom environment variables from config
        const envVars: string[] = [];
        if (this.config.envVars) {
            for (const [key, value] of Object.entries(this.config.envVars)) {
                envVars.push('-e', `${key}=${value}`);
            }
        }

        const dockerArgs: string[] = [
            'run', '--rm',
            '-i', // Allow stdin for piping prompt
            '--security-opt', 'no-new-privileges',
            '--cap-add', 'CHOWN',
            '--network', 'bridge',
            '--user', '0:0',
            '-v', `${worktreePath}:/home/node/workspace:rw`,
            '-v', '/tmp/git-processor:/tmp/git-processor:rw',
            '-v', '/tmp/claude-logs:/tmp/claude-logs:rw',
            '-v', `${configPath}:/home/node/.claude:rw`,
            ...(fs.existsSync(path.join(os.homedir(), '.claude.json'))
                ? ['-v', `${path.join(os.homedir(), '.claude.json')}:/home/node/.claude.json:rw`]
                : []),
            '-e', `GH_TOKEN=${githubToken}`,
            ...envVars,
            '-w', '/home/node/workspace',
            dockerImage,
            'claude', '-p', '-', // Read prompt from stdin
            '--max-turns', this.maxTurns.toString(),
            '--output-format', 'stream-json',
            '--verbose',
            '--dangerously-skip-permissions'
        ];

        if (modelName) {
            const maxTurnsIndex = dockerArgs.indexOf('--max-turns');
            dockerArgs.splice(maxTurnsIndex, 0, '--model', modelName);
            logger.info({
                issueNumber,
                requestedModel: modelName,
                agentAlias: this.config.alias
            }, 'Using specific model for Claude agent execution');
        } else {
            logger.debug({
                issueNumber,
                agentAlias: this.config.alias
            }, 'No model specified, Claude agent will use default');
        }

        if (systemPrompt !== undefined) {
            dockerArgs.push('--system-prompt', systemPrompt);
            logger.info({
                issueNumber,
                systemPromptLength: systemPrompt.length,
                agentAlias: this.config.alias
            }, 'Using custom system prompt');
        }

        if (tools !== undefined) {
            dockerArgs.push('--tools', tools);
            logger.info({
                issueNumber,
                tools,
                agentAlias: this.config.alias
            }, 'Using custom tools configuration');
        }

        logger.info({
            issueNumber,
            hasSystemPrompt: systemPrompt !== undefined,
            hasTools: tools !== undefined,
            agentAlias: this.config.alias
        }, 'Docker args built for Claude agent');

        return dockerArgs;
    }
}
