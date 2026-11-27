import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { piToolPolicyArgs } from '../packages/core/src/agents/agentToolPolicy.js';
import { buildPiCliArgs, buildPiDockerArgs, PI_MCP_CONFIG_ENV } from '../packages/core/src/agents/impl/utils/piDockerArgsBuilder.js';
import { parsePiOutput, readablePiToolName } from '../packages/core/src/agents/impl/utils/piOutputParser.js';
import {
    buildPiRepositoryScoutArgs, buildPiRepositoryScoutConfig, REPOSITORY_SCOUT_CONTAINER_ROOT, REPOSITORY_SCOUT_MCP_SERVER_SOURCE, REPOSITORY_SCOUT_MCP_TOOLS,
} from '../packages/core/src/agents/impl/utils/repositoryScoutMcpServer.js';
import type { AgentConfig, AgentToolPolicy } from '../packages/core/src/agents/types.js';
import { closeConnection } from '../packages/core/src/db/connection.js';

after(async () => {
    await closeConnection();
});

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/pi');
const MODEL = 'pi-openrouter/mistralai/devstral-2512';
const PI_BUILTIN_TOOLS = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'];
const TOKEN = 'tok-run-scoped-secret';
const STDIO_SECRET = 'stdio-operator-secret';

function piConfig(): AgentConfig {
    return { id: 'pi-test', type: 'pi', alias: 'pi-test', enabled: true, dockerImage: 'propr/agent:latest', configPath: '/nonexistent/propr-pi-test/agent', supportedModels: [MODEL], defaultModel: MODEL };
}

function listAfter(args: string[], flag: string): string[] {
    return args.flatMap((arg, index) => (arg === flag ? [args[index + 1]] : []));
}

/** The launcher's shape: stdio secrets live on a non-enumerable `env`. */
function stdioServer(name: string, bridgeConfig: string, env: Record<string, string>) {
    return Object.defineProperty({ name, bridgeConfig } as NonNullable<AgentToolPolicy['localMcpServers']>[number], 'env', { value: env, enumerable: false });
}

function extensionPolicy(overrides: Partial<AgentToolPolicy> = {}): AgentToolPolicy {
    return {
        exclusiveMcp: true, allowWeb: true,
        mcpServers: [{ name: 'docs', url: 'http://api:4000/api/extensions/mcp/docs', bearerTokenEnv: 'PROPR_EXTENSION_MCP_0_TOKEN', bearerToken: TOKEN }],
        localMcpServers: [stdioServer('lookup', 'eyJjb25maWciOnRydWV9', { PROPR_EXTENSION_STDIO_1_0_SECRET: STDIO_SECRET })],
        skillPaths: ['/opt/propr/extensions/bundle-a', '/opt/propr/extensions/bundle-b'],
        ...overrides,
    };
}

describe('Pi repository scout config', () => {
    const config = JSON.parse(buildPiRepositoryScoutConfig()) as { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string>; exposure: string }>; autoEnableCodemode: boolean };
    const args = buildPiRepositoryScoutArgs();

    test('the generated mcp.json holds only the repository scout server, declared directly', () => {
        assert.deepEqual(Object.keys(config.mcpServers), ['propr_repository']);
        const server = config.mcpServers.propr_repository;
        assert.equal(server.command, 'node');
        assert.deepEqual(server.args, ['-e', REPOSITORY_SCOUT_MCP_SERVER_SOURCE]);
        assert.deepEqual(server.env, { PROPR_SCOUT_REPOSITORY_ROOT: REPOSITORY_SCOUT_CONTAINER_ROOT });
        // Direct exposure needs no codemode runner or tool_search to reach the tools.
        assert.equal(server.exposure, 'direct');
        assert.equal(config.autoEnableCodemode, false);
    });

    test('bash, edit and write are unavailable: only the scout MCP tools are allowed', () => {
        assert.ok(args.includes('--no-builtin-tools'));
        const allowed = listAfter(args, '--tools');
        assert.equal(allowed.length, 1);
        assert.deepEqual(allowed[0].split(','), [...REPOSITORY_SCOUT_MCP_TOOLS]);
        for (const tool of allowed[0].split(',')) assert.match(tool, /^mcp__propr_repository__/);
        for (const tool of PI_BUILTIN_TOOLS) assert.equal(allowed[0].split(',').includes(tool), false, `${tool} is not allowlisted`);
        assert.equal(args.some(arg => /codemode|tool_search/.test(arg)), false);
    });

    test('no extensions, skills or prompt templates load, and Pi MCP support is loaded back explicitly', () => {
        for (const flag of ['--no-extensions', '--no-skills', '--no-prompt-templates', '--no-approve']) assert.ok(args.includes(flag), flag);
        // --no-extensions also unloads builtin:mcp; without it the scout has no tools at all (Pi 1.6.1).
        assert.deepEqual(listAfter(args, '--extension'), ['builtin:mcp']);
        assert.ok(args.indexOf('--extension') > args.indexOf('--no-extensions'));
        assert.equal(args.includes('--skill'), false);
    });

    test('the recorded Pi 1.6.1 scout run called the repository tool and parses as a successful analysis', () => {
        const parsed = parsePiOutput(fs.readFileSync(path.join(FIXTURES, 'pi-1.6.1-json-scout-mcp.jsonl'), 'utf8'));
        assert.equal(parsed.summary, 'FINAL ANSWER');
        const calls = parsed.conversationLog.flatMap(entry => entry.message.content).filter(item => item.type === 'tool_use');
        assert.deepEqual(calls.map(call => call.name), ['propr_repository/read_repository_file']);
    });
});

describe('Pi analysis Docker args', () => {
    test('a tool-less analysis is read-only, keeps no session and loads no MCP servers', () => {
        const { args, configEnv } = buildPiDockerArgs({ config: piConfig(), worktreePath: '/tmp/a', modelName: MODEL, issueNumber: 0, mode: 'analysis', gitMountArgs: [] }, '');
        assert.ok(args.includes('/tmp/a:/home/node/workspace:ro'));
        assert.ok(args.includes('--no-tools') && args.includes('--no-session') && args.includes('--no-approve'));
        assert.equal(args.includes('--tools'), false);
        assert.deepEqual(configEnv, {});
        assert.equal(args.includes(PI_MCP_CONFIG_ENV), false);
    });

    test('the scout mounts only the repository root read-only, without git or credentials, and gets the scout mcp.json', () => {
        const { args, secretEnv, configEnv } = buildPiDockerArgs({
            config: piConfig(), worktreePath: '/tmp/git-processor/worktrees/pr-1', modelName: MODEL, issueNumber: 0, mode: 'analysis', repositoryInspection: true, gitMountArgs: ['-v', '/git:/git:ro'],
        }, 'ghs_should_not_be_forwarded');
        const mounts = listAfter(args, '-v');
        assert.deepEqual(mounts, [`/tmp/git-processor/worktrees/pr-1:${REPOSITORY_SCOUT_CONTAINER_ROOT}:ro`]);
        assert.equal('GH_TOKEN' in secretEnv || 'GITHUB_TOKEN' in secretEnv, false, 'the scout is credential-free');
        assert.deepEqual(Object.keys(configEnv), [PI_MCP_CONFIG_ENV]);
        assert.equal(configEnv[PI_MCP_CONFIG_ENV], buildPiRepositoryScoutConfig());
        assert.ok(args.includes(PI_MCP_CONFIG_ENV), 'name only: the value comes from the docker client environment');
        assert.equal(args.some(arg => arg.includes('"mcpServers"')), false);
        const piArgs = args.slice(args.indexOf('pi'));
        for (const flag of buildPiRepositoryScoutArgs()) assert.ok(piArgs.includes(flag), flag);
        assert.equal(piArgs.includes('--no-tools'), false, '--no-tools would drop the scout MCP tools too');
        assert.ok(args.includes('PROPR_REPO_SETUP=0'));
    });

    test('repository inspection is refused outside analysis mode', () => {
        assert.throws(() => buildPiDockerArgs({ config: piConfig(), worktreePath: '/tmp/w', modelName: MODEL, issueNumber: 1, repositoryInspection: true, gitMountArgs: [] }, ''), /analysis mode/);
        assert.throws(() => buildPiCliArgs({ modelName: MODEL, mode: 'execute', repositoryInspection: true }), /analysis mode/);
    });

    test('a tool policy never reaches an analysis run', () => {
        const { configEnv, secretEnv, args } = buildPiDockerArgs({ config: piConfig(), worktreePath: '/tmp/a', modelName: MODEL, issueNumber: 0, mode: 'analysis', gitMountArgs: [], toolPolicy: extensionPolicy() }, '');
        assert.deepEqual(configEnv, {});
        assert.equal('PROPR_EXTENSION_MCP_0_TOKEN' in secretEnv, false);
        assert.equal(args.includes('--skill'), false);
    });
});

describe('Pi extension library launch', () => {
    test('mcp.json renders stdio bridges and gateway servers with env-expanded auth and no token value', () => {
        const launch = piToolPolicyArgs(extensionPolicy());
        const config = JSON.parse(launch.mcpConfig!) as { mcpServers: Record<string, Record<string, unknown>> };
        assert.deepEqual(config, { mcpServers: {
            lookup: { command: '/usr/local/bin/node', args: ['/opt/propr/extension-stdio-bridge.mjs', 'eyJjb25maWciOnRydWV9'] },
            docs: { url: 'http://api:4000/api/extensions/mcp/docs', headers: { Authorization: 'Bearer ${PROPR_EXTENSION_MCP_0_TOKEN}' } },
        } });
        assert.equal(launch.mcpConfig!.includes(TOKEN), false);
        assert.equal(launch.mcpConfig!.includes(STDIO_SECRET), false);
        assert.equal(launch.cliArgs.join(' ').includes(TOKEN), false);
        assert.deepEqual(launch.env, { PROPR_EXTENSION_MCP_0_TOKEN: TOKEN, PROPR_EXTENSION_STDIO_1_0_SECRET: STDIO_SECRET });
        assert.equal(JSON.stringify(launch).includes(STDIO_SECRET), false, 'stdio secrets stay out of accidental serialization');
    });

    test('an exclusive policy drops discovered skills and passes one --skill per staged bundle', () => {
        const { cliArgs } = piToolPolicyArgs(extensionPolicy());
        assert.deepEqual(cliArgs, ['--no-skills', '--skill', '/opt/propr/extensions/bundle-a', '--skill', '/opt/propr/extensions/bundle-b']);
        // The ProPR MCP server alone (agent definitions, automations) adds no skill flags.
        const propr = piToolPolicyArgs({ allowWeb: false, mcpServers: [{ name: 'propr', url: 'http://api:4000/api/mcp', bearerTokenEnv: 'PROPR_MCP_BEARER_TOKEN', bearerToken: TOKEN }] });
        assert.deepEqual(propr.cliArgs, []);
        assert.deepEqual(Object.keys(JSON.parse(propr.mcpConfig!).mcpServers), ['propr']);
        assert.equal(piToolPolicyArgs({ allowWeb: true }).mcpConfig, undefined);
    });

    test('task Docker args carry the mcp.json and secrets by name, keep --no-approve, and join the policy network', () => {
        const { args, secretEnv, configEnv } = buildPiDockerArgs({
            config: piConfig(), worktreePath: '/tmp/w', modelName: MODEL, issueNumber: 7, taskId: 'task-7', gitMountArgs: [], toolPolicy: extensionPolicy({ dockerNetwork: 'propr_default' }),
        }, 'ghs_scoped');
        const joined = args.join('\n');
        assert.equal(joined.includes(TOKEN) || joined.includes(STDIO_SECRET), false, 'no secret value in argv');
        assert.equal(secretEnv.PROPR_EXTENSION_MCP_0_TOKEN, TOKEN);
        assert.equal(secretEnv.PROPR_EXTENSION_STDIO_1_0_SECRET, STDIO_SECRET);
        assert.ok(args.includes('PROPR_EXTENSION_MCP_0_TOKEN') && args.includes('PROPR_EXTENSION_STDIO_1_0_SECRET') && args.includes(PI_MCP_CONFIG_ENV));
        assert.equal(configEnv[PI_MCP_CONFIG_ENV], piToolPolicyArgs(extensionPolicy()).mcpConfig);
        assert.deepEqual(listAfter(args, '--network'), ['propr_default']);
        const piArgs = args.slice(args.lastIndexOf('/home/node/pi-entrypoint.sh'));
        assert.deepEqual(listAfter(piArgs, '--skill'), ['/opt/propr/extensions/bundle-a', '/opt/propr/extensions/bundle-b']);
        assert.ok(piArgs.includes('--no-skills') && piArgs.at(-1) === '--no-approve');
        assert.ok(piArgs.includes('--session-dir'));
    });

    test('smoke: the stdio server named by the generated mcp.json answers through the bridge, with its secret inherited from the environment', async t => {
        const server = `require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
            const rpc = JSON.parse(line); if (rpc.id === undefined) return;
            const send = result => console.log(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
            if (rpc.method === 'initialize') send({ protocolVersion: rpc.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '1' } });
            else if (rpc.method === 'tools/list') send({ tools: [{ name: 'lookup', inputSchema: { type: 'object', properties: {} } }] });
            else if (rpc.method === 'tools/call') send({ content: [{ type: 'text', text: 'key=' + (process.env.API_KEY === ${JSON.stringify(STDIO_SECRET)} ? 'present' : 'missing') }] });
            else send({});
        });`;
        const bridgeConfig = Buffer.from(JSON.stringify({ name: 'stub', executable: '/usr/bin/env', args: [process.execPath, '-e', server], tools: ['lookup'], secretEnv: { API_KEY: 'PROPR_EXTENSION_STDIO_0_0_SECRET' } })).toString('base64url');
        const policy: AgentToolPolicy = { exclusiveMcp: true, allowWeb: true, localMcpServers: [stdioServer('stub', bridgeConfig, { PROPR_EXTENSION_STDIO_0_0_SECRET: STDIO_SECRET })] };
        const launch = piToolPolicyArgs(policy);
        const entry = (JSON.parse(launch.mcpConfig!) as { mcpServers: Record<string, { command: string; args: string[]; env?: unknown }> }).mcpServers.stub;
        assert.equal(entry.env, undefined, 'the entry carries no env: Pi passes its own environment to stdio servers');
        assert.deepEqual(entry.args.slice(0, 1), ['/opt/propr/extension-stdio-bridge.mjs']);
        // Launch it as Pi would inside the image, with the repository copy of the bridge.
        const child = spawn(process.execPath, [path.resolve('scripts/extension-stdio-bridge.mjs'), ...entry.args.slice(1)], { env: { ...launch.env }, stdio: ['pipe', 'pipe', 'pipe'] });
        const reader = createInterface({ input: child.stdout });
        const pending = new Map<number, (reply: { result?: { content?: { text: string }[]; tools?: { name: string }[] } }) => void>();
        reader.on('line', line => { const reply = JSON.parse(line); pending.get(reply.id)?.(reply); pending.delete(reply.id); });
        t.after(async () => { reader.close(); if (child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('close', resolve)); } });
        const call = (id: number, method: string, params: Record<string, unknown> = {}) => new Promise<Parameters<NonNullable<ReturnType<typeof pending.get>>>[0]>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`No reply to ${method}`)), 5000);
            pending.set(id, reply => { clearTimeout(timer); resolve(reply); });
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        });
        await call(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'pi', version: '1.6.1' } });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
        assert.deepEqual((await call(2, 'tools/list')).result?.tools?.map(tool => tool.name), ['lookup']);
        assert.equal((await call(3, 'tools/call', { name: 'lookup', arguments: {} })).result?.content?.[0].text, 'key=present');
    });
});

describe('Pi MCP tool events', () => {
    test('MCP tools read <server>/<tool>; built-ins and codemode keep their names', () => {
        assert.equal(readablePiToolName('mcp__propr_repository__read_repository_file'), 'propr_repository/read_repository_file');
        assert.equal(readablePiToolName('mcp__docs__lookup'), 'docs/lookup');
        assert.equal(readablePiToolName('codemode'), 'codemode');
        assert.equal(readablePiToolName('bash'), 'bash');
    });

    test('a codemode script and the MCP calls it made are persisted as paired tool events', () => {
        const parsed = parsePiOutput(fs.readFileSync(path.join(FIXTURES, 'pi-1.6.1-json-codemode-mcp.jsonl'), 'utf8'));
        const items = parsed.conversationLog.flatMap(entry => entry.message.content);
        const uses = items.filter(item => item.type === 'tool_use');
        assert.deepEqual(uses.map(use => [use.id, use.name]), [['call_1', 'codemode'], ['call_1/1', 'propr_repository/read_repository_file']]);
        assert.deepEqual(uses[1].input, { path: 'README.md' });
        const results = items.filter(item => item.type === 'tool_result');
        assert.deepEqual(results.map(result => result.tool_use_id), ['call_1/1', 'call_1'], 'every result follows its call, one each');
        assert.equal(parsed.summary, 'FINAL ANSWER');
        assert.equal(parsed.assistantMessages, 2, 'nested calls are not counted as model responses');
    });
});
