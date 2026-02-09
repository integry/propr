/**
 * Docker arguments builder for Claude agent execution.
 *
 * This module handles the construction of Docker command-line arguments
 * for running Claude in a container with proper configuration.
 */

import path from 'path';
import os from 'os';
import fs from 'fs';
import logger from '../../../utils/logger.js';
import { AgentConfig } from '../../types.js';
import { resolveConfigPath } from '../../../config/configManager.js';

/**
 * Parameters for building Docker arguments.
 */
export interface DockerArgsParams {
    /** Path to the git worktree */
    worktreePath: string;
    /** GitHub token for API access */
    githubToken: string;
    /** Optional model name to use */
    modelName?: string;
    /** Issue number (for logging) */
    issueNumber: number;
    /** Optional custom system prompt */
    systemPrompt?: string;
    /** Optional tools configuration */
    tools?: string;
}

/**
 * Builds Docker arguments for running Claude in a container.
 *
 * This function constructs the full `docker run` command arguments including:
 * - Security options (no-new-privileges, limited capabilities)
 * - Volume mounts (worktree, config, logs)
 * - Environment variables
 * - Claude CLI options (model, max-turns, output format)
 *
 * @param config - Agent configuration containing Docker image and env vars
 * @param maxTurns - Maximum number of conversation turns
 * @param params - Parameters for Docker execution
 * @returns Array of Docker command-line arguments
 */
export function buildDockerArgs(
    config: AgentConfig,
    maxTurns: number,
    params: DockerArgsParams
): string[] {
    const { worktreePath, githubToken, modelName, issueNumber, systemPrompt, tools } = params;
    const configPath = resolveConfigPath(config.configPath);

    // Build environment variable arguments
    const envVars: string[] = [];
    if (config.envVars) {
        for (const [key, value] of Object.entries(config.envVars)) {
            envVars.push('-e', `${key}=${value}`);
        }
    }

    // Check if .claude.json exists in home directory
    const claudeJsonPath = path.join(os.homedir(), '.claude.json');
    const claudeJsonMount = fs.existsSync(claudeJsonPath)
        ? ['-v', `${claudeJsonPath}:/home/node/.claude.json:rw`]
        : [];

    // Build base Docker arguments
    const dockerArgs: string[] = [
        'run', '--rm', '-i',
        '--security-opt', 'no-new-privileges',
        '--cap-add', 'CHOWN',
        '--network', 'bridge',
        '--user', '0:0',
        // Volume mounts
        '-v', `${worktreePath}:/home/node/workspace:rw`,
        '-v', '/tmp/git-processor:/tmp/git-processor:rw',
        '-v', '/tmp/claude-logs:/tmp/claude-logs:rw',
        '-v', `${configPath}:/home/node/.claude:rw`,
        ...claudeJsonMount,
        // Environment variables
        '-e', `GH_TOKEN=${githubToken}`,
        ...envVars,
        // Working directory
        '-w', '/home/node/workspace',
        // Docker image
        config.dockerImage,
        // Claude CLI command
        'claude', '-p', '-',
        '--max-turns', maxTurns.toString(),
        '--output-format', 'stream-json',
        '--verbose',
        '--dangerously-skip-permissions'
    ];

    // Add model parameter if specified
    if (modelName) {
        const maxTurnsIndex = dockerArgs.indexOf('--max-turns');
        dockerArgs.splice(maxTurnsIndex, 0, '--model', modelName);
        logger.info({
            issueNumber,
            requestedModel: modelName,
            agentAlias: config.alias
        }, 'Using specific model for Claude agent execution');
    } else {
        logger.debug({
            issueNumber,
            agentAlias: config.alias
        }, 'No model specified, Claude agent will use default');
    }

    // Add optional system prompt
    if (systemPrompt !== undefined) {
        dockerArgs.push('--system-prompt', systemPrompt);
        logger.info({
            issueNumber,
            systemPromptLength: systemPrompt.length,
            agentAlias: config.alias
        }, 'Using custom system prompt');
    }

    // Add optional tools configuration
    if (tools !== undefined) {
        dockerArgs.push('--tools', tools);
        logger.info({
            issueNumber,
            tools,
            agentAlias: config.alias
        }, 'Using custom tools configuration');
    }

    logger.info({
        issueNumber,
        hasSystemPrompt: systemPrompt !== undefined,
        hasTools: tools !== undefined,
        agentAlias: config.alias
    }, 'Docker args built for Claude agent');

    return dockerArgs;
}
