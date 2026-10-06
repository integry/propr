import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    claudeToolPolicyArgs,
    codexToolPolicyArgs,
    promptOnlyToolPolicyNotice,
    withPromptOnlyToolPolicy,
    PROPR_MCP_BEARER_TOKEN_ENV,
    PROPR_MCP_SERVER_NAME,
} from '../packages/core/src/agents/agentToolPolicy.ts';
import { buildDockerArgs as buildClaudeDockerArgs } from '../packages/core/src/agents/impl/utils/dockerArgsBuilder.ts';
import { buildCodexDockerArgs } from '../packages/core/src/agents/impl/utils/codexDockerArgsBuilder.ts';
import { ClaudeAgent } from '../packages/core/src/agents/impl/ClaudeAgent.ts';
import { CodexAgent } from '../packages/core/src/agents/impl/CodexAgent.ts';
import { AntigravityAgent } from '../packages/core/src/agents/impl/AntigravityAgent.ts';
import { redactSecrets } from '../packages/core/src/utils/secretRedaction.ts';
import type { Agent, AgentConfig, AgentTaskOptions, AgentToolPolicy } from '../packages/core/src/agents/types.ts';
import { agentRunToolPolicy } from '../src/jobs/agentRuns/toolPolicy.ts';
import { closeConnection } from '../packages/core/src/db/connection.ts';

const TOKEN = 'propr_mcp_run_token_abcdef0123456789';
const MCP_POLICY: AgentToolPolicy = {
    allowWeb: false,
    mcpServers: [{ name: PROPR_MCP_SERVER_NAME, url: 'https://propr.example/mcp', bearerTokenEnv: PROPR_MCP_BEARER_TOKEN_ENV, bearerToken: TOKEN }],
};

const codexConfigPath = mkdtempSync(join(tmpdir(), 'propr-tool-policy-codex-'));
after(async () => {
    rmSync(codexConfigPath, { recursive: true, force: true });
    // The docker-args builders load modules that open the database.
    await closeConnection();
});

const claudeConfig: AgentConfig = {
    id: 'claude', type: 'claude', alias: 'claude', enabled: true,
    dockerImage: 'propr/agent:latest', configPath: '~/.claude',
    supportedModels: ['claude-opus-4-6'], defaultModel: 'claude-opus-4-6',
};
const codexConfig: AgentConfig = {
    id: 'codex', type: 'codex', alias: 'codex', enabled: true,
    dockerImage: 'propr/agent:latest', configPath: codexConfigPath,
    supportedModels: ['gpt-5.5'], defaultModel: 'gpt-5.5',
};
const baseParams = { worktreePath: '/tmp/worktree', githubToken: '', issueNumber: 42, taskId: 'task-1' };

/** Container names carry a random nonce; blank it so two builds compare equal. */
function withoutContainerName(args: string[]): string[] {
    return args.map((arg, index) => args[index - 1] === '--name' ? '<name>' : arg);
}

function hasSequence(args: string[], sequence: string[]): boolean {
    return args.some((_, index) => sequence.every((value, offset) => args[index + offset] === value));
}

describe('claudeToolPolicyArgs', () => {
    test('disallows the web tools when web is off', () => {
        assert.deepEqual(claudeToolPolicyArgs({ allowWeb: false }), {
            cliArgs: ['--disallowedTools', 'WebFetch', 'WebSearch'], env: {},
        });
    });

    test('adds nothing when web is allowed and there are no MCP servers', () => {
        assert.deepEqual(claudeToolPolicyArgs({ allowWeb: true }), { cliArgs: [], env: {} });
    });

    test('passes the MCP server inline with an env-expanded Authorization header', () => {
        const { cliArgs, env } = claudeToolPolicyArgs(MCP_POLICY);
        const configIndex = cliArgs.indexOf('--mcp-config');
        assert.ok(configIndex >= 0);
        assert.deepEqual(JSON.parse(cliArgs[configIndex + 1]), {
            mcpServers: {
                propr: {
                    type: 'http',
                    url: 'https://propr.example/mcp',
                    headers: { Authorization: `Bearer \${${PROPR_MCP_BEARER_TOKEN_ENV}}` },
                },
            },
        });
        assert.ok(!cliArgs.some(arg => arg.includes(TOKEN)));
        assert.deepEqual(env, { [PROPR_MCP_BEARER_TOKEN_ENV]: TOKEN });
    });

    test('rejects environment variable names that are not shell-safe', () => {
        assert.throws(() => claudeToolPolicyArgs({
            allowWeb: true,
            mcpServers: [{ name: 'propr', url: 'https://x', bearerTokenEnv: 'BAD=NAME', bearerToken: TOKEN }],
        }));
    });
});

describe('codexToolPolicyArgs', () => {
    test('turns off web search when web is off', () => {
        // The pinned Codex CLI ignores `tools.web_search=false`; see agentToolPolicyRuntime.test.ts.
        assert.deepEqual(codexToolPolicyArgs({ allowWeb: false }), { cliArgs: ['-c', 'web_search="disabled"'], env: {} });
    });

    test('configures the MCP server by URL and bearer token env var', () => {
        const { cliArgs, env } = codexToolPolicyArgs({ ...MCP_POLICY, allowWeb: true });
        assert.deepEqual(cliArgs, [
            '-c', 'mcp_servers.propr.url="https://propr.example/mcp"',
            '-c', `mcp_servers.propr.bearer_token_env_var="${PROPR_MCP_BEARER_TOKEN_ENV}"`,
        ]);
        assert.deepEqual(env, { [PROPR_MCP_BEARER_TOKEN_ENV]: TOKEN });
    });
});

describe('promptOnlyToolPolicyNotice', () => {
    test('only speaks when web is off', () => {
        assert.equal(promptOnlyToolPolicyNotice(undefined), '');
        assert.equal(promptOnlyToolPolicyNotice({ allowWeb: true }), '');
        assert.match(promptOnlyToolPolicyNotice({ allowWeb: false }), /web access is not allowed/);
    });

    test('appends the notice to the prompt and leaves it alone otherwise', () => {
        assert.equal(withPromptOnlyToolPolicy('Do it.', undefined), 'Do it.');
        assert.match(withPromptOnlyToolPolicy('Do it.', { allowWeb: false }), /^Do it\.\n\nTool policy/);
    });
});

describe('launcher integration', () => {
    test('Claude: no toolPolicy leaves the arguments unchanged', () => {
        const without = buildClaudeDockerArgs(claudeConfig, 100, baseParams);
        assert.ok(!without.includes('--disallowedTools'));
        assert.deepEqual(
            withoutContainerName(buildClaudeDockerArgs(claudeConfig, 100, { ...baseParams, toolPolicy: undefined })),
            withoutContainerName(without),
        );
    });

    test('Claude: web off and MCP add CLI switches and pass the token by name only', () => {
        const args = buildClaudeDockerArgs(claudeConfig, 100, { ...baseParams, toolPolicy: MCP_POLICY });
        assert.ok(hasSequence(args, ['--disallowedTools', 'WebFetch', 'WebSearch']));
        assert.ok(args.includes('--mcp-config'));
        assert.ok(hasSequence(args, ['-e', PROPR_MCP_BEARER_TOKEN_ENV]));
        assert.ok(!args.some(arg => arg.includes(TOKEN)));
    });

    test('Codex: no toolPolicy leaves the arguments unchanged', () => {
        const without = buildCodexDockerArgs(codexConfig, baseParams);
        assert.ok(!without.includes('web_search="disabled"'));
        assert.deepEqual(
            withoutContainerName(buildCodexDockerArgs(codexConfig, { ...baseParams, toolPolicy: undefined })),
            withoutContainerName(without),
        );
    });

    test('Codex: web off and MCP add -c overrides before the prompt and pass the token by name only', () => {
        const args = buildCodexDockerArgs(codexConfig, { ...baseParams, toolPolicy: MCP_POLICY });
        assert.ok(hasSequence(args, ['-c', 'web_search="disabled"']));
        assert.ok(args.includes('mcp_servers.propr.url="https://propr.example/mcp"'));
        assert.ok(hasSequence(args, ['-e', PROPR_MCP_BEARER_TOKEN_ENV]));
        assert.ok(!args.some(arg => arg.includes(TOKEN)));
        assert.ok(args.indexOf('web_search="disabled"') < args.lastIndexOf('-'));
    });
});

describe('goal mode', () => {
    const antigravityConfig: AgentConfig = {
        ...claudeConfig, id: 'antigravity', type: 'antigravity', alias: 'antigravity',
        supportedModels: ['gemini-3-pro'], defaultModel: 'gemini-3-pro',
    };
    const goalOptions = {
        worktreePath: '/tmp/worktree', issueRef: { number: 42, repoOwner: 'acme', repoName: 'widgets' },
        executionMode: 'goal', taskId: 'task-1', toolPolicy: MCP_POLICY,
    } as AgentTaskOptions;
    const agents: Array<[string, Agent]> = [
        ['Claude', new ClaudeAgent(claudeConfig)],
        ['Codex', new CodexAgent(codexConfig)],
        ['Antigravity', new AntigravityAgent(antigravityConfig)],
    ];

    for (const [name, agent] of agents) {
        test(`${name}: refuses a tool policy instead of launching an unrestricted goal`, async () => {
            await assert.rejects(agent.executeTask(goalOptions), /only supported for task execution/);
        });
    }
});

describe('agentRunToolPolicy', () => {
    const grant = { url: 'https://propr.example/mcp', token: TOKEN };

    test('report phase: web follows the capability and MCP needs both the capability and a grant', () => {
        assert.deepEqual(agentRunToolPolicy({ phase: 'report', capabilities: ['repository_read'] }), { allowWeb: false });
        assert.deepEqual(agentRunToolPolicy({ phase: 'report', capabilities: ['web'], mcpGrant: grant }), { allowWeb: true });
        assert.deepEqual(agentRunToolPolicy({ phase: 'report', capabilities: ['propr_mcp'] }), { allowWeb: false });
        assert.deepEqual(agentRunToolPolicy({ phase: 'report', capabilities: ['propr_mcp'], mcpGrant: grant }), MCP_POLICY);
    });

    test('action phase: MCP is always on and web follows the definition', () => {
        assert.deepEqual(agentRunToolPolicy({ phase: 'action', capabilities: [], mcpGrant: grant }), MCP_POLICY);
        assert.deepEqual(agentRunToolPolicy({ phase: 'action', capabilities: ['web'], mcpGrant: grant }), { ...MCP_POLICY, allowWeb: true });
    });
});

describe('redaction', () => {
    test('strips a short bearer token from an Authorization header', () => {
        const result = redactSecrets('Authorization: Bearer abc.def');
        assert.ok(!result.includes('abc.def'));
        assert.equal(result, 'Authorization: Bearer [REDACTED_BEARER_TOKEN]');
    });

    test('strips the token from a JSON Authorization header', () => {
        assert.ok(!redactSecrets('{"Authorization":"Bearer abc.def"}').includes('abc.def'));
    });

    test('strips the MCP bearer token echoed through its environment variable', () => {
        const result = redactSecrets(`${PROPR_MCP_BEARER_TOKEN_ENV}=short-token`);
        assert.equal(result, `${PROPR_MCP_BEARER_TOKEN_ENV}=[REDACTED_SECRET]`);
    });

    test('leaves the env-expansion placeholder in the MCP config readable', () => {
        const placeholder = `Bearer \${${PROPR_MCP_BEARER_TOKEN_ENV}}`;
        assert.ok(redactSecrets(`"Authorization":"${placeholder}"`).includes(placeholder));
    });
});
