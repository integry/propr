import { buildAgentGitCredentialArgs, buildAgentGitMountArgs } from '../agents/agentGitAccess.js';
import logger from '../utils/logger.js';
import { createContainerExecutionId } from '../agents/impl/utils/containerExecutionId.js';
import { AgentRunSpecBuilder, agentRunNetwork } from '../agents/runtime/agentRunSpec.js';
import type { AgentRunSpec } from '../agents/runtime/types.js';
import { applyAgentRunLaunchWrapper } from './docker/repoSetupWrapper.js';
import { addClaudeConfigSeed } from './docker/claudeConfigSeed.js';
import type { DockerArgsParams } from './claudeHelpers.js';

/** The ENV-configured Claude run used by the legacy Claude service. */
export function buildClaudeServiceRunSpec(params: DockerArgsParams): AgentRunSpec {
    const { worktreePath, githubToken, modelName, issueNumber, CLAUDE_DOCKER_IMAGE, CLAUDE_CONFIG_PATH, CLAUDE_MAX_TURNS, systemPrompt, tools, taskId, agentAlias } = params;

    // Generate human-readable container name with unique suffix
    // TaskId format: {repo}-{issue}-{agent}-{model}-{correlationId}
    // Use the LAST 8 chars of taskId (part of correlationId UUID) for uniqueness
    const shortId = createContainerExecutionId(taskId);
    const containerName = `${agentAlias || 'claude'}-issue-${issueNumber}-${shortId}`;

    // Always use stdin for prompt to avoid E2BIG errors with large prompts
    const builder = new AgentRunSpecBuilder({
        agentType: 'claude', image: CLAUDE_DOCKER_IMAGE, ...(agentAlias ? { alias: agentAlias } : {}), name: containerName,
        stdin: true, user: '0:0', network: agentRunNetwork('bridge'), security: { capAdd: ['CHOWN'] },
        workspace: { hostPath: worktreePath, containerPath: '/home/node/workspace', readOnly: false },
    }).workspaceMount()
        .dockerOptions(params.gitMountArgs ?? buildAgentGitMountArgs(worktreePath), 'git')
        .dockerOptions(buildAgentGitCredentialArgs(), 'credential')
        .bind('/tmp/claude-logs', '/tmp/claude-logs', false, 'logs')
        .credentialBind(CLAUDE_CONFIG_PATH, '/home/node/.claude', false, { provider: 'claude', store: 'config', perRun: true });
    addClaudeConfigSeed(builder)
        .env('GH_TOKEN', githubToken)
        .command(
            'claude', '-p', '-', // Read prompt from stdin
            '--no-session-persistence',
            '--max-turns', CLAUDE_MAX_TURNS.toString(),
            '--output-format', 'stream-json',
            '--verbose',
            '--dangerously-skip-permissions'
        );
    const cliArgs = builder.spec.args;

    if (modelName) {
        cliArgs.splice(cliArgs.indexOf('--max-turns'), 0, '--model', modelName);
        logger.info({ issueNumber, requestedModel: modelName }, 'Using specific model for Claude Code execution');
    } else {
        logger.debug({ issueNumber }, 'No model specified, Claude Code will use default');
    }

    if (systemPrompt !== undefined) {
        cliArgs.push('--system-prompt', systemPrompt);
        logger.info({ issueNumber, systemPromptLength: systemPrompt.length }, 'Using custom system prompt');
    }

    if (tools !== undefined) {
        cliArgs.push('--tools', tools);
        logger.info({ issueNumber, tools }, 'Using custom tools configuration');
    }

    logger.info({ issueNumber, hasSystemPrompt: systemPrompt !== undefined, hasTools: tools !== undefined }, 'Docker args built');

    return applyAgentRunLaunchWrapper(builder.build(), 'claude');
}
