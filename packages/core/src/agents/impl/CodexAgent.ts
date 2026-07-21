import fs from 'fs';
import { execSync } from 'child_process';
import logger from '../../utils/logger.js';
import { Agent, AgentConfig, AgentTaskOptions, AgentExecutionResult, AnalysisResult, AnalyzeOptions } from '../types.js';
import { executeDockerCommand } from '../../claude/docker/dockerExecutor.js';
import { wrapDockerRunArgsWithRepoSetup } from '../../claude/docker/repoSetupWrapper.js';
import {
    verifyWorktreeStructure,
    verifyWorktreePostExecution,
    setWorktreeOwnership,
    UsageLimitError
} from '../../claude/claudeHelpers.js';
import {
    buildCodexPrompt,
    parseCodexStreamOutput,
    storeCodexPromptInRedis
} from '../../codex/codexHelpers.js';
import {
    assertReasoningLevelCliVersionSupported,
    loadModelReasoningLevel,
    resolveCodexReasoningLevel,
    resolveConfigPath,
    type CodexRuntimeReasoningLevel,
    type ModelReasoningLevel
} from '../../config/configManager.js';
import { AGENT_DEFAULT_VERSIONS } from '../version/types.js';
import { persistLlmLog, createLlmLogFromAnalysis, buildTaskWorkRef, buildAnalysisWorkRef } from '../../utils/llmLogger.js';
import { executeWithUsageTracking } from './utils/index.js';
import type { ExecutionType } from '../../utils/llmMetrics.types.js';

// Re-export UsageLimitError for convenience
export { UsageLimitError };

const DEFAULT_CODEX_MAX_TURNS = 1000;
const DEFAULT_CODEX_TIMEOUT_MS = 3600000;
const ANALYSIS_AGENT_TANK_TIMEOUT_MS = parseInt(process.env.ANALYSIS_AGENT_TANK_TIMEOUT_MS || '2000', 10);

// Container path for Codex config
const CONTAINER_CONFIG_PATH = '/home/node/.codex';

type CodexExecutionOutput = Awaited<ReturnType<typeof executeDockerCommand>>;
type CodexParsedOutput = ReturnType<typeof parseCodexStreamOutput>;
type CodexUsageMetrics = Awaited<ReturnType<typeof executeWithUsageTracking>>['usageMetrics'];

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
        const { worktreePath, issueRef, prompt: customPrompt, model, systemPrompt,
            isRetry = false, retryReason, branchName, issueDetails,
            onSessionId, onContainerId, githubToken, environment, taskId, prNumber, reasoningLevel } = options;

        const startTime = Date.now();
        const effectiveModel = model || this.config.defaultModel;
        const repo = `${issueRef.repoOwner}/${issueRef.repoName}`;
        logger.info({
            issueNumber: issueRef.number, repository: repo, worktreePath,
            dockerImage: this.config.dockerImage, agentAlias: this.config.alias, isRetry, retryReason
        }, isRetry ? 'Starting Codex agent execution (RETRY)...' : 'Starting Codex agent execution...');

        try {
            const prompt = buildCodexPrompt({
                customPrompt, issueRef, branchName, modelName: effectiveModel,
                issueDetails, isRetry, retryReason, systemPrompt
            });
            await setWorktreeOwnership(worktreePath, issueRef.number);
            const worktreeGitContent = verifyWorktreeStructure(worktreePath, issueRef.number);
            const dockerArgs = this.buildDockerArgs({
                worktreePath, githubToken, modelName: effectiveModel,
                issueNumber: issueRef.number, environment, taskId,
                reasoningLevel: await this.resolveEffectiveReasoningLevel(reasoningLevel)
            });

            const { result, usageMetrics } = await executeWithUsageTracking(
                'codex',
                async () => executeDockerCommand('docker', dockerArgs, {
                    timeout: this.timeoutMs,
                    cwd: worktreePath,
                    onSessionId,
                    onContainerId,
                    worktreePath,
                    stdinData: prompt,
                    taskId,
                    streamToRedis: true
                })
            );

            const executionTime = Date.now() - startTime;
            const parsedOutput = parseCodexStreamOutput(result.stdout);
            const modelUsed = parsedOutput.model || effectiveModel || 'unknown';

            const response = this.buildTaskExecutionResult({ parsedOutput, result, effectiveModel, executionTime, prompt, usageMetrics });

            await this.persistTaskLog({
                response, parsedOutput, executionTime, modelUsed, prompt, usageMetrics,
                issueRef, repo, taskId, prNumber, isRetry, retryReason
            });

            this.handleTaskCompletion({ response, issueNumber: issueRef.number, result, parsedOutput, worktreePath, worktreeGitContent });

            return response;
        } catch (error) {
            if (error instanceof UsageLimitError) {
                throw error;
            }
            return this.handleTaskError({ error: error as Error, executionTime: Date.now() - startTime, issueRef, repo, effectiveModel });
        }
    }

    private buildTaskExecutionResult(params: {
        parsedOutput: CodexParsedOutput;
        result: CodexExecutionOutput;
        effectiveModel?: string;
        executionTime: number;
        prompt: string;
        usageMetrics: CodexUsageMetrics;
    }): AgentExecutionResult {
        const { parsedOutput, result, effectiveModel, executionTime, prompt, usageMetrics } = params;
        const modelUsed = parsedOutput.model || effectiveModel || 'unknown';
        return {
            success: parsedOutput.success && result.exitCode === 0,
            executionTimeMs: executionTime,
            logs: parsedOutput.logs + (result.stderr ? `\n\nSTDERR:\n${result.stderr}` : ''),
            exitCode: result.exitCode,
            rawOutput: result.stdout,
            modelUsed,
            sessionId: parsedOutput.sessionId,
            conversationId: parsedOutput.conversationId,
            conversationLog: parsedOutput.conversationLog,
            modifiedFiles: [],
            commitMessage: null,
            summary: parsedOutput.result ?? undefined,
            prompt,
            error: parsedOutput.error || (result.exitCode === 0 ? undefined : result.stderr?.trim() || undefined),
            tokenUsage: parsedOutput.tokenUsage,
            usageMetrics: usageMetrics ?? undefined
        };
    }

    private async persistTaskLog(params: {
        response: AgentExecutionResult; parsedOutput: CodexParsedOutput;
        executionTime: number; modelUsed: string; prompt: string;
        usageMetrics: CodexUsageMetrics;
        issueRef: AgentTaskOptions['issueRef']; repo: string;
        taskId?: string; prNumber?: number; isRetry: boolean; retryReason?: string;
    }): Promise<void> {
        const { response, parsedOutput, executionTime, modelUsed, usageMetrics, issueRef, repo, taskId, prNumber, isRetry, retryReason } = params;
        await storeCodexPromptInRedis({ codexOutput: parsedOutput, prompt: params.prompt, issueRef, model: modelUsed, isRetry, retryReason });
        const logEntry = createLlmLogFromAnalysis({
            executionType: 'implementation', modelUsed,
            executionTimeMs: executionTime, success: response.success,
            tokenUsage: parsedOutput.tokenUsage,
            error: response.success ? undefined : (parsedOutput.error || 'Execution failed'),
            sessionId: parsedOutput.sessionId, draftId: taskId,
            repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
            agentAlias: this.config.alias,
            metadata: { isRetry, retryReason, conversationId: parsedOutput.conversationId },
            ...this.formatUsageMetrics(usageMetrics),
            workRef: buildTaskWorkRef(taskId, issueRef.number, repo, prNumber),
        });
        await persistLlmLog(logEntry);
    }

    private handleTaskCompletion(params: {
        response: AgentExecutionResult;
        issueNumber: number;
        result: CodexExecutionOutput;
        parsedOutput: CodexParsedOutput;
        worktreePath: string;
        worktreeGitContent: string | null;
    }): void {
        const { response, issueNumber, result, parsedOutput, worktreePath, worktreeGitContent } = params;
        if (!response.success) {
            logger.error({
                issueNumber, exitCode: result.exitCode,
                stderr: result.stderr, agentAlias: this.config.alias, error: parsedOutput.error
            }, 'Codex agent execution failed');
            return;
        }

        logger.info({ issueNumber, model: response.modelUsed, agentAlias: this.config.alias }, 'Codex agent execution succeeded');
        verifyWorktreePostExecution(worktreePath, issueNumber, worktreeGitContent);
    }

    private handleTaskError(params: {
        error: Error; executionTime: number;
        issueRef: AgentTaskOptions['issueRef']; repo: string;
        effectiveModel: string | undefined;
    }): AgentExecutionResult {
        const { error, executionTime, issueRef, repo, effectiveModel } = params;
        logger.error({
            issueNumber: issueRef.number, repository: repo,
            executionTime, error: error.message, agentAlias: this.config.alias
        }, 'Error during Codex agent execution');

        return {
            success: false, error: error.message, executionTimeMs: executionTime,
            logs: (error as unknown as { stderr?: string }).stderr || error.message,
            modifiedFiles: [], commitMessage: null, summary: undefined,
            modelUsed: effectiveModel || 'unknown'
        };
    }

    async analyze(prompt: string, options?: AnalyzeOptions): Promise<AnalysisResult> {
        const { context, model, taskId, taskNumber, prNumber, executionType, correlationId, repository, metadata, timeoutMs, responseFormat = 'text', reasoningLevel, suppressLlmLog } = options || {};
        const startTime = Date.now();
        const effectiveModel = model || this.config.defaultModel || 'unknown';

        logger.info({
            agentAlias: this.config.alias, promptLength: prompt.length,
            hasContext: !!context, requestedModel: model, taskId, executionType
        }, 'Running lightweight analysis via Codex agent...');

        const suffix = responseFormat === 'json'
            ? '\n\nCRITICAL: Do not modify any files. Do not run any commands. Return only valid JSON matching the requested schema. Do not include markdown or explanatory text.'
            : '\n\nCRITICAL: Do not modify any files. Do not run any commands. Only provide your analysis as plain text output.';
        const analysisPrompt = context ? `${prompt}\n\nContext:\n${context}${suffix}` : `${prompt}${suffix}`;
        const analysisWorkspace = this.ensureAnalysisWorkspace();

        try {
            const dockerArgs = this.buildDockerArgs({
                worktreePath: analysisWorkspace,
                githubToken: process.env.GITHUB_TOKEN || '',
                modelName: effectiveModel === 'unknown' ? undefined : effectiveModel,
                issueNumber: 0, jsonOutput: true, taskId, executionType,
                reasoningLevel: await this.resolveEffectiveReasoningLevel(reasoningLevel)
            });

            const { result, usageMetrics } = await executeWithUsageTracking(
                'codex',
                async () => executeDockerCommand('docker', dockerArgs, {
                    timeout: timeoutMs ?? 1800000, stdinData: analysisPrompt, taskId
                }),
                ANALYSIS_AGENT_TANK_TIMEOUT_MS
            );

            const executionTimeMs = Date.now() - startTime;
            const parsedOutput = parseCodexStreamOutput(result.stdout);

            if (result.exitCode === 0 || parsedOutput.result) {
                return this.buildAnalysisSuccess({ parsedOutput, effectiveModel, executionTimeMs, usageMetrics, executionType, taskId, taskNumber, prNumber, correlationId, repository, metadata, suppressLlmLog });
            }

            const errorMsg = parsedOutput.error || result.stderr || 'No result returned';
            return { response: '', modelUsed: effectiveModel, executionTimeMs, success: false, error: `Analysis failed: ${errorMsg}` };
        } catch (error) {
            const executionTimeMs = Date.now() - startTime;
            const err = error as Error;
            logger.error({ agentAlias: this.config.alias, error: err.message, executionTimeMs }, 'Lightweight analysis failed');
            return { response: '', modelUsed: effectiveModel, executionTimeMs, success: false, error: err.message };
        }
    }

    /**
     * Ensures the analysis workspace directory exists as a git repo writable by the container node user.
     */
    private ensureAnalysisWorkspace(): string {
        const workspace = '/tmp/codex-analysis';
        try {
            if (!fs.existsSync(workspace)) fs.mkdirSync(workspace, { recursive: true });
            if (!fs.existsSync(`${workspace}/.git`)) {
                execSync('git init', { cwd: workspace, stdio: 'pipe' });
                execSync('git config user.email "codex@propr.dev"', { cwd: workspace, stdio: 'pipe' });
                execSync('git config user.name "Codex Analysis"', { cwd: workspace, stdio: 'pipe' });
            }
            execSync(`chown -R 1000:1000 ${workspace}`, { stdio: 'pipe' });
        } catch (initError) {
            logger.warn({ error: (initError as Error).message }, 'Failed to initialize analysis workspace git repo');
        }
        return workspace;
    }

    /**
     * Builds a successful AnalysisResult from parsed output, logging and persisting the LLM log.
     */
    private async buildAnalysisSuccess(opts: {
        parsedOutput: ReturnType<typeof parseCodexStreamOutput>;
        effectiveModel: string; executionTimeMs: number;
        usageMetrics: Awaited<ReturnType<typeof executeWithUsageTracking>>['usageMetrics'];
        executionType?: string; taskId?: string; taskNumber?: number; prNumber?: number;
        correlationId?: string; repository?: string; metadata?: Record<string, unknown>;
        suppressLlmLog?: boolean;
    }): Promise<AnalysisResult> {
        const { parsedOutput, effectiveModel, executionTimeMs, usageMetrics, executionType, taskId, taskNumber, prNumber, correlationId, repository, metadata, suppressLlmLog } = opts;
        const analysisText = (parsedOutput.result || '').trim();
        logger.info({
            agentAlias: this.config.alias, responseLength: analysisText.length,
            model: effectiveModel, executionTimeMs,
            inputTokens: parsedOutput.tokenUsage?.input_tokens,
            outputTokens: parsedOutput.tokenUsage?.output_tokens,
            usageMetrics: usageMetrics ? { delta: usageMetrics.delta } : null
        }, 'Lightweight analysis completed');

        if (!suppressLlmLog) {
            await persistLlmLog(createLlmLogFromAnalysis({
                executionType: (executionType || 'other') as ExecutionType,
                modelUsed: parsedOutput.model || effectiveModel, executionTimeMs,
                success: true, tokenUsage: parsedOutput.tokenUsage,
                sessionId: parsedOutput.sessionId, draftId: taskId,
                correlationId, repository, metadata,
                agentAlias: this.config.alias,
                ...this.formatUsageMetrics(usageMetrics),
                workRef: buildAnalysisWorkRef(executionType, taskId, repository, { taskNumber, prNumber }),
            }));
        }

        return {
            response: analysisText, modelUsed: parsedOutput.model || effectiveModel,
            executionTimeMs, success: true,
            tokenUsage: parsedOutput.tokenUsage, sessionId: parsedOutput.sessionId
        };
    }

    /**
     * Formats Agent Tank usage metrics into the shape expected by createLlmLogFromAnalysis.
     */
    private formatUsageMetrics(usageMetrics: Awaited<ReturnType<typeof executeWithUsageTracking>>['usageMetrics']) {
        if (!usageMetrics) return {};
        return {
            usageMetrics: {
                preCall: usageMetrics.preCall, postCall: usageMetrics.postCall,
                delta: usageMetrics.delta, timestamp: usageMetrics.timestamp,
                agent: usageMetrics.agent
            },
            usageMetricRecords: usageMetrics.records
        };
    }

    private async resolveEffectiveReasoningLevel(reasoningLevel?: ModelReasoningLevel): Promise<CodexRuntimeReasoningLevel | ''> {
        const configuredLevel = reasoningLevel === undefined ? await loadModelReasoningLevel() : reasoningLevel;
        const runtimeLevel = resolveCodexReasoningLevel(configuredLevel) ?? '';
        assertReasoningLevelCliVersionSupported({
            agentType: 'codex',
            agentAlias: this.config.alias,
            cliVersion: this.config.cliVersionResolved ?? AGENT_DEFAULT_VERSIONS.codex,
            reasoningLevel: runtimeLevel
        });
        return runtimeLevel;
    }

    async healthCheck(): Promise<boolean> {
        const { alias: agentAlias } = this.config;
        const dockerImage = this.config.dockerImage;
        logger.debug({ agentAlias, dockerImage }, 'Running health check for Codex agent...');
        try {
            const result = await executeDockerCommand('docker', ['images', '-q', dockerImage], { timeout: 10000 });
            const imageExists = !!result.stdout.trim();
            logger.info({ agentAlias, dockerImage, imageExists }, imageExists ? 'Health check passed' : 'Health check failed: Docker image not found');
            return imageExists;
        } catch (error) {
            logger.error({ agentAlias, error: (error as Error).message }, 'Health check failed with error');
            return false;
        }
    }

    /**
     * Builds Docker arguments for running Codex in a container.
     */
    private buildDockerArgs(params: {
        worktreePath: string;
        githubToken: string;
        modelName?: string;
        issueNumber: number;
        jsonOutput?: boolean;
        environment?: Record<string, string>;
        taskId?: string;
        executionType?: string;
        reasoningLevel?: CodexRuntimeReasoningLevel | '';
    }): string[] {
        const {
            worktreePath,
            githubToken,
            modelName,
            issueNumber,
            jsonOutput = true,
            environment,
            taskId,
            executionType,
            reasoningLevel
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
        if (environment) {
            for (const [key, value] of Object.entries(environment)) {
                envVars.push('-e', `${key}=${value}`);
            }
        }

        // Generate human-readable container name
        const timestamp = Date.now().toString(36);
        const shortTaskId = taskId ? taskId.slice(-8) : timestamp;
        const taskType = executionType || (issueNumber === 0 ? 'analysis' : `issue-${issueNumber}`);
        const containerName = `${this.config.alias || 'codex'}-${taskType}-${shortTaskId}`;

        // Build Docker run arguments
        // Note: Start as root so entrypoint can fix volume permissions, then drops to node user
        // This matches the Claude agent pattern for consistent security handling
        const dockerArgs: string[] = [
            'run', '--rm',
            '-i', // Allow stdin for piping prompt
            '--name', containerName,
            '--security-opt', 'no-new-privileges',
            // Docker's default seccomp profile often blocks the namespace syscalls
            // bubblewrap needs inside the container.
            '--security-opt', 'seccomp=unconfined',
            // Ubuntu/Debian hosts often apply an AppArmor profile that blocks
            // the user namespace and mount operations bubblewrap needs.
            '--security-opt', 'apparmor=unconfined',
            '--cap-add', 'CHOWN',
            '--network', 'bridge',
            '--user', '0:0', // Start as root; entrypoint drops to node after permission fixes
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
            ...(jsonOutput ? ['--json'] : []), // Output NDJSON events (for task execution) or plain text (for analysis)
            '--dangerously-bypass-approvals-and-sandbox', // Docker is the outer isolation boundary on this host
            '--config', 'features.multi_agent=false', // Nested Codex subagents fail under Docker on this host
            ...(reasoningLevel ? ['--config', `model_reasoning_effort="${reasoningLevel}"`] : []),
            '--skip-git-repo-check',     // Allow running outside git repos (for analysis workspace)
            '--cd', '/home/node/workspace', // Set working directory
            '-'                          // Read prompt from stdin
        ];

        // Add model if specified
        if (modelName) {
            // Strip agent prefix if present (e.g., "codex:gpt-5.4" -> "gpt-5.4")
            const cleanModelName = modelName.includes(':') ? modelName.split(':').pop()! : modelName;
            const codexIndex = dockerArgs.indexOf('codex');
            dockerArgs.splice(codexIndex + 2, 0, '--model', cleanModelName);
            logger.info({ issueNumber, requestedModel: cleanModelName, agentAlias: this.config.alias }, 'Using specific model for Codex agent execution');
        } else {
            logger.debug({ issueNumber, agentAlias: this.config.alias }, 'No model specified, Codex agent will use default');
        }
        logger.info({ issueNumber, agentAlias: this.config.alias }, 'Docker args built for Codex agent');

        return wrapDockerRunArgsWithRepoSetup(dockerArgs, dockerImage, 'codex');
    }
}
