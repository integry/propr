import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { VibeAgent, parseVibeConversationLog } from '../packages/core/src/agents/impl/VibeAgent.js';
import { vibeToolPolicyArgs } from '../packages/core/src/agents/agentToolPolicy.js';
import { MCP_LAUNCH_BUILDERS } from '../packages/core/src/agents/mcpLaunch/index.js';
import type { AgentConfig, AgentToolPolicy } from '../packages/core/src/agents/types.js';
import { parseRedisOutput } from '../packages/api/services/redisOutputParser.ts';
import { closeConnection } from '../packages/core/src/db/connection.js';

/**
 * Vibe 3 extension runtime: MCP servers through VIBE_MCP_SERVERS, skills
 * through VIBE_SKILL_PATHS, exclusive runs without the user's MCP catalog, and
 * MCP tool effects in both output parsers.
 */
const previousContainerized = process.env.PROPR_CONTAINERIZED;
process.env.PROPR_CONTAINERIZED = '0';
after(async () => {
    if (previousContainerized === undefined) delete process.env.PROPR_CONTAINERIZED;
    else process.env.PROPR_CONTAINERIZED = previousContainerized;
    await closeConnection();
});

const SECRET = 'UNMISTAKABLE_VIBE_STDIO_SECRET_SENTINEL';
const TOKEN = 'UNMISTAKABLE_VIBE_GATEWAY_TOKEN_SENTINEL';
const PROPR_TOKEN = 'UNMISTAKABLE_VIBE_PROPR_MCP_TOKEN_SENTINEL';
const GATEWAY = 'http://api:4000/api/extensions/mcp';
const ENTRYPOINT = new URL('../scripts/vibe-entrypoint.sh', import.meta.url);
const BRIDGE = new URL('../scripts/extension-stdio-bridge.mjs', import.meta.url).pathname;

/** A stdio descriptor as extensionLaunch builds it: secret values on a non-enumerable `env`. */
function stdioServer(bridgeConfig: string, env: Record<string, string> = { PROPR_EXTENSION_STDIO_0_0_SECRET: SECRET }) {
    return Object.defineProperty({ name: 'stub', bridgeConfig } as NonNullable<AgentToolPolicy['localMcpServers']>[number], 'env', { value: env, enumerable: false });
}

const proprServer = { name: 'propr', url: 'http://api:4000/api/mcp', bearerTokenEnv: 'PROPR_MCP_BEARER_TOKEN', bearerToken: PROPR_TOKEN };
const docsServer = { name: 'docs', url: `${GATEWAY}/docs`, bearerTokenEnv: 'PROPR_EXTENSION_MCP_0_TOKEN', bearerToken: TOKEN };

function extensionPolicy(bridgeConfig = 'c3R1Yg'): AgentToolPolicy {
    return { allowWeb: true, exclusiveMcp: true, mcpServers: [proprServer, docsServer], localMcpServers: [stdioServer(bridgeConfig)], skills: [{ id: 'bundle-1', name: 'release-notes' }], dockerNetwork: 'propr_default' };
}

describe('Vibe MCP launch builder', () => {
    test('is the vibe entry of the per-runtime builders', () => {
        assert.equal(MCP_LAUNCH_BUILDERS.vibe, vibeToolPolicyArgs);
    });

    test('renders stdio, gateway HTTP and ProPR MCP servers into VIBE_MCP_SERVERS', () => {
        const { cliArgs, env } = vibeToolPolicyArgs(extensionPolicy());
        assert.deepEqual(cliArgs, []);
        assert.deepEqual(JSON.parse(env.VIBE_MCP_SERVERS), [
            { name: 'stub', transport: 'stdio', command: '/usr/local/bin/node', args: ['/opt/propr/extension-stdio-bridge.mjs', 'c3R1Yg'], env: { PROPR_EXTENSION_STDIO_0_0_SECRET: SECRET } },
            { name: 'propr', transport: 'streamable-http', url: 'http://api:4000/api/mcp', auth: { type: 'static', api_key_env: 'PROPR_MCP_BEARER_TOKEN' } },
            { name: 'docs', transport: 'streamable-http', url: `${GATEWAY}/docs`, auth: { type: 'static', api_key_env: 'PROPR_EXTENSION_MCP_0_TOKEN' } },
        ]);
        assert.equal(env.PROPR_MCP_BEARER_TOKEN, PROPR_TOKEN);
        assert.equal(env.PROPR_EXTENSION_MCP_0_TOKEN, TOKEN);
        assert.ok(!env.VIBE_MCP_SERVERS.includes(TOKEN) && !env.VIBE_MCP_SERVERS.includes(PROPR_TOKEN), 'bearer tokens are referenced by name');
        // Stdio secrets are not exported to the agent as their own variables.
        assert.equal(env.PROPR_EXTENSION_STDIO_0_0_SECRET, undefined);
        assert.equal(env.VIBE_SKILL_PATHS, '["/opt/propr/extensions"]');
        assert.equal(env.VIBE_ENABLED_SKILLS, '["release-notes"]');
        assert.equal(env.PROPR_EXTENSION_EXCLUSIVE_MCP, '1');
        assert.equal(env.VIBE_ENABLE_CONNECTORS, 'false');
    });

    test('keeps secrets out of serialized results', () => {
        const result = vibeToolPolicyArgs(extensionPolicy());
        const serialized = JSON.stringify(result);
        for (const value of [SECRET, TOKEN, PROPR_TOKEN]) assert.ok(!serialized.includes(value), value);
    });

    test('a ProPR MCP run without extensions merges with the user catalog and keeps skills untouched', () => {
        const { env } = vibeToolPolicyArgs({ allowWeb: true, mcpServers: [proprServer] });
        assert.deepEqual(Object.keys(env).sort(), ['PROPR_MCP_BEARER_TOKEN', 'VIBE_MCP_SERVERS']);
        assert.deepEqual(JSON.parse(env.VIBE_MCP_SERVERS).map((s: { name: string }) => s.name), ['propr']);
        assert.deepEqual(vibeToolPolicyArgs({ allowWeb: false }).env, {});
    });

    test('an exclusive run with servers only sets no skill filter', () => {
        const { env } = vibeToolPolicyArgs({ allowWeb: true, exclusiveMcp: true, mcpServers: [docsServer] });
        assert.equal(env.VIBE_SKILL_PATHS, undefined);
        assert.equal(env.VIBE_ENABLED_SKILLS, undefined);
        assert.equal(env.PROPR_EXTENSION_EXCLUSIVE_MCP, '1');
    });

    test('rejects server names and token variables that cannot be rendered safely', () => {
        assert.throws(() => vibeToolPolicyArgs({ allowWeb: true, mcpServers: [{ ...docsServer, name: 'bad name' }] }), /Invalid MCP server name/);
        assert.throws(() => vibeToolPolicyArgs({ allowWeb: true, mcpServers: [{ ...docsServer, bearerTokenEnv: 'bad-env' }] }), /Invalid MCP bearer token/);
    });
});

describe('Vibe Docker launch', () => {
    const agent = (overrides: Partial<AgentConfig> = {}) => new VibeAgent({
        id: 'vibe-test', type: 'vibe', alias: 'vibe-test', enabled: true, dockerImage: 'propr/agent:bundle-test',
        configPath: '/tmp/missing-vibe-config', supportedModels: ['mistral-medium-3.5'], defaultModel: 'mistral-medium-3.5', cliVersionResolved: '3.1.5', ...overrides,
    } satisfies AgentConfig);
    const buildArgs = (vibe: VibeAgent, toolPolicy?: AgentToolPolicy): string[] => {
        const previous = process.env.MISTRAL_API_KEY;
        process.env.MISTRAL_API_KEY = 'test-key';
        try {
            return (vibe as unknown as { buildDockerArgs(params: Record<string, unknown>): string[] }).buildDockerArgs({
                worktreePath: '/tmp/vibe-worktree', githubToken: 'github-token', modelName: 'mistral-medium-3.5', issueNumber: 3842, taskId: 'task-3842', toolPolicy,
            });
        } finally {
            if (previous === undefined) delete process.env.MISTRAL_API_KEY; else process.env.MISTRAL_API_KEY = previous;
        }
    };

    test('passes the catalog and tokens as environment names only, after operator variables', () => {
        const args = buildArgs(agent({ envVars: { VIBE_ENABLE_CONNECTORS: 'true', VIBE_MCP_SERVERS: '[]' } }), extensionPolicy());
        const joined = args.join('\n');
        for (const value of [SECRET, TOKEN, PROPR_TOKEN]) assert.ok(!joined.includes(value), `${value} must not be in docker arguments`);
        const names = ['VIBE_MCP_SERVERS', 'PROPR_MCP_BEARER_TOKEN', 'PROPR_EXTENSION_MCP_0_TOKEN', 'VIBE_SKILL_PATHS', 'VIBE_ENABLED_SKILLS', 'PROPR_EXTENSION_EXCLUSIVE_MCP', 'VIBE_ENABLE_CONNECTORS'];
        for (const name of names) {
            const index = args.lastIndexOf(name);
            assert.ok(index > 0 && args[index - 1] === '-e', `-e ${name}`);
            // The operator's own value comes earlier, so docker uses the run's.
            const operator = args.findIndex(arg => arg.startsWith(`${name}=`));
            assert.ok(operator === -1 || operator < index, `${name} overrides operator envVars`);
        }
        assert.ok(!args.includes('PROPR_EXTENSION_STDIO_0_0_SECRET'), 'stdio secrets live only inside VIBE_MCP_SERVERS');
        assert.equal(args[args.indexOf('--network') + 1], 'propr_default');
    });

    test('runs without a tool policy keep the default bridge network and no MCP environment', () => {
        const args = buildArgs(agent());
        assert.equal(args[args.indexOf('--network') + 1], 'bridge');
        assert.ok(!args.includes('VIBE_MCP_SERVERS'));
    });

    test('executeTask wraps the extension launch and hands docker the launch flag and MCP environment', () => {
        const source = fs.readFileSync(new URL('../packages/core/src/agents/impl/VibeAgent.ts', import.meta.url), 'utf8');
        assert.match(source, /executeWithExtensions\(this\.config, options/);
        assert.match(source, /extensionAgentLaunch: !!options\.extensions/);
        assert.match(source, /extraEnvVars: vibeToolPolicyArgs\(toolPolicy\)\.env/);
    });
});

/** The python with tomllib and tomli_w the image runs the entrypoint helper with. */
function tomlPython(): string | undefined {
    const candidates = [process.env.PROPR_VIBE_PYTHON, '/opt/uv/tools/mistral-vibe/bin/python'].filter(Boolean) as string[];
    return candidates.find(candidate => fs.existsSync(candidate) && spawnSync(candidate, ['-I', '-c', 'import tomllib, tomli_w']).status === 0);
}

const USER_CONFIG = [
    'active_model = "devstral"',
    'enabled_skills = ["user-*"]',
    '',
    '[[mcp_servers]]',
    'name = "ambient"',
    'transport = "stdio"',
    'command = "ambient-server"',
    '',
    '[mcp_servers.env]',
    'AMBIENT = "1"',
    '',
    '[[mcp_servers]]',
    'name = "docs"',
    'transport = "http"',
    'url = "https://ambient.example/mcp"',
    '',
    '[[models]]',
    'name = "devstral"',
    'provider = "mistral"',
    'alias = "devstral"',
    '',
].join('\n');

/** Run the entrypoint's exclusive-MCP step against a runtime home; return its exit, stderr and exported variables. */
function runExclusiveStep(home: string, env: Record<string, string>) {
    const script = fs.readFileSync(ENTRYPOINT, 'utf8');
    const block = script.slice(script.indexOf('# Extension runs (PROPR_EXTENSION_EXCLUSIVE_MCP=1)'), script.indexOf('configure_repository_scout() {'));
    assert.match(block, /configure_exclusive_mcp\(\)/);
    const result = spawnSync('bash', ['-c', `set -e\nRUNTIME_VIBE_HOME='${home}'\n${block}\nconfigure_exclusive_mcp\nprintf '%s\\n' "connectors=\${VIBE_ENABLE_CONNECTORS:-}" "servers=\${VIBE_MCP_SERVERS:-}"`], {
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', PROPR_VIBE_PYTHON: tomlPython() ?? '/nonexistent/python', ...env }, encoding: 'utf8',
    });
    return { status: result.status, stderr: result.stderr, vars: Object.fromEntries(result.stdout.trim().split('\n').filter(Boolean).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])) };
}

describe('Vibe entrypoint exclusive MCP', { skip: tomlPython() ? false : 'needs the Vibe python (tomllib + tomli_w); set PROPR_VIBE_PYTHON' }, () => {
    test('strips mcp_servers from the runtime config.toml copy, keeps the rest, and turns connectors off', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-exclusive-'));
        try {
            fs.writeFileSync(path.join(home, 'config.toml'), USER_CONFIG);
            const run = runExclusiveStep(home, { PROPR_EXTENSION_EXCLUSIVE_MCP: '1', VIBE_MCP_SERVERS: '[{"name":"docs"}]' });
            assert.equal(run.status, 0, run.stderr);
            assert.equal(run.vars.connectors, 'false');
            assert.equal(run.vars.servers, '[{"name":"docs"}]');
            const config = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
            assert.doesNotMatch(config, /mcp_servers|ambient/);
            assert.match(config, /active_model = "devstral"/);
            assert.match(config, /models = \[|\[\[models\]\]/);
            // Without a run skill filter the user's own skill selection stays.
            assert.match(config, /enabled_skills = \[\s*"user-\*",?\s*\]/);
        } finally { fs.rmSync(home, { recursive: true, force: true }); }
    });

    test('drops the config skill filter when the run sets VIBE_ENABLED_SKILLS, and defaults an empty catalog', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-exclusive-'));
        try {
            fs.writeFileSync(path.join(home, 'config.toml'), USER_CONFIG);
            const run = runExclusiveStep(home, { PROPR_EXTENSION_EXCLUSIVE_MCP: '1', VIBE_ENABLED_SKILLS: '["release-notes"]' });
            assert.equal(run.status, 0, run.stderr);
            assert.equal(run.vars.servers, '[]');
            assert.doesNotMatch(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), /enabled_skills|mcp_servers/);
        } finally { fs.rmSync(home, { recursive: true, force: true }); }
    });

    test('leaves non-exclusive runs alone and fails closed on a config it cannot rewrite', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-exclusive-'));
        try {
            fs.writeFileSync(path.join(home, 'config.toml'), USER_CONFIG);
            const plain = runExclusiveStep(home, {});
            assert.equal(plain.status, 0, plain.stderr);
            assert.equal(plain.vars.connectors, '');
            assert.equal(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), USER_CONFIG);
            fs.writeFileSync(path.join(home, 'config.toml'), 'mcp_servers = [\n');
            const broken = runExclusiveStep(home, { PROPR_EXTENSION_EXCLUSIVE_MCP: '1' });
            assert.equal(broken.status, 1);
            assert.match(broken.stderr, /Could not remove ambient MCP servers/);
            // A missing config needs no stripping.
            fs.rmSync(path.join(home, 'config.toml'));
            assert.equal(runExclusiveStep(home, { PROPR_EXTENSION_EXCLUSIVE_MCP: '1' }).status, 0);
        } finally { fs.rmSync(home, { recursive: true, force: true }); }
    });
});

// Optional contract check against the pinned PyPI package (no API calls):
// PROPR_VIBE_PYTHON=/path/to/venv/bin/python npx tsx --test test/vibeExtensionRuntime.test.ts
// Install mistral-vibe==3.1.5 in that venv first.
test('installed Vibe 3 resolves only the run catalog and skills, and reaches a stub stdio server through the bridge', {
    skip: !process.env.PROPR_VIBE_PYTHON,
}, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-extension-contract-'));
    try {
        const home = path.join(root, 'home');
        const skills = path.join(root, 'extensions');
        fs.mkdirSync(path.join(home, 'skills', 'user-notes'), { recursive: true });
        fs.writeFileSync(path.join(home, 'config.toml'), USER_CONFIG);
        fs.writeFileSync(path.join(home, 'skills', 'user-notes', 'SKILL.md'), '---\nname: user-notes\ndescription: Ambient user skill\n---\nAmbient.\n');
        fs.mkdirSync(path.join(skills, 'bundle-1'), { recursive: true });
        fs.writeFileSync(path.join(skills, 'bundle-1', 'SKILL.md'), '---\nname: release-notes\ndescription: Writes release notes\n---\nWrite them.\n');
        // A stub MCP server that reports whether its secret arrived; the bridge redacts the value itself.
        const stub = path.join(root, 'stub-server.cjs');
        fs.writeFileSync(stub, `require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const rpc = JSON.parse(line); const reply = result => console.log(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  if (rpc.method === 'initialize') reply({ protocolVersion: rpc.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '1' } });
  else if (rpc.method === 'tools/list') reply({ tools: [{ name: 'whoami', description: 'Report the secret', inputSchema: { type: 'object', properties: {} } }] });
  else if (rpc.method === 'tools/call') reply({ content: [{ type: 'text', text: 'secret:' + (process.env.API_KEY === ${JSON.stringify(SECRET)} ? 'present' : 'missing') + ':' + process.env.API_KEY }] });
  else if (rpc.id !== undefined) reply({});
});\n`);
        const bridgeConfig = Buffer.from(JSON.stringify({ name: 'stub', executable: process.execPath, args: [stub], tools: ['whoami'], secretEnv: { API_KEY: 'PROPR_EXTENSION_STDIO_0_0_SECRET' } })).toString('base64url');
        const { env } = vibeToolPolicyArgs(extensionPolicy(bridgeConfig));
        const step = runExclusiveStep(home, { PROPR_EXTENSION_EXCLUSIVE_MCP: '1', VIBE_ENABLED_SKILLS: env.VIBE_ENABLED_SKILLS });
        assert.equal(step.status, 0, step.stderr);
        const result = spawnSync(process.env.PROPR_VIBE_PYTHON!, ['-I', '-c', `
import asyncio, contextlib, json, sys
from importlib.metadata import version
from vibe.core.config.harness_files import init_harness_files_manager
from vibe.core.config.default_orchestrator import build_default_orchestrator
from vibe.core.skills.manager import SkillManager
from vibe.core.tools.mcp.tools import build_stdio_params, enter_stdio_session, list_tools_stdio
assert version("mistral-vibe").startswith("3."), version("mistral-vibe")
init_harness_files_manager("user")
async def main():
    config = (await build_default_orchestrator()).config
    out = {"servers": [[s.name, s.transport, getattr(getattr(s, "auth", None), "api_key_env", None)] for s in config.mcp_servers],
           "skills": sorted(SkillManager(lambda: config).available_skills), "connectors": config.enable_connectors}
    stdio = next(s for s in config.mcp_servers if s.transport == "stdio")
    # The container runs /usr/local/bin/node /opt/propr/extension-stdio-bridge.mjs; use this checkout's.
    argv = [sys.argv[1], sys.argv[2], *stdio.argv()[2:]]
    out["tools"] = [t.name for t in await list_tools_stdio(argv, env=stdio.env or None)]
    async with contextlib.AsyncExitStack() as stack:
        session = await enter_stdio_session(stack, build_stdio_params(argv, env=stdio.env or None), init_timeout=20)
        out["call"] = json.dumps((await session.call_tool("whoami", {})).model_dump(mode="json"))
    print(json.dumps(out))
asyncio.run(main())
`, process.execPath, BRIDGE], {
            // The secret is not in Vibe's own environment: it reaches the server only through the entry's env.
            env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, VIBE_HOME: home, MISTRAL_API_KEY: 'test-key', ...env, VIBE_SKILL_PATHS: JSON.stringify([skills]), VIBE_ENABLE_CONNECTORS: step.vars.connectors },
            encoding: 'utf8', timeout: 60_000,
        });
        assert.equal(result.status, 0, result.stderr);
        const resolved = JSON.parse(result.stdout.trim().split('\n').at(-1)!);
        assert.deepEqual(resolved.servers, [['stub', 'stdio', null], ['propr', 'streamable-http', 'PROPR_MCP_BEARER_TOKEN'], ['docs', 'streamable-http', 'PROPR_EXTENSION_MCP_0_TOKEN']]);
        assert.deepEqual(resolved.skills, ['release-notes']);
        assert.equal(resolved.connectors, false);
        assert.deepEqual(resolved.tools, ['whoami']);
        assert.match(resolved.call, /secret:present:\[REDACTED\]/);
        assert.ok(!result.stdout.includes(SECRET));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

describe('Vibe 3 MCP tool effects', () => {
    const base = { sessionId: 's', turnId: 'turn-1', generationStatus: 'completed', createdAt: 1795777800000 };
    const effects = [
        { ...base, id: 'e1', type: 'effect', toolCallId: 'mcp-1', title: 'mcp_docs.lookup',
            detail: { toolName: 'mcp_docs.lookup', kind: 'mcp', input: { query: 'release' } },
            state: { status: 'completed', outputText: 'Release 1.2 notes' } },
        { ...base, id: 'e2', type: 'effect', toolCallId: 'mcp-2', title: 'mcp_stub.whoami',
            detail: { toolName: 'mcp_stub.whoami', kind: 'mcp', input: {} },
            state: { status: 'failed', outputText: '', error: { message: 'MCP request failed' } } },
        { ...base, id: 'a', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
    ];

    test('render as tool_use/tool_result in the live Redis view', () => {
        const parsed = parseRedisOutput(effects.map(entry => JSON.stringify(entry)));
        assert.deepEqual(parsed.events.map(event => [event.type, event.toolName ?? event.toolUseId ?? event.content]), [
            ['tool_use', 'mcp_docs.lookup'], ['tool_result', 'mcp-1'], ['tool_use', 'mcp_stub.whoami'], ['tool_result', 'mcp-2'], ['thought', 'Done.'],
        ]);
        assert.deepEqual(parsed.events[0].input, { query: 'release' });
        assert.equal(parsed.events[1].result, 'Release 1.2 notes');
        assert.equal(parsed.events[1].isError, false);
        assert.equal(parsed.events[3].isError, true);
    });

    test('render as tool_use/tool_result in the persisted conversation log', () => {
        const log = parseVibeConversationLog(effects.map(entry => JSON.stringify(entry)).join('\n'));
        const blocks = log.map(entry => entry.message.content[0]);
        assert.deepEqual(blocks.slice(0, 4), [
            { type: 'tool_use', id: 'mcp-1', name: 'mcp_docs.lookup', input: { query: 'release' } },
            { type: 'tool_result', tool_use_id: 'mcp-1', content: 'Release 1.2 notes', is_error: false },
            { type: 'tool_use', id: 'mcp-2', name: 'mcp_stub.whoami', input: {} },
            { type: 'tool_result', tool_use_id: 'mcp-2', content: 'MCP request failed', is_error: true },
        ]);
    });
});
