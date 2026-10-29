import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

import {
    claudeToolPolicyArgs,
    codexToolPolicyArgs,
    PROPR_MCP_BEARER_TOKEN_ENV,
    PROPR_MCP_SERVER_NAME,
    type ToolPolicyLaunchArgs,
} from '../packages/core/src/agents/agentToolPolicy.ts';
import type { AgentToolPolicy } from '../packages/core/src/agents/types.ts';

/**
 * Compatibility check against the CLI versions pinned in Dockerfile.agent: the
 * generated switches must change what the runtime actually offers the model,
 * not only the argument list. Each CLI talks to a local stand-in for the model
 * API and the ProPR MCP server; the first model request shows the effective
 * tools and the MCP server sees the Authorization header the runtime sent.
 * Skipped unless the pinned version is installed on PATH.
 */

const TOKEN = 'propr_mcp_runtime_token_0123456789';
const MCP_TOOL = 'policy_probe';
const LOCAL_SENTINEL = 'UNMISTAKABLE_LOCAL_CATALOG_RUNTIME_SENTINEL';
const localPolicy = (): AgentToolPolicy => ({ allowWeb: false, exclusiveMcp: true, localMcpServers: [{ name: 'local', bridgeConfig: Buffer.from(JSON.stringify({ name: 'local', executable: process.execPath, args: ['-e', `const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const rpc=JSON.parse(line);if(rpc.id===undefined)return;const result=rpc.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:rpc.method==='tools/list'?{tools:[{name:'policy_probe',description:process.env.API_KEY,inputSchema:{type:'object',properties:{}}},{name:'unselected',inputSchema:{type:'object',properties:{}}}]}:{content:[{type:'text',text:process.env.API_KEY}]};console.log(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result}));});`], tools: ['policy_probe'], secretEnv: { API_KEY: 'PROPR_EXTENSION_STDIO_0_0_SECRET' } })).toString('base64url'), env: { PROPR_EXTENSION_STDIO_0_0_SECRET: LOCAL_SENTINEL } }] });

function pinnedVersion(arg: string): string {
    const match = readFileSync(new URL('../Dockerfile.agent', import.meta.url), 'utf8').match(new RegExp(`^ARG ${arg}=(\\S+)$`, 'm'));
    assert.ok(match, `${arg} is pinned in Dockerfile.agent`);
    return match[1];
}

function skipUnlessPinned(command: string, arg: string): string | false {
    const pinned = pinnedVersion(arg);
    const probe = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 30_000 });
    if (probe.status !== 0) return `${command} CLI is not installed`;
    return probe.stdout.includes(pinned) ? false : `${command} ${probe.stdout.trim()} is not the pinned ${pinned}`;
}

interface Captured {
    mcpAuthorizations: string[];
    mcpMethods: string[];
    modelBodies: Record<string, unknown>[];
}

function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('error', reject);
        req.on('end', () => {
            let body = Buffer.concat(chunks);
            const encoding = req.headers['content-encoding'];
            if (encoding === 'zstd') body = zlib.zstdDecompressSync(body);
            else if (encoding === 'gzip') body = zlib.gunzipSync(body);
            resolve(body.toString('utf8'));
        });
    });
}

/** Streamable-HTTP MCP server with one tool at `/mcp`; every other POST is a model request that is recorded and refused. */
function startStandIn(captured: Captured): Promise<Server> {
    const server = createServer(async (req, res) => {
        const raw = await readBody(req);
        const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
        if (req.url?.startsWith('/mcp')) {
            captured.mcpAuthorizations.push(req.headers.authorization ?? '');
            if (req.method !== 'POST') { res.writeHead(405).end(); return; }
            captured.mcpMethods.push(String(body.method));
            if (body.id === undefined) { res.writeHead(202).end(); return; }
            const params = body.params as { protocolVersion?: string } | undefined;
            const result = body.method === 'initialize'
                ? { protocolVersion: params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'stand-in', version: '1' } }
                : body.method === 'tools/list'
                    ? { tools: [{ name: MCP_TOOL, description: 'Policy probe', inputSchema: { type: 'object', properties: {} } }] }
                    : {};
            res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
            return;
        }
        if (req.method === 'POST') captured.modelBodies.push(body);
        // A non-retryable refusal ends the run right after the first request.
        res.writeHead(400, { 'content-type': 'application/json' })
            .end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'stand-in stops here' } }));
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/** Resolves with the tail of stderr so a run that never reaches the stand-in explains why. */
function runCli(command: string, args: string[], env: Record<string, string>, stdin: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
        let stderr = '';
        child.stdout.on('data', chunk => { assert.ok(!chunk.toString().includes(LOCAL_SENTINEL)); });
        child.stderr.on('data', chunk => { assert.ok(!chunk.toString().includes(LOCAL_SENTINEL)); stderr = (stderr + chunk.toString()).slice(-2000); });
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${command} did not finish`)); }, 90_000);
        child.on('error', reject);
        child.on('close', () => { clearTimeout(timer); resolve(stderr.trim()); });
        child.stdin.end(stdin);
    });
}

/** Tool names from Anthropic `tools` or from Responses API tools, including Codex `additional_tools` input items. */
function toolNames(body: Record<string, unknown>): string[] {
    const walk = (tools: unknown): string[] => (Array.isArray(tools) ? tools : []).flatMap((tool: { type?: string; name?: string; tools?: unknown }) =>
        tool.type === 'namespace' ? walk(tool.tools) : [tool.name ?? tool.type ?? '']);
    const input = Array.isArray(body.input) ? body.input as Array<{ type?: string; tools?: unknown }> : [];
    return [...walk(body.tools), ...input.filter(item => item.type === 'additional_tools').flatMap(item => walk(item.tools))];
}

interface RuntimeObservation extends Captured { tools: string[] }

function runtimeHarness(build: (policy: AgentToolPolicy) => ToolPolicyLaunchArgs, launch: (input: {
    baseUrl: string; home: string; launchArgs: ToolPolicyLaunchArgs;
}) => { command: string; args: string[]; env: Record<string, string> }) {
    let server: Server;
    let captured: Captured;
    let home: string;
    before(async () => {
        captured = { mcpAuthorizations: [], mcpMethods: [], modelBodies: [] };
        server = await startStandIn(captured);
        home = mkdtempSync(join(tmpdir(), 'propr-tool-policy-runtime-'));
    });
    after(() => {
        server?.close();
        if (home) rmSync(home, { recursive: true, force: true });
    });
    return async (policy: AgentToolPolicy, mcp: boolean, ambient = false): Promise<RuntimeObservation> => {
        captured.mcpAuthorizations.length = 0;
        captured.mcpMethods.length = 0;
        captured.modelBodies.length = 0;
        const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        mkdirSync(join(home, '.codex'), { recursive: true });
        writeFileSync(join(home, '.codex', 'config.toml'), ambient ? `[mcp_servers.ambient]\nurl="${baseUrl}/mcp-ambient"\n` : '');
        writeFileSync(join(home, '.claude.json'), JSON.stringify(ambient ? { mcpServers: { ambient: { type: 'http', url: `${baseUrl}/mcp-ambient` } } } : {}));
        const withMcp: AgentToolPolicy = mcp ? {
            ...policy,
            mcpServers: [{ name: PROPR_MCP_SERVER_NAME, url: `${baseUrl}/mcp`, bearerTokenEnv: PROPR_MCP_BEARER_TOKEN_ENV, bearerToken: TOKEN }],
        } : policy;
        const launchArgs = build(withMcp);
        assert.ok(!launchArgs.cliArgs.some(arg => arg.includes(TOKEN)), 'the token never appears in the arguments');
        // Outside Docker, map only the image-installed adapter and its Node to this
        // test's exact sources: a host Node at the image path may be absent or another version.
        if (policy.localMcpServers?.length) launchArgs.cliArgs = launchArgs.cliArgs.map(arg => arg
            .replaceAll('/opt/propr/extension-stdio-bridge.mjs', fileURLToPath(new URL('../scripts/extension-stdio-bridge.mjs', import.meta.url)))
            .replaceAll('/usr/local/bin/node', process.execPath));
        const { command, args, env } = launch({ baseUrl, home, launchArgs });
        // Only the temporary home: never the host user's agent config, logins or caches.
        const xdg = { XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'), XDG_STATE_HOME: join(home, '.local', 'state'), XDG_CACHE_HOME: join(home, '.cache') };
        const stderr = await runCli(command, args, { PATH: process.env.PATH ?? '', HOME: home, ...xdg, ...env, ...launchArgs.env }, 'Reply with OK.');
        assert.ok(captured.modelBodies.length > 0, `${command} reached the model stand-in${stderr ? `; stderr: ${stderr}` : ''}`);
        assert.ok(!JSON.stringify(captured).includes(LOCAL_SENTINEL));
        return { ...captured, tools: toolNames(captured.modelBodies[0]) };
    };
}

describe('Claude Code runtime honours the tool policy', { skip: skipUnlessPinned('claude', 'CLAUDE_CLI_VERSION') }, () => {
    const run = runtimeHarness(claudeToolPolicyArgs, ({ baseUrl, launchArgs }) => ({
        command: 'claude',
        // Mirrors buildDockerArgs for task mode; the policy switches come last.
        args: ['-p', '-', '--no-session-persistence', '--max-turns', '1', '--output-format', 'stream-json', '--verbose',
            '--dangerously-skip-permissions', ...launchArgs.cliArgs],
        // IS_SANDBOX lets --dangerously-skip-permissions run when the CI runner executes tests as root.
        env: { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_API_KEY: 'stand-in-key', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', IS_SANDBOX: '1' },
    }));

    test('without a restriction the web tools are offered', { timeout: 120_000 }, async () => {
        const { tools } = await run({ allowWeb: true }, false);
        assert.ok(tools.includes('WebFetch') && tools.includes('WebSearch'), `tools: ${tools.join(', ')}`);
    });

    test('local catalog adapter offers only selected tools without credential serialization', { timeout: 120_000 }, async () => {
        const { tools } = await run(localPolicy(), false, true);
        assert.ok(tools.includes('mcp__local__policy_probe'), tools.join(', '));
        assert.ok(!tools.some(name => name.includes('unselected') || name.includes('ambient')));
    });

    test('exclusive profile catalogs retain only selected MCP tools with env authentication', { timeout: 120_000 }, async () => {
        const { tools, mcpAuthorizations } = await run({ allowWeb: false, exclusiveMcp: true }, true, true);
        assert.ok(tools.includes(`mcp__${PROPR_MCP_SERVER_NAME}__${MCP_TOOL}`));
        assert.ok(!tools.some(name => name.includes('ambient')), tools.join(', '));
        assert.ok(mcpAuthorizations.every(header => header === `Bearer ${TOKEN}`));
    });

    test('web off removes the web tools and the MCP server authenticates with the expanded token', { timeout: 120_000 }, async () => {
        const { tools, mcpAuthorizations, mcpMethods } = await run({ allowWeb: false }, true);
        assert.ok(!tools.includes('WebFetch') && !tools.includes('WebSearch'), `tools: ${tools.join(', ')}`);
        assert.ok(tools.includes(`mcp__${PROPR_MCP_SERVER_NAME}__${MCP_TOOL}`), `tools: ${tools.join(', ')}`);
        assert.ok(mcpMethods.includes('tools/list'));
        assert.ok(mcpAuthorizations.length > 0);
        assert.ok(mcpAuthorizations.every(header => header === `Bearer ${TOKEN}`), `Authorization: ${mcpAuthorizations.join(', ')}`);
    });
});

describe('Codex runtime honours the tool policy', { skip: skipUnlessPinned('codex', 'CODEX_CLI_VERSION') }, () => {
    const run = runtimeHarness(codexToolPolicyArgs, ({ baseUrl, launchArgs }) => ({
        command: 'codex',
        // Mirrors buildCodexArgs for task mode, with a local model provider.
        args: ['exec', '--ephemeral', '--json', '--dangerously-bypass-approvals-and-sandbox', '--config', 'features.multi_agent=false',
            ...launchArgs.cliArgs, '--skip-git-repo-check', '--model', 'gpt-5.5',
            '-c', 'model_provider="standin"', '-c', 'model_providers.standin.name="stand-in"',
            '-c', `model_providers.standin.base_url="${baseUrl}/v1"`, '-c', 'model_providers.standin.wire_api="responses"',
            '-c', 'model_providers.standin.env_key="STAND_IN_KEY"', '-c', 'model_providers.standin.request_max_retries=0',
            '-c', 'model_providers.standin.stream_max_retries=0', '-'],
        env: { STAND_IN_KEY: 'stand-in-key' },
    }));

    test('without a restriction the web search tool is offered', { timeout: 120_000 }, async () => {
        const { tools } = await run({ allowWeb: true }, false);
        assert.ok(tools.includes('web_search'), `tools: ${tools.join(', ')}`);
    });

    test('local catalog adapter uses native stdio and excludes ambient tools and credential values', { timeout: 120_000 }, async () => {
        const { tools, modelBodies } = await run(localPolicy(), false, true);
        assert.ok(!tools.some(name => name.includes('unselected') || name.includes('ambient')));
        // Deferred tools still carry the selected server inventory in Responses input.
        assert.match(JSON.stringify(modelBodies), /local/);
    });

    test('exclusive profile catalogs retain only selected MCP tools with env authentication', { timeout: 120_000 }, async () => {
        const { tools, mcpAuthorizations, mcpMethods } = await run({ allowWeb: false, exclusiveMcp: true }, true, true);
        assert.ok(mcpMethods.includes('tools/list'));
        assert.ok(mcpAuthorizations.length > 0);
        assert.ok(!tools.some(name => name.includes('ambient')), tools.join(', '));
        assert.ok(mcpAuthorizations.every(header => header === `Bearer ${TOKEN}`));
    });

    test('web off removes web search and the MCP server authenticates from the token variable', { timeout: 120_000 }, async () => {
        const { tools, mcpAuthorizations, mcpMethods } = await run({ allowWeb: false }, true);
        assert.ok(!tools.includes('web_search'), `tools: ${tools.join(', ')}`);
        // Codex defers MCP tools behind tool search, so the MCP handshake is the evidence.
        assert.ok(mcpMethods.includes('tools/list'));
        assert.ok(mcpAuthorizations.length > 0);
        assert.ok(mcpAuthorizations.every(header => header === `Bearer ${TOKEN}`), `Authorization: ${mcpAuthorizations.join(', ')}`);
    });
});

describe('Codex extension configuration on the pinned CLI', { skip: skipUnlessPinned('codex', 'CODEX_CLI_VERSION') }, () => {
    test('ignoring user config also removes the operator provider and base URL', { timeout: 120_000 }, async () => {
        const home = mkdtempSync(join(tmpdir(), 'codex-extension-provider-'));
        const requests: string[] = [];
        const server = createServer(async (req, res) => {
            await readBody(req); requests.push(req.url ?? '');
            res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'fixture ends here' } }));
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        try {
            const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
            writeFileSync(join(home, 'config.toml'), `model_provider="operator"\n[model_providers.operator]\nname="Operator"\nbase_url="${baseUrl}/operator"\nwire_api="responses"\nenv_key="FIXTURE_OPERATOR_KEY"\nrequest_max_retries=0\nstream_max_retries=0\n`);
            const env = { PATH: process.env.PATH ?? '', HOME: home, CODEX_HOME: home, FIXTURE_OPERATOR_KEY: 'synthetic-operator-key' };
            const args = ['exec', '--ephemeral', '--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '--model', 'gpt-5.5', '-c', 'features.multi_agent=false', '-'];
            const ordinary = await runCli('codex', args, env, 'Reply OK.');
            assert.ok(requests.some(url => url.startsWith('/operator/')), ordinary);
            requests.length = 0;
            const exclusive = await runCli('codex', [...args.slice(0, -1), ...codexToolPolicyArgs({ allowWeb: false, exclusiveMcp: true }).cliArgs, '-c', 'model_provider="operator"', '-'], env, 'Reply OK.');
            assert.equal(requests.length, 0);
            assert.match(exclusive, /[Pp]rovider.*operator.*not found/);
        } finally { server.close(); rmSync(home, { recursive: true, force: true }); }
    });
});

test('Codex entrypoint rejects container project ancestry after setup and skips ignored user configuration', () => {
    const script = readFileSync(new URL('../scripts/codex-entrypoint.sh', import.meta.url), 'utf8');
    const guard = script.slice(script.indexOf('if [ "${PROPR_EXTENSION_EXCLUSIVE_MCP'), script.indexOf('# If arguments are provided'));
    assert.ok(guard.includes('cannot load project MCP configuration'));
    const root = mkdtempSync(join(tmpdir(), 'codex-container-ancestry-'));
    const workspace = join(root, 'home', 'node', 'workspace');
    const userHome = join(root, 'home', 'node', '.codex');
    mkdirSync(workspace, { recursive: true }); mkdirSync(userHome);
    writeFileSync(join(userHome, 'config.toml'), 'model_provider="operator"');
    const containerGuard = guard.replace('cd /home/node/workspace', `cd '${workspace}'`);
    const run = (exclusive: string) => spawnSync('bash', ['-c', `set -e\n${containerGuard}`], { env: { ...process.env, CODEX_HOME: userHome, PROPR_EXTENSION_EXCLUSIVE_MCP: exclusive }, encoding: 'utf8' });
    try {
        assert.equal(run('1').status, 0);
        // A repository setup hook may create this after host-side validation.
        mkdirSync(join(workspace, '.codex')); writeFileSync(join(workspace, '.codex', 'config.toml'), '[mcp_servers.ambient]\ncommand="unselected"');
        assert.equal(run('1').status, 1); assert.match(run('1').stderr, /project MCP configuration/);
        assert.equal(run('0').status, 0);
        rmSync(join(workspace, '.codex'), { recursive: true });
        mkdirSync(join(root, 'home', '.codex')); writeFileSync(join(root, 'home', '.codex', 'config.toml'), '[mcp_servers.ambient]');
        assert.equal(run('1').status, 1);
        rmSync(workspace, { recursive: true });
        const missing = spawnSync('bash', ['-c', containerGuard], { env: { ...process.env, CODEX_HOME: userHome, PROPR_EXTENSION_EXCLUSIVE_MCP: '1' }, encoding: 'utf8', timeout: 2000 });
        assert.equal(missing.status, 1);
        assert.match(missing.stderr, /workspace unavailable/);
    } finally { rmSync(root, { recursive: true, force: true }); }
});
