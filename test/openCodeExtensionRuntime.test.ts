import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { buildOpenCodeDockerArgs } from '../packages/core/src/agents/impl/openCodeUtils.js';
import { openCodeCodeModeToolDisplay } from '../packages/core/src/agents/impl/openCodeCodeMode.js';
import { openCodeToolPolicyArgs } from '../packages/core/src/agents/agentToolPolicy.js';
import { MCP_LAUNCH_BUILDERS, mergeOpenCodeConfigContent, openCodeMcpConfig, openCodeToolPolicyEnvironment } from '../packages/core/src/agents/mcpLaunch/index.js';
import type { AgentConfig, AgentToolPolicy } from '../packages/core/src/agents/types.js';
import { parseRedisOutput } from '../packages/api/services/redisOutputParser.ts';
import { parseOpenCodeOutputToConversationResult } from '../packages/api/routes/liveDetailsOpenCodeParser.ts';
import { closeConnection } from '../packages/core/src/db/connection.js';

/**
 * OpenCode 2.x extension runtime: MCP servers and skills through the inline
 * config (`OPENCODE_CONFIG_CONTENT`), exclusive runs without the host, project
 * or ~/.claude servers and skills, the stdio bridge, and Code Mode `execute`
 * steps shown under the tools they called.
 */
after(async () => { await closeConnection(); });

const SECRET = 'UNMISTAKABLE_OPENCODE_STDIO_SECRET_SENTINEL';
const TOKEN = 'UNMISTAKABLE_OPENCODE_GATEWAY_TOKEN_SENTINEL';
const PROPR_TOKEN = 'UNMISTAKABLE_OPENCODE_PROPR_MCP_TOKEN_SENTINEL';
const GATEWAY = 'http://api:4000/api/extensions/mcp';
const ENTRYPOINT = new URL('../scripts/opencode-entrypoint.sh', import.meta.url);
const BRIDGE = new URL('../scripts/extension-stdio-bridge.mjs', import.meta.url).pathname;
const FIXTURE = new URL('./fixtures/opencode/opencode-2.4-code-mode-tools.jsonl', import.meta.url);

/** A stdio descriptor as extensionLaunch builds it: secret values on a non-enumerable `env`. */
function stdioServer(bridgeConfig = 'c3R1Yg', env: Record<string, string> = { PROPR_EXTENSION_STDIO_0_0_SECRET: SECRET }) {
    return Object.defineProperty({ name: 'stub', bridgeConfig } as NonNullable<AgentToolPolicy['localMcpServers']>[number], 'env', { value: env, enumerable: false });
}
const proprServer = { name: 'propr', url: 'http://api:4000/api/mcp', bearerTokenEnv: 'PROPR_MCP_BEARER_TOKEN', bearerToken: PROPR_TOKEN };
const docsServer = { name: 'docs', url: `${GATEWAY}/docs`, bearerTokenEnv: 'PROPR_EXTENSION_MCP_0_TOKEN', bearerToken: TOKEN };
const extensionPolicy = (): AgentToolPolicy => ({
    allowWeb: true, exclusiveMcp: true, mcpServers: [proprServer, docsServer], localMcpServers: [stdioServer()],
    skills: [{ id: 'bundle-1', name: 'release-notes' }], dockerNetwork: 'propr_default',
});

const agentConfig = (overrides: Partial<AgentConfig> = {}): AgentConfig => ({
    id: 'opencode-test', type: 'opencode', alias: 'opencode-test', enabled: true, dockerImage: 'propr/agent:latest',
    configPath: '/tmp/opencode-extension-config', supportedModels: ['opencode-big-pickle'], defaultModel: 'opencode-big-pickle', cliVersionResolved: '2.4.2', ...overrides,
});
const dockerArgs = (toolPolicy?: AgentToolPolicy, config: Partial<AgentConfig> = {}) => buildOpenCodeDockerArgs({
    config: agentConfig(config), worktreePath: '/tmp/worktree', githubToken: 'github-token', issueNumber: 3844, taskId: 'task-3844', ensureConfigPath: () => undefined, toolPolicy,
});
const envValue = (args: string[], name: string): string | undefined => {
    const entry = [...args].reverse().find(arg => arg.startsWith(`${name}=`));
    return entry?.slice(name.length + 1);
};

describe('OpenCode MCP launch builder', () => {
    test('is the opencode entry of the per-runtime builders', () => {
        assert.equal(MCP_LAUNCH_BUILDERS.opencode, openCodeToolPolicyArgs);
    });

    test('renders each server kind and the skill path into the 2.x inline config', () => {
        assert.deepEqual(openCodeMcpConfig(extensionPolicy()), {
            mcp: { servers: {
                stub: { type: 'local', command: ['/usr/local/bin/node', '/opt/propr/extension-stdio-bridge.mjs', 'c3R1Yg'] },
                propr: { type: 'remote', url: 'http://api:4000/api/mcp', headers: { Authorization: 'Bearer {env:PROPR_MCP_BEARER_TOKEN}' } },
                docs: { type: 'remote', url: `${GATEWAY}/docs`, headers: { Authorization: 'Bearer {env:PROPR_EXTENSION_MCP_0_TOKEN}' } },
            } },
            skills: { paths: ['/opt/propr/extensions'] },
        });
        // Each kind alone.
        assert.deepEqual(Object.keys((openCodeMcpConfig({ allowWeb: true, localMcpServers: [stdioServer()] })!.mcp as { servers: object }).servers), ['stub']);
        assert.deepEqual(openCodeMcpConfig({ allowWeb: true, skills: [{ id: 'bundle-1', name: 'release-notes' }] }), { skills: { paths: ['/opt/propr/extensions'] } });
        assert.equal(openCodeMcpConfig({ allowWeb: false }), undefined);
    });

    test('keeps tokens and stdio secrets out of the config and serialized results', () => {
        const config = JSON.stringify(openCodeMcpConfig(extensionPolicy()));
        const result = openCodeToolPolicyArgs(extensionPolicy());
        for (const value of [SECRET, TOKEN, PROPR_TOKEN]) {
            assert.ok(!config.includes(value), `${value} must not be in the config`);
            assert.ok(!JSON.stringify(result).includes(value), `${value} must not serialize`);
        }
        assert.deepEqual(result.cliArgs, []);
        // The launcher still gets every value to hand docker by name.
        assert.deepEqual(result.env, { PROPR_MCP_BEARER_TOKEN: PROPR_TOKEN, PROPR_EXTENSION_MCP_0_TOKEN: TOKEN, PROPR_EXTENSION_STDIO_0_0_SECRET: SECRET });
    });

    test('merges into existing inline config without dropping its servers', () => {
        const existing = JSON.stringify({ permissions: [{ action: '*', resource: '*', effect: 'deny' }], mcp: { servers: { scout: { type: 'local', command: ['node'] } } }, skills: { paths: ['/existing'] } });
        const merged = JSON.parse(mergeOpenCodeConfigContent(existing, openCodeMcpConfig(extensionPolicy()))!);
        assert.deepEqual(Object.keys(merged.mcp.servers), ['scout', 'stub', 'propr', 'docs']);
        assert.deepEqual(merged.skills.paths, ['/existing', '/opt/propr/extensions']);
        assert.deepEqual(merged.permissions, [{ action: '*', resource: '*', effect: 'deny' }]);
        assert.equal(mergeOpenCodeConfigContent(existing, undefined), existing);
        assert.throws(() => mergeOpenCodeConfigContent('[]', { skills: {} }), /JSON object/);
    });

    test('exclusive runs disable project, ~/.claude and explicit config sources and ask for a disposable config dir', () => {
        assert.deepEqual(openCodeToolPolicyEnvironment(extensionPolicy()), [
            '-e', 'OPENCODE_CONFIG_PROJECT_DISABLE=1', '-e', 'OPENCODE_DISABLE_CLAUDE_CODE=1', '-e', 'OPENCODE_CONFIG=', '-e', 'PROPR_OPENCODE_EXCLUSIVE_CONFIG=1',
        ]);
        assert.deepEqual(openCodeToolPolicyEnvironment({ allowWeb: true, mcpServers: [proprServer] }), []);
    });

    test('rejects server names and token variables that cannot be rendered safely', () => {
        assert.throws(() => openCodeMcpConfig({ allowWeb: true, mcpServers: [{ ...docsServer, name: 'bad name' }] }), /Invalid MCP server name/);
        assert.throws(() => openCodeMcpConfig({ allowWeb: true, mcpServers: [{ ...docsServer, bearerTokenEnv: 'bad-env' }] }), /Invalid MCP bearer token/);
    });
});

describe('OpenCode Docker launch', () => {
    test('passes the inline config, exclusive switches and secret names, never values, after operator variables', () => {
        const args = dockerArgs(extensionPolicy(), { envVars: { OPENCODE_CONFIG: '/home/node/other.json', PROPR_EXTENSION_MCP_0_TOKEN: 'operator', OPENCODE_CONFIG_PROJECT_DISABLE: '0' } });
        const joined = args.join('\n');
        for (const value of [SECRET, TOKEN, PROPR_TOKEN]) assert.ok(!joined.includes(value), `${value} must not be in docker arguments`);
        assert.deepEqual(JSON.parse(envValue(args, 'OPENCODE_CONFIG_CONTENT')!), openCodeMcpConfig(extensionPolicy()));
        for (const name of ['PROPR_MCP_BEARER_TOKEN', 'PROPR_EXTENSION_MCP_0_TOKEN', 'PROPR_EXTENSION_STDIO_0_0_SECRET']) {
            const index = args.lastIndexOf(name);
            assert.ok(index > 0 && args[index - 1] === '-e', `-e ${name}`);
            const operator = args.findIndex(arg => arg.startsWith(`${name}=`));
            assert.ok(operator === -1 || operator < index, `${name} overrides operator envVars`);
        }
        // Docker keeps the last value of a repeated variable: the run's switches win.
        assert.equal(envValue(args, 'OPENCODE_CONFIG'), '');
        assert.equal(envValue(args, 'OPENCODE_CONFIG_PROJECT_DISABLE'), '1');
        assert.equal(envValue(args, 'OPENCODE_DISABLE_CLAUDE_CODE'), '1');
        assert.equal(envValue(args, 'PROPR_OPENCODE_EXCLUSIVE_CONFIG'), '1');
        assert.equal(args[args.indexOf('--network') + 1], 'propr_default');
    });

    test('runs without a tool policy keep the default bridge network and no inline config', () => {
        const args = dockerArgs();
        assert.equal(args[args.indexOf('--network') + 1], 'bridge');
        assert.equal(envValue(args, 'OPENCODE_CONFIG_CONTENT'), undefined);
        assert.equal(envValue(args, 'PROPR_OPENCODE_EXCLUSIVE_CONFIG'), undefined);
        // A web-only policy adds nothing either.
        assert.equal(envValue(dockerArgs({ allowWeb: false }), 'OPENCODE_CONFIG_CONTENT'), undefined);
    });

    test('a ProPR MCP run without extensions keeps the host catalog', () => {
        const args = dockerArgs({ allowWeb: true, mcpServers: [proprServer], dockerNetwork: 'propr_default' });
        assert.deepEqual(Object.keys(JSON.parse(envValue(args, 'OPENCODE_CONFIG_CONTENT')!).mcp.servers), ['propr']);
        assert.equal(envValue(args, 'PROPR_OPENCODE_EXCLUSIVE_CONFIG'), undefined);
    });

    test('OpenCode 1.x refuses servers and skills instead of silently ignoring them', () => {
        assert.throws(() => dockerArgs(extensionPolicy(), { cliVersionResolved: '1.19.6' }), /require OpenCode CLI 2\.x/);
        // A web-only policy has nothing 1.x would drop.
        assert.doesNotThrow(() => dockerArgs({ allowWeb: false }, { cliVersionResolved: '1.19.6' }));
    });

    test('executeTask wraps the extension launch and hands docker the launch flag and MCP environment', () => {
        const source = fs.readFileSync(new URL('../packages/core/src/agents/impl/OpenCodeAgent.ts', import.meta.url), 'utf8');
        assert.match(source, /executeWithExtensions\(this\.config, options/);
        assert.match(source, /extensionAgentLaunch: !!options\.extensions/);
        assert.match(source, /extraEnvVars: openCodeToolPolicyArgs\(toolPolicy\)\.env/);
        assert.match(source, /taskId, toolPolicy \}\)/);
    });
});

/** Run the entrypoint's exclusive-config step against a host config dir; return its exit, stderr and OPENCODE_CONFIG_DIR. */
function runExclusiveStep(sourceDir: string, runtimeDir: string, env: Record<string, string> = { PROPR_OPENCODE_EXCLUSIVE_CONFIG: '1' }) {
    const script = fs.readFileSync(ENTRYPOINT, 'utf8');
    const block = script.slice(script.indexOf('# Extension runs (PROPR_OPENCODE_EXCLUSIVE_CONFIG=1)'), script.indexOf("git config --global --add safe.directory '*'"));
    assert.match(block, /prepare_exclusive_opencode_config\(\)/);
    const result = spawnSync('bash', ['-c', `set -euo pipefail\nopencode_config_dir='${sourceDir}'\n${block}\nprintf 'dir=%s\\n' "\${OPENCODE_CONFIG_DIR:-}"`], {
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', PROPR_OPENCODE_EXCLUSIVE_CONFIG_DIR: runtimeDir, ...env }, encoding: 'utf8',
    });
    return { status: result.status, stderr: result.stderr, dir: /dir=(.*)/.exec(result.stdout)?.[1] };
}

const HOST_CONFIG = `{
  // Host providers and settings stay.
  "$schema": "https://opencode.ai/config.json",
  "providers": { "acme": { "package": "@opencode/ai/providers/openai-compatible", "settings": { "baseURL": "https://llm.acme.example/v1" }, }, },
  /* Ambient catalog the run must not see. */
  "mcp": { "servers": { "ambient": { "type": "local", "command": ["ambient-server"] } } },
  "skills": { "paths": ["/home/node/ambient-skills"] },
  "share": "disabled",
}
`;

describe('OpenCode entrypoint exclusive config', { skip: spawnSync('python3', ['--version']).status === 0 ? false : 'needs python3' }, () => {
    test('builds a disposable config dir without host servers and skills, keeping providers and other entries', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-exclusive-'));
        try {
            const source = path.join(root, 'host');
            const runtime = path.join(root, 'runtime');
            fs.mkdirSync(path.join(source, 'skills', 'ambient'), { recursive: true });
            fs.writeFileSync(path.join(source, 'skills', 'ambient', 'SKILL.md'), '---\nname: ambient\ndescription: host skill\n---\n');
            fs.mkdirSync(path.join(source, 'agents'));
            fs.writeFileSync(path.join(source, 'agents', 'reviewer.md'), 'reviewer');
            fs.writeFileSync(path.join(source, 'opencode.jsonc'), HOST_CONFIG);
            fs.writeFileSync(path.join(source, 'opencode.json'), JSON.stringify({ mcp: { servers: { other: { type: 'remote', url: 'https://x.example' } } }, model: 'acme/m' }));
            const run = runExclusiveStep(source, runtime);
            assert.equal(run.status, 0, run.stderr);
            assert.equal(run.dir, runtime);
            assert.deepEqual(fs.readdirSync(runtime).sort(), ['agents', 'opencode.json', 'opencode.jsonc']);
            assert.equal(fs.readlinkSync(path.join(runtime, 'agents')), path.join(source, 'agents'));
            const jsonc = JSON.parse(fs.readFileSync(path.join(runtime, 'opencode.jsonc'), 'utf8'));
            assert.deepEqual(Object.keys(jsonc).sort(), ['$schema', 'providers', 'share']);
            assert.equal(jsonc.providers.acme.settings.baseURL, 'https://llm.acme.example/v1');
            assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runtime, 'opencode.json'), 'utf8')), { model: 'acme/m' });
            assert.equal((fs.statSync(runtime).mode & 0o777), 0o700);
            // The mounted host dir is never changed.
            assert.equal(fs.readFileSync(path.join(source, 'opencode.jsonc'), 'utf8'), HOST_CONFIG);
            assert.ok(fs.existsSync(path.join(source, 'skills', 'ambient', 'SKILL.md')));
        } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });

    test('fails the run when a host config document cannot be rewritten', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-exclusive-'));
        try {
            fs.mkdirSync(path.join(root, 'host'));
            fs.writeFileSync(path.join(root, 'host', 'opencode.json'), '{"mcp": ');
            const run = runExclusiveStep(path.join(root, 'host'), path.join(root, 'runtime'));
            assert.notEqual(run.status, 0);
            assert.match(run.stderr, /could not remove MCP servers and skills from OpenCode config opencode\.json/);
        } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });

    test('an empty or missing host config dir gives an empty disposable dir; non-exclusive runs keep the host dir', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-exclusive-'));
        try {
            const run = runExclusiveStep(path.join(root, 'missing'), path.join(root, 'runtime'));
            assert.equal(run.status, 0, run.stderr);
            assert.deepEqual(fs.readdirSync(path.join(root, 'runtime')), []);
            assert.equal(runExclusiveStep(path.join(root, 'missing'), path.join(root, 'other'), {}).dir, '');
            assert.ok(!fs.existsSync(path.join(root, 'other')));
        } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });
});

const STUB_SERVER = `
const rl = require('node:readline').createInterface({ input: process.stdin });
const send = m => process.stdout.write(JSON.stringify(m) + '\\n');
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '1' } } });
  else if (msg.method === 'tools/list') send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'echo_secret', inputSchema: { type: 'object' } }] } });
  else if (msg.method === 'tools/call') send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'secret:' + (process.env.STUB_SECRET || 'missing') }] } });
});`;

/** Start the rendered local command (paths swapped for this checkout) with `env`, call the stub's tool, return the text. */
async function callStubThroughBridge(env: NodeJS.ProcessEnv): Promise<string> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-bridge-'));
    const stub = path.join(root, 'stub.cjs');
    fs.writeFileSync(stub, STUB_SERVER);
    const bridgeConfig = Buffer.from(JSON.stringify({ name: 'stub', executable: process.execPath, args: [stub], tools: ['echo_secret'], secretEnv: { STUB_SECRET: 'PROPR_EXTENSION_STDIO_0_0_SECRET' } })).toString('base64url');
    const servers = (openCodeMcpConfig({ allowWeb: true, localMcpServers: [stdioServer(bridgeConfig)] })!.mcp as { servers: Record<string, { command: string[] }> }).servers;
    const [node, bridge, ...rest] = servers.stub.command;
    assert.equal(node, '/usr/local/bin/node');
    assert.equal(bridge, '/opt/propr/extension-stdio-bridge.mjs');
    // OpenCode starts local servers with its own environment (verified on 2.4.2).
    const child = spawn(process.execPath, [BRIDGE, ...rest], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    try {
        const lines: string[] = [];
        let buffer = '';
        const reply = (id: number) => new Promise<Record<string, unknown>>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`no reply ${id}`)), 10_000);
            const check = () => {
                const found = lines.map(line => JSON.parse(line) as Record<string, unknown>).find(message => message.id === id);
                if (found) { clearTimeout(timer); resolve(found); } else setTimeout(check, 10);
            };
            check();
        });
        child.stdout.on('data', chunk => { buffer += chunk; const parts = buffer.split('\n'); buffer = parts.pop() ?? ''; lines.push(...parts.filter(Boolean)); });
        const write = (message: object) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
        write({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'opencode', version: '2.4.2' } } });
        await reply(1);
        write({ method: 'notifications/initialized' });
        write({ id: 2, method: 'tools/call', params: { name: 'echo_secret', arguments: {} } });
        const result = (await reply(2)).result as { content: { text: string }[] };
        return result.content[0].text;
    } finally {
        child.kill();
        fs.rmSync(root, { recursive: true, force: true });
    }
}

describe('OpenCode stdio servers through the bridge', () => {
    test('a stub server gets its secret from the inherited environment, and the bridge redacts it', async () => {
        assert.equal(await callStubThroughBridge({ PATH: process.env.PATH, PROPR_EXTENSION_STDIO_0_0_SECRET: SECRET }), 'secret:[REDACTED]');
        // The secret travels only by environment: without it the server has none.
        assert.equal(await callStubThroughBridge({ PATH: process.env.PATH }), 'secret:missing');
    });
});

describe('OpenCode Code Mode display', () => {
    const fixtureLines = fs.readFileSync(FIXTURE, 'utf8').trim().split('\n');

    test('names an execute step after the tools it called', () => {
        const parts = fixtureLines.map(line => JSON.parse(line)).filter(event => event.type === 'tool_use').map(event => event.part);
        assert.deepEqual(parts.map(part => openCodeCodeModeToolDisplay(part)?.toolName), [undefined, 'gw.lookup, local_stub.echo_secret', undefined]);
        const display = openCodeCodeModeToolDisplay(parts[1]);
        assert.deepEqual((display?.input as { calls: unknown[] }).calls, [{ tool: 'gw.lookup', status: 'completed', input: { q: 'y' } }, { tool: 'local_stub.echo_secret', status: 'completed' }]);
        const single = { tool: 'execute', state: { input: { code: 'return await tools.gw.lookup({q:"x"})' }, metadata: { metadata: { toolCalls: [{ tool: 'gw.lookup', status: 'completed', input: { q: 'x' } }] } } } };
        assert.deepEqual(openCodeCodeModeToolDisplay(single), { toolName: 'gw.lookup', input: { q: 'x' } });
        assert.equal(openCodeCodeModeToolDisplay({ tool: 'read', state: single.state }), undefined);
    });

    const expected = [
        { toolName: 'skill', input: { id: 'bundle1' } },
        { toolName: 'gw.lookup, local_stub.echo_secret' },
        // A script that called no tool stays a plain execute step.
        { toolName: 'execute', input: { code: 'return await tools.gw.missing({})' } },
    ];
    const check = (events: Array<Record<string, unknown>>) => {
        const uses = events.filter(event => event.type === 'tool_use');
        assert.equal(uses.length, expected.length);
        uses.forEach((use, index) => {
            assert.equal(use.toolName, expected[index].toolName);
            if (expected[index].input) assert.deepEqual(use.input, expected[index].input);
        });
        const results = events.filter(event => event.type === 'tool_result');
        assert.match(String(results[0].result), /<skill_content name="runskill">/);
        assert.equal(results[1].result, '["gateway answer for {\\"q\\":\\"y\\"}","secret:[REDACTED]"]');
        assert.equal(results[1].toolUseId, uses[1].id);
    };

    test('in the live view', () => {
        check(parseRedisOutput(fixtureLines).events as unknown as Array<Record<string, unknown>>);
    });

    test('in persisted task logs', () => {
        check(parseOpenCodeOutputToConversationResult(fixtureLines.join('\n'))!.events);
    });
});

/**
 * End-to-end against an installed OpenCode 2.x (`PROPR_OPENCODE_BIN`), with a
 * mock OpenAI-compatible model: exclusive mode loads only the run's servers and
 * skill (no host, project or ~/.claude ones) and a gateway call authenticates
 * with the token from `{env:VAR}`.
 */
describe('OpenCode 2.x live config', { skip: process.env.PROPR_OPENCODE_BIN ? false : 'set PROPR_OPENCODE_BIN to an OpenCode 2.x binary' }, () => {
    test('exclusive runs see only the run servers and skills, and remote auth uses the env token', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-live-'));
        const requests: Array<{ system: string; tools: string[] }> = [];
        const authorizations: string[] = [];
        let step = 0;
        const llm = http.createServer((req, res) => {
            let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => {
                const parsed = JSON.parse(body || '{}') as { messages?: { role: string; content: unknown }[]; tools?: { function: { name: string } }[] };
                requests.push({ system: String(parsed.messages?.[0]?.content ?? ''), tools: (parsed.tools ?? []).map(tool => tool.function.name) });
                const chunk = (delta: object, finish: string | null = null) => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
                res.writeHead(200, { 'content-type': 'text/event-stream' });
                const agentTurn = (parsed.tools ?? []).some(tool => tool.function.name === 'execute');
                if (agentTurn && step++ === 0) res.write(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'execute', arguments: JSON.stringify({ code: 'return await tools.docs.lookup({q:"x"})' }) } }] }) + chunk({}, 'tool_calls'));
                else res.write(chunk({ role: 'assistant', content: 'done' }) + chunk({}, 'stop'));
                res.end('data: [DONE]\n\n');
            });
        });
        const gateway = http.createServer((req, res) => {
            let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => {
                authorizations.push(String(req.headers.authorization));
                if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401); res.end(); return; }
                if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
                const message = JSON.parse(body) as { id?: number | string; method: string; params?: { protocolVersion?: string; arguments?: unknown } };
                if (message.id === undefined) { res.writeHead(202); res.end(); return; }
                const result = message.method === 'initialize' ? { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'docs', version: '1' } }
                    : message.method === 'tools/list' ? { tools: [{ name: 'lookup', description: 'Look up', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }] }
                        : message.method === 'tools/call' ? { content: [{ type: 'text', text: `docs answer ${JSON.stringify(message.params?.arguments)}` }] } : {};
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
            });
        });
        await Promise.all([llm, gateway].map(server => new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))));
        try {
            const port = (server: http.Server) => (server.address() as AddressInfo).port;
            const home = path.join(root, 'home');
            const project = path.join(root, 'project');
            const extensions = path.join(root, 'extensions');
            const skill = (dir: string, name: string) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} marker\n---\nBody of ${name}\n`); };
            skill(path.join(home, '.config', 'opencode', 'skills', 'hostskill'), 'hostskill');
            skill(path.join(home, '.claude', 'skills', 'claudeskill'), 'claudeskill');
            skill(path.join(project, '.opencode', 'skills', 'projskill'), 'projskill');
            skill(path.join(extensions, 'bundle-1'), 'release-notes');
            const ambient = { type: 'local', command: [process.execPath, '-e', 'setInterval(() => {}, 1000)'] };
            fs.writeFileSync(path.join(home, '.config', 'opencode', 'opencode.json'), JSON.stringify({
                providers: { mock: { name: 'Mock', package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: `http://127.0.0.1:${port(llm)}/v1`, apiKey: 'x' }, models: { m1: { name: 'M1' } } } },
                mcp: { servers: { hostsrv: ambient } },
            }));
            fs.writeFileSync(path.join(project, 'opencode.json'), JSON.stringify({ mcp: { servers: { projsrv: ambient } } }));
            spawnSync('git', ['init', '-q'], { cwd: project });
            const policy: AgentToolPolicy = { allowWeb: true, exclusiveMcp: true, mcpServers: [{ ...docsServer, url: `http://127.0.0.1:${port(gateway)}/api/extensions/mcp/docs` }], skills: [{ id: 'bundle-1', name: 'release-notes' }] };
            const content = mergeOpenCodeConfigContent(undefined, openCodeMcpConfig(policy))!.replace('/opt/propr/extensions', extensions);
            const exclusiveEnv = Object.fromEntries(openCodeToolPolicyEnvironment(policy).filter(arg => arg !== '-e').map(arg => [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]));
            const configDir = path.join(root, 'run-config');
            const prepared = runExclusiveStep(path.join(home, '.config', 'opencode'), configDir);
            assert.equal(prepared.status, 0, prepared.stderr);
            const env = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(root, 'data'), ...exclusiveEnv, OPENCODE_CONFIG_DIR: configDir, OPENCODE_CONFIG_CONTENT: content, ...openCodeToolPolicyArgs(policy).env };
            const run = await new Promise<{ status: number | null; stdout: string }>(resolve => {
                const child = spawn(process.env.PROPR_OPENCODE_BIN!, ['run', '--standalone', '--auto', '--format', 'json', '--model', 'mock/m1', 'hello'], { cwd: project, env, stdio: ['ignore', 'pipe', 'ignore'] });
                let stdout = ''; child.stdout.on('data', chunk => { stdout += chunk; });
                const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
                child.on('exit', status => { clearTimeout(timer); resolve({ status, stdout }); });
            });
            assert.equal(run.status, 0, run.stdout);
            // OpenCode may also ask the model for a title; the agent turn offers `execute`.
            const system = requests.find(request => request.tools.includes('execute'))?.system ?? '';
            const catalog = system.slice(system.indexOf('## Code Mode tools'));
            assert.match(catalog, /^- docs \(1 tool/m);
            for (const ambientServer of ['hostsrv', 'projsrv']) assert.doesNotMatch(catalog, new RegExp(`^- ${ambientServer} `, 'm'));
            assert.match(system, /<id>bundle-1<\/id>\s*<name>release-notes<\/name>/);
            for (const ambientSkill of ['hostskill', 'claudeskill', 'projskill']) assert.doesNotMatch(system, new RegExp(`${ambientSkill} marker`));
            assert.ok(authorizations.length > 0 && authorizations.every(header => header === `Bearer ${TOKEN}`), authorizations.join(','));
            assert.ok(!fs.readFileSync(path.join(configDir, 'opencode.json'), 'utf8').includes(TOKEN));
            const events = parseOpenCodeOutputToConversationResult(run.stdout)!.events;
            const use = events.find(event => event.type === 'tool_use');
            assert.equal(use?.toolName, 'docs.lookup');
            assert.match(String(events.find(event => event.type === 'tool_result')?.result), /docs answer \{"q":"x"\}/);
        } finally {
            await Promise.all([llm, gateway].map(server => new Promise(resolve => server.close(resolve))));
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
