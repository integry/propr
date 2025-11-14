import path from 'path';
import os from 'os';
import fs from 'fs';
import Anthropic from '@anthropic-ai/sdk';
import logger from '../utils/logger.js';
import { handleError } from '../utils/errorHandler.js';
import { getDefaultModel, resolveModelAlias } from '../config/modelAliases.js';
import { generateClaudePrompt, generateTaskImportPrompt } from './prompts/promptGenerator.js';
import { executeDockerCommand, buildClaudeDockerImage as buildDockerImageInternal } from './docker/dockerExecutor.js';

// Configuration from environment variables
const CLAUDE_DOCKER_IMAGE = process.env.CLAUDE_DOCKER_IMAGE || 'claude-code-processor:latest';
const CLAUDE_CONFIG_PATH = process.env.CLAUDE_CONFIG_PATH || path.join(os.homedir(), '.claude');
const CLAUDE_MAX_TURNS = parseInt(process.env.CLAUDE_MAX_TURNS || '1000', 10);
const CLAUDE_TIMEOUT_MS = parseInt(process.env.CLAUDE_TIMEOUT_MS || '300000', 10); // 5 minutes

/**
 * Custom error for Claude usage limits.
 * This allows the worker to catch this specific error and requeue the job.
 */
export class UsageLimitError extends Error {
  constructor(message, resetTimestamp) {
    super(message);
    this.name = 'UsageLimitError';
    this.resetTimestamp = resetTimestamp; // UNIX timestamp (seconds)
    this.retryable = true;
  }
}


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
export async function executeClaudeCode({ worktreePath, issueRef, githubToken, customPrompt, isRetry = false, retryReason, branchName, modelName, issueDetails, onSessionId, onContainerId }) {
    const startTime = Date.now();

    logger.info({
        issueNumber: issueRef.number,
        repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
        worktreePath,
        dockerImage: CLAUDE_DOCKER_IMAGE,
        isRetry,
        retryReason
    }, isRetry ? 'Starting Claude Code execution (RETRY)...' : 'Starting Claude Code execution...');

    let worktreeGitContent = null;
    let mainRepoPath = null;

    try {
        // Generate the prompt for Claude
        const basePrompt = customPrompt || generateClaudePrompt(issueRef, branchName, modelName, issueDetails);

        // Add critical safety instructions to prevent git repository corruption
        const prompt = `${basePrompt}

**CRITICAL GIT SAFETY RULES:**
- NEVER run 'rm .git' or delete the .git file/directory
- NEVER run 'git init' in the workspace - this is already a git repository
- If you encounter git errors, report them but DO NOT attempt to reinitialize the repository
- The workspace is a git worktree linked to the main repository
- Only make changes to the specific files mentioned in the issue/request
- If git commands fail, describe the error but do not try destructive recovery methods
- NOTE: You may encounter permission errors when trying to commit - this is expected
- The system will automatically commit your changes after you complete the modifications`;

        logger.debug({
            issueNumber: issueRef.number,
            promptLength: prompt.length,
            hasSafetyRules: prompt.includes('CRITICAL GIT SAFETY RULES'),
            isCustomPrompt: !!customPrompt
        }, 'Generated Claude prompt with safety rules');

        if (isRetry) {
            logger.info({
                issueNumber: issueRef.number,
                retryReason,
                promptLength: prompt.length
            }, 'Using enhanced prompt for retry execution');
        }

        // Ensure worktree files are owned by UID 1000 (node user in container)
        try {
            await executeDockerCommand('sudo', ['chown', '-R', '1000:1000', worktreePath], {
                timeout: 10000 // 10 seconds should be enough
            });
            logger.debug({
                issueNumber: issueRef.number,
                worktreePath
            }, 'Set worktree ownership to UID 1000 for container compatibility');
        } catch (chownError) {
            logger.warn({
                issueNumber: issueRef.number,
                worktreePath,
                error: chownError.message
            }, 'Failed to set worktree ownership - container may have permission issues');
        }

        // No longer need temporary Claude config directory as we mount directly
        // This entire block can be removed since we're using direct mount approach

            // Verify worktree .git file before Docker execution
            const worktreeGitPath = path.join(worktreePath, '.git');

            try {
                if (fs.existsSync(worktreeGitPath)) {
                    const stats = fs.statSync(worktreeGitPath);
                    if (stats.isFile()) {
                        worktreeGitContent = fs.readFileSync(worktreeGitPath, 'utf8').trim();
                        const gitdirMatch = worktreeGitContent.match(/gitdir:\s*(.+)/);
                        if (gitdirMatch) {
                            mainRepoPath = gitdirMatch[1].trim();
                        }
                        logger.debug({
                            issueNumber: issueRef.number,
                            worktreeGitPath,
                            worktreeGitContent,
                            mainRepoPath,
                            mainRepoExists: mainRepoPath ? fs.existsSync(mainRepoPath) : false
                        }, 'Verified worktree .git file structure');
                    } else {
                        logger.error({
                            issueNumber: issueRef.number,
                            worktreeGitPath,
                            isDirectory: stats.isDirectory()
                        }, 'CRITICAL: Worktree .git is a directory, not a file! This will cause git init disasters');
                    }
                } else {
                    logger.warn({
                        issueNumber: issueRef.number,
                        worktreeGitPath
                    }, 'Worktree .git file not found - this may cause issues');
                }
            } catch (verifyError) {
                logger.error({
                    issueNumber: issueRef.number,
                    error: verifyError.message
                }, 'Failed to verify worktree structure');
            }

        // Construct Docker run command
        const dockerArgs = [
            'run',
            '--rm',
            '--security-opt', 'no-new-privileges',
            // Remove cap-drop ALL to allow chown
            '--cap-add', 'CHOWN',
            '--network', 'bridge', // Restrict network access

            // Run as root initially to fix permissions, then drop to node user
            '--user', '0:0',

            // Mount the worktree as the workspace with proper ownership
            '-v', `${worktreePath}:/home/node/workspace:rw`,

            // Mount the git-processor base directory that contains both clones and worktrees
            // This ensures worktree .git files can reference the main repository
            '-v', '/tmp/git-processor:/tmp/git-processor:rw',

            // Mount the claude-logs directory for log persistence across containers
            '-v', '/tmp/claude-logs:/tmp/claude-logs:rw',

            // Mount the actual Claude config directory directly (read-write so Claude can create project dirs)
            '-v', `${CLAUDE_CONFIG_PATH}:/home/node/.claude:rw`,
            // Also mount .claude.json if it exists
            ...(fs.existsSync(path.join(os.homedir(), '.claude.json')) ?
                ['-v', `${path.join(os.homedir(), '.claude.json')}:/home/node/.claude.json:rw`] : []),

            // Pass GitHub token as environment variable
            '-e', `GH_TOKEN=${githubToken}`,

            // Set working directory
            '-w', '/home/node/workspace',

            // Use the Claude Code Docker image
            CLAUDE_DOCKER_IMAGE,

            // Execute Claude Code CLI with the generated prompt
            'claude',
            '-p', prompt,
            '--max-turns', CLAUDE_MAX_TURNS.toString(),
            '--output-format', 'stream-json',
            '--verbose',
            '--dangerously-skip-permissions'
        ];

        // Add model specification if provided
        if (modelName) {
            dockerArgs.splice(-6, 0, '--model', modelName);
            logger.info({
                issueNumber: issueRef.number,
                requestedModel: modelName
            }, 'Using specific model for Claude Code execution');
        } else {
            logger.debug({
                issueNumber: issueRef.number
            }, 'No model specified, Claude Code will use default');
        }

        // Log Docker mount details for debugging
        const mounts = [];
        for (let i = 0; i < dockerArgs.length; i++) {
            if (dockerArgs[i] === '-v' && i + 1 < dockerArgs.length) {
                const [source, dest] = dockerArgs[i + 1].split(':');
                mounts.push({
                    source,
                    destination: dest,
                    sourceExists: fs.existsSync(source),
                    sourceType: fs.existsSync(source) ? (fs.statSync(source).isDirectory() ? 'directory' : 'file') : 'missing'
                });
            }
        }

        logger.debug({
            issueNumber: issueRef.number,
            dockerArgs: dockerArgs, // Show full command
            mounts,
            workDir: '/home/node/workspace',
            modelName: modelName || 'default',
            promptLength: prompt.length,
            promptPreview: prompt.substring(0, 200) + '...'
        }, 'Executing Docker command for Claude Code with detailed mount info');

        // Execute Docker command
        const result = await executeDockerCommand('docker', dockerArgs, {
            timeout: CLAUDE_TIMEOUT_MS,
            cwd: worktreePath,
            onSessionId,
            onContainerId,
            worktreePath
        });

        const executionTime = Date.now() - startTime;

        // No cleanup needed since we're using direct mount approach

        logger.info({
            issueNumber: issueRef.number,
            repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
            executionTime,
            outputLength: result.stdout?.length || 0,
            success: result.exitCode === 0,
            exitCode: result.exitCode,
            fullStdout: result.stdout,
            fullStderr: result.stderr
        }, 'Claude Code execution completed');

        // Parse Claude's stream-json output
        let claudeOutput = {
            success: result.exitCode === 0,
            rawOutput: result.stdout,
            error: result.stderr,
            conversationLog: [],
            sessionId: null,
            finalResult: null
        };

        // Parse stream-json output line by line
        if (result.stdout) {
            const lines = result.stdout.split('\n').filter(line => line.trim());
            for (const line of lines) {
                try {
                    const jsonLine = JSON.parse(line);

                    // Collect conversation messages with timestamps
                    if (jsonLine.type === 'user' || jsonLine.type === 'assistant') {
                        // Look up timestamp captured during streaming
                        const messageKey = jsonLine.message?.id ||
                            `${jsonLine.type}-${JSON.stringify(jsonLine).substring(0, 100)}`;
                        const timestamp = result.messageTimestamps?.get(messageKey);

                        claudeOutput.conversationLog.push({
                            ...jsonLine,
                            timestamp: timestamp || new Date().toISOString() // Use captured timestamp or fallback
                        });

                        // Extract model from assistant messages
                        if (jsonLine.type === 'assistant' && jsonLine.message?.model) {
                            claudeOutput.model = jsonLine.message.model;
                        }
                    }

                    // Extract session ID
                    if (jsonLine.session_id) {
                        claudeOutput.sessionId = jsonLine.session_id;
                    }

                    // Extract conversation ID if available
                    if (jsonLine.conversation_id) {
                        claudeOutput.conversationId = jsonLine.conversation_id;
                    }

                    // Extract model information if available
                    if (jsonLine.model) {
                        claudeOutput.model = jsonLine.model;
                    }

                    // Extract final result
                    if (jsonLine.type === 'result') {
                        claudeOutput.finalResult = jsonLine;
                        claudeOutput.success = !jsonLine.is_error;

                        // CRITICAL: Check for Usage Limit error provided in the result stream
                        if (jsonLine.result) {
                            const limitMatch = jsonLine.result.match(/Claude AI usage limit reached\|(\d+)/);
                            if (limitMatch && limitMatch[1]) {
                                const resetTimestamp = parseInt(limitMatch[1], 10);
                                logger.warn({ resetTimestamp }, 'Claude usage limit reached. Throwing specific error for requeue.');
                                throw new UsageLimitError(
                                    `Claude usage limit reached. Limit resets at timestamp ${resetTimestamp}.`,
                                    resetTimestamp
                                );
                            }
                        }
                        
                        // Standardize cost field
                        if (jsonLine.total_cost_usd && !jsonLine.cost_usd) {
                            claudeOutput.finalResult.cost_usd = jsonLine.total_cost_usd;
                        }
                        
                        // Also check for model info in final result
                        if (jsonLine.model) {
                            claudeOutput.model = jsonLine.model;
                        }
                        if (jsonLine.conversation_id) {
                            claudeOutput.conversationId = jsonLine.conversation_id;
                        }
                    }
                } catch (parseError) {
                    // Skip non-JSON lines (like entrypoint output)
                    continue;
                }
            }
        }

        // Extract key information from Claude's response
        const response = {
            success: claudeOutput.success,
            executionTime,
            output: claudeOutput,
            logs: result.stderr || '',
            exitCode: result.exitCode,
            rawOutput: result.stdout,

            // Extract conversation and session info
            conversationLog: claudeOutput.conversationLog || [],
            sessionId: claudeOutput.sessionId,
            conversationId: claudeOutput.conversationId,
            model: claudeOutput.model || process.env.CLAUDE_MODEL || getDefaultModel(), // Default to current Sonnet
            finalResult: claudeOutput.finalResult,

            // Extract specific fields if available in Claude's structured output
            modifiedFiles: [], // Will be determined by file system inspection
            commitMessage: null, // Will be extracted from conversation if present
            summary: claudeOutput.finalResult?.result || null,
            
            // Include the prompt for debugging and display
            prompt: prompt
        };
        
        // Store the prompt in Redis with execution identifiers for later retrieval
        if (claudeOutput.sessionId || claudeOutput.conversationId) {
            try {
                const Redis = await import('ioredis');
                const redis = new Redis.default({
                    host: process.env.REDIS_HOST || 'redis',
                    port: process.env.REDIS_PORT || 6379
                });
                
                // Store prompt with multiple keys for flexible retrieval
                const promptData = {
                    prompt: prompt,
                    timestamp: new Date().toISOString(),
                    issueRef: issueRef,
                    sessionId: claudeOutput.sessionId,
                    conversationId: claudeOutput.conversationId,
                    model: response.model,
                    isRetry: isRetry,
                    retryReason: retryReason
                };
                
                const promptKeys = [];
                
                // Key by sessionId (most unique)
                if (claudeOutput.sessionId) {
                    const sessionKey = `execution:prompt:session:${claudeOutput.sessionId}`;
                    await redis.set(sessionKey, JSON.stringify(promptData), 'EX', 86400 * 30); // 30 days
                    promptKeys.push(sessionKey);
                }
                
                // Key by conversationId
                if (claudeOutput.conversationId) {
                    const conversationKey = `execution:prompt:conversation:${claudeOutput.conversationId}`;
                    await redis.set(conversationKey, JSON.stringify(promptData), 'EX', 86400 * 30);
                    promptKeys.push(conversationKey);
                }
                
                // Also store by issue/timestamp for listing all executions
                const timestamp = Date.now();
                const issueKey = `execution:prompt:issue:${issueRef.repoOwner}:${issueRef.repoName}:${issueRef.number}:${timestamp}`;
                await redis.set(issueKey, JSON.stringify(promptData), 'EX', 86400 * 30);
                promptKeys.push(issueKey);
                
                logger.info({
                    issueNumber: issueRef.number,
                    sessionId: claudeOutput.sessionId,
                    conversationId: claudeOutput.conversationId,
                    promptKeys: promptKeys,
                    promptLength: prompt.length
                }, 'Stored execution prompt in Redis with unique identifiers');
                
                await redis.quit();
            } catch (redisError) {
                logger.warn({
                    issueNumber: issueRef.number,
                    error: redisError.message
                }, 'Failed to store execution prompt in Redis - continuing');
            }
        }

        if (!response.success) {
            logger.error({
                issueNumber: issueRef.number,
                exitCode: result.exitCode,
                stderr: result.stderr,
                stdout: result.stdout
            }, 'Claude Code execution failed');
        } else {
            logger.info({
                issueNumber: issueRef.number,
                exitCode: result.exitCode,
                stderrLength: result.stderr?.length || 0,
                stdoutLength: result.stdout?.length || 0,
                hasConversationLog: !!response.conversationLog?.length,
                conversationTurns: response.conversationLog?.length || 0,
                model: response.model,
                summary: response.summary?.substring(0, 200)
            }, 'Claude Code execution succeeded');

            // Verify worktree state after execution
            try {
                const postExecGitPath = path.join(worktreePath, '.git');
                if (fs.existsSync(postExecGitPath)) {
                    const postStats = fs.statSync(postExecGitPath);
                    const isNowDirectory = postStats.isDirectory();

                    if (isNowDirectory) {
                        logger.error({
                            issueNumber: issueRef.number,
                            worktreePath,
                            preExecType: worktreeGitContent ? 'file' : 'unknown',
                            postExecType: 'directory'
                        }, 'CRITICAL: Worktree .git was converted from file to directory! Claude may have run git init');

                        // Check for signs of git init
                        const gitConfigPath = path.join(postExecGitPath, 'config');
                        if (fs.existsSync(gitConfigPath)) {
                            const gitConfig = fs.readFileSync(gitConfigPath, 'utf8');
                            logger.error({
                                issueNumber: issueRef.number,
                                gitConfigPreview: gitConfig.substring(0, 200)
                            }, 'Found git config in new .git directory - git init was definitely run');
                        }
                    } else {
                        const postContent = fs.readFileSync(postExecGitPath, 'utf8').trim();
                        if (postContent !== worktreeGitContent) {
                            logger.warn({
                                issueNumber: issueRef.number,
                                preContent: worktreeGitContent,
                                postContent: postContent
                            }, 'Worktree .git file content changed during execution');
                        }
                    }
                }
            } catch (postVerifyError) {
                logger.error({
                    issueNumber: issueRef.number,
                    error: postVerifyError.message
                }, 'Failed to verify worktree state after execution');
            }
        }

        return response;

    } catch (error) {
        const executionTime = Date.now() - startTime;

        logger.error({
            issueNumber: issueRef.number,
            repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
            executionTime,
            error: error.message,
            stack: error.stack
        }, 'Error during Claude Code execution');

        return {
            success: false,
            error: error.message,
            executionTime,
            output: null,
            logs: error.stderr || error.message
        };
    } finally {
        // Cleanup moved to after Docker execution completes
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
export async function generateTaskSummary(summaryRequest, worktreePath, githubToken, issueRef, correlationId, modelAlias = 'haiku') {
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

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
});

export async function runLightweightLLMAnalysis(prompt, model, correlationId, worktreePath, githubToken, issueRef) {
  const correlatedLogger = logger.withCorrelation(correlationId);
  correlatedLogger.info({ model }, 'Running lightweight LLM analysis via Docker...');
  
  try {
    const analysisPrompt = `${prompt}

CRITICAL: Do not modify any files. Do not run any commands. Only provide your analysis as plain text output.`;

    const claudeResult = await executeClaudeCode({
      worktreePath: worktreePath,
      issueRef: issueRef,
      githubToken: githubToken,
      customPrompt: analysisPrompt,
      branchName: 'analysis-generation',
      modelName: model,
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
