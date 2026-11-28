import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { antigravityMcpConfigTemplate, antigravityToolPolicyArgs, antigravityToolPolicyEnvironment, MCP_LAUNCH_BUILDERS } from '../packages/core/src/agents/mcpLaunch/index.ts';
import { buildAntigravityDockerArgs } from '../packages/core/src/agents/impl/utils/antigravityDockerArgsBuilder.ts';
import type { AgentToolPolicy } from '../packages/core/src/agents/types.ts';

/**
 * Antigravity extension launch: the worker passes a token-free MCP config
 * template and the token by name; the entrypoint writes the real header into
 * a container-only `mcp_config.json` (node-owned, 0600, deleted after the
 * run), copies staged skills to `<HOME>/.gemini/skills/<name>` and stops on a
 * 401 instead of letting agy wait in OAuth discovery.
 */

// The args builder's imports open the Core SQLite connection; close it so the suite exits.
after(async () => {
    const { closeConnection } = await import('../packages/core/src/db/connection.ts');
    await closeConnection();
});

const TOKEN = 'AntigravityRunToken_0123456789abcdefghijklmn';
const STDIO_SECRET = 'ANTIGRAVITY_STDIO_SECRET_SENTINEL';
const ENTRYPOINT = resolve('scripts/antigravity-entrypoint.sh');
const BRIDGE = resolve('scripts/extension-stdio-bridge.mjs');

// A stub stdio MCP server: answers initialize and tools/list, echoing whether its secret arrived.
const STDIO_SERVER = `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const rpc=JSON.parse(line);if(rpc.id===undefined)return;const result=rpc.method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'stub',version:'1'}}:{tools:[{name:'lookup',description:process.env.API_KEY===${JSON.stringify(STDIO_SECRET)}?'secret-ok':'secret-missing',inputSchema:{type:'object',properties:{}}}]};console.log(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result}));});`;
const bridgeConfig = Buffer.from(JSON.stringify({ name: 'local', executable: process.execPath, args: ['-e', STDIO_SERVER], tools: ['lookup'], secretEnv: { API_KEY: 'PROPR_EXTENSION_STDIO_0_0_SECRET' } })).toString('base64url');

function policy(url: string, overrides: Partial<AgentToolPolicy> = {}): AgentToolPolicy {
    const local = { name: 'local', bridgeConfig } as NonNullable<AgentToolPolicy['localMcpServers']>[number];
    Object.defineProperty(local, 'env', { value: { PROPR_EXTENSION_STDIO_0_0_SECRET: STDIO_SECRET }, enumerable: false });
    return {
        allowWeb: true, exclusiveMcp: true, localMcpServers: [local],
        mcpServers: [{ name: 'docs', url, bearerTokenEnv: 'PROPR_EXTENSION_MCP_0_TOKEN', bearerToken: TOKEN }],
        skills: [{ id: 'bundle-1', name: 'release-notes' }],
        ...overrides,
    };
}

/** Container `-e` arguments to an environment, with names-only entries taken from `values`. */
function containerEnvironment(args: string[], values: Record<string, string>): Record<string, string> {
    const env: Record<string, string> = {};
    for (let i = 0; i < args.length; i++) {
        if (args[i] !== '-e') continue;
        const entry = args[++i]; const at = entry.indexOf('=');
        if (at < 0) env[entry] = values[entry]; else env[entry.slice(0, at)] = entry.slice(at + 1);
    }
    return env;
}

describe('Antigravity MCP launch builder', () => {
    test('renders the config template without any token and passes tokens by name', () => {
        const run = policy('http://api:4000/api/extensions/mcp/docs', { dockerNetwork: 'propr_default' });
        const template = antigravityMcpConfigTemplate(run)!;
        assert.ok(!template.includes(TOKEN));
        assert.deepEqual(JSON.parse(template), { mcpServers: {
            local: { command: '/usr/local/bin/node', args: ['/opt/propr/extension-stdio-bridge.mjs', bridgeConfig] },
            docs: { serverUrl: 'http://api:4000/api/extensions/mcp/docs', bearerTokenEnv: 'PROPR_EXTENSION_MCP_0_TOKEN' },
        } });
        const launch = antigravityToolPolicyArgs(run);
        assert.deepEqual(launch.cliArgs, []);
        assert.equal(launch.env.PROPR_EXTENSION_MCP_0_TOKEN, TOKEN);
        assert.equal(launch.env.PROPR_EXTENSION_STDIO_0_0_SECRET, STDIO_SECRET);
        assert.ok(!JSON.stringify(launch).includes(STDIO_SECRET), 'stdio secrets stay out of serialization');
        assert.equal(MCP_LAUNCH_BUILDERS.antigravity, antigravityToolPolicyArgs);

        const args = buildAntigravityDockerArgs({
            worktreePath: '/tmp/worktree', githubToken: 'gh', issueNumber: 7, taskId: 'task-1', configPath: '/host/.gemini',
            dockerImage: 'propr/agent:latest', shellCommand: 'exec agy "$@"', toolPolicy: run, gitMountArgs: [],
        });
        assert.ok(!args.some(arg => arg.includes(TOKEN) || arg.includes(STDIO_SECRET)), 'no secret value in docker arguments');
        assert.equal(args[args.indexOf('--network') + 1], 'propr_default');
        const env = containerEnvironment(args, {});
        assert.ok('PROPR_EXTENSION_MCP_0_TOKEN' in env && 'PROPR_EXTENSION_STDIO_0_0_SECRET' in env);
        assert.equal(env.PROPR_ANTIGRAVITY_MCP_CONFIG, template);
        assert.equal(env.PROPR_EXTENSION_EXCLUSIVE_MCP, '1');
        assert.equal(env.PROPR_ANTIGRAVITY_SKILLS, 'bundle-1:release-notes');
        assert.equal(env.PROPR_EPHEMERAL_STATE, '1');
    });

    test('a web-only policy adds no MCP environment and goal mode refuses a policy', () => {
        assert.deepEqual(antigravityToolPolicyEnvironment({ allowWeb: false }), []);
        assert.throws(() => buildAntigravityDockerArgs({
            worktreePath: '/tmp/worktree', githubToken: 'gh', issueNumber: 7, configPath: '/host/.gemini', dockerImage: 'propr/agent:latest',
            shellCommand: 'exec agy "$@"', executionMode: 'goal', toolPolicy: policy('http://api:4000/api/extensions/mcp/docs'), gitMountArgs: [],
        }), /disposable task runtime/);
        assert.throws(() => antigravityToolPolicyEnvironment({ allowWeb: true, skills: [{ id: '../x', name: 'x' }] }), /Invalid skill bundle/);
    });
});

describe('Antigravity entrypoint with run MCP servers and skills', { skip: process.platform !== 'linux' }, () => {
    let server: Server;
    let status = 200;
    const authorizations: string[] = [];
    let root: string;
    before(async () => {
        server = createServer((req, res) => {
            authorizations.push(String(req.headers.authorization ?? ''));
            req.resume(); req.on('end', () => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(status === 200 ? '{"jsonrpc":"2.0","id":"propr-preflight","result":{}}' : '{"error":"Extension MCP unavailable"}'); });
        });
        await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
        root = mkdtempSync(join(tmpdir(), 'propr-antigravity-extensions-'));
        // The gh wrapper links into the real /home/node/bin; this suite is not about it.
        writeFileSync(join(root, 'entrypoint.sh'), readFileSync(ENTRYPOINT, 'utf8').replaceAll('/usr/local/bin/gh-wrapper', join(root, 'no-gh-wrapper'))
            .replaceAll('/opt/propr/privileged-post-task.sh', resolve('scripts/privileged-post-task.sh')));
    });
    after(() => { server?.close(); if (root) rmSync(root, { recursive: true, force: true }); });

    async function runEntrypoint(name: string, run: AgentToolPolicy, seed?: Record<string, unknown>) {
        const base = join(root, name);
        const home = join(base, 'runtime'); const source = join(base, 'host-gemini'); const skills = join(base, 'extensions'); const observation = join(base, 'observation.json');
        mkdirSync(join(source, 'antigravity-cli'), { recursive: true });
        writeFileSync(join(source, 'antigravity-cli', 'settings.json'), '{}\n');
        mkdirSync(join(skills, 'bundle-1'), { recursive: true });
        writeFileSync(join(skills, 'bundle-1', 'SKILL.md'), '---\nname: release-notes\ndescription: Write release notes\n---\nBody\n');
        if (seed) {
            // As if copied from the host ~/.gemini: an ambient server and an ambient skill.
            mkdirSync(join(home, '.gemini', 'config'), { recursive: true });
            writeFileSync(join(home, '.gemini', 'config', 'mcp_config.json'), JSON.stringify(seed));
            mkdirSync(join(home, '.gemini', 'skills', 'ambient'), { recursive: true });
            writeFileSync(join(home, '.gemini', 'skills', 'ambient', 'SKILL.md'), 'ambient');
        }
        // Stub agy: records what it sees, then talks to the stdio server exactly as configured.
        const agy = join(base, 'agy');
        writeFileSync(agy, `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path'); const { spawn } = require('node:child_process');
const file = path.join(process.env.HOME, '.gemini', 'config', 'mcp_config.json');
const config = JSON.parse(fs.readFileSync(file, 'utf8'));
const mode = (fs.statSync(file).mode & 0o777).toString(8);
const skills = fs.readdirSync(path.join(process.env.HOME, '.gemini', 'skills')).sort();
const skill = fs.existsSync(path.join(process.env.HOME, '.gemini', 'skills', 'release-notes', 'SKILL.md'));
const local = config.mcpServers.local;
const observe = tools => { fs.writeFileSync(${JSON.stringify(observation)}, JSON.stringify({ config, mode, skills, skill, tools, tokenEnv: process.env.PROPR_EXTENSION_MCP_0_TOKEN ?? null, template: process.env.PROPR_ANTIGRAVITY_MCP_CONFIG ?? null })); process.exit(0); };
if (!local) observe(null);
const args = local.args.map(arg => arg === '/opt/propr/extension-stdio-bridge.mjs' ? ${JSON.stringify(BRIDGE)} : arg);
const child = spawn(local.command === '/usr/local/bin/node' ? process.execPath : local.command, args, { stdio: ['pipe', 'pipe', 'inherit'] });
let buffer = '';
child.stdout.on('data', chunk => { buffer += chunk; for (const line of buffer.split('\\n').slice(0, -1)) { const rpc = JSON.parse(line); if (rpc.id === 2) { child.kill(); observe(rpc.result.tools.map(t => t.name + ':' + t.description)); } } buffer = buffer.slice(buffer.lastIndexOf('\\n') + 1); });
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\\n');
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\\n');
setTimeout(() => { console.error('stub agy timed out'); process.exit(9); }, 8000);
`);
        chmodSync(agy, 0o755);
        const args = buildAntigravityDockerArgs({
            worktreePath: '/tmp/worktree', githubToken: 'gh', issueNumber: 7, taskId: 'task-1', configPath: source,
            dockerImage: 'propr/agent:latest', shellCommand: 'exec agy "$@"', toolPolicy: run, gitMountArgs: [],
        });
        const env = {
            ...containerEnvironment(args, antigravityToolPolicyArgs(run).env),
            PATH: process.env.PATH ?? '', HOME: join(base, 'process-home'),
            PROPR_ANTIGRAVITY_SOURCE_CONFIG: source, PROPR_ANTIGRAVITY_RUNTIME_HOME: home, PROPR_EXTENSION_SKILLS_ROOT: skills,
        };
        mkdirSync(env.HOME, { recursive: true });
        const result = await new Promise<{ code: number | null; stderr: string }>(done => {
            const child = spawn('bash', [join(root, 'entrypoint.sh'), agy], { env, stdio: ['ignore', 'ignore', 'pipe'] });
            let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
            child.on('close', code => done({ code, stderr }));
        });
        return { ...result, home, source, observation: existsSync(observation) ? JSON.parse(readFileSync(observation, 'utf8')) : null };
    }
    const url = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/extensions/mcp/docs`;

    test('writes the token only into a 0600 container config, replaces ambient config, copies skills and deletes the config', async () => {
        status = 200; authorizations.length = 0;
        const { code, stderr, home, source, observation } = await runEntrypoint('exclusive', policy(url()), { mcpServers: { ambient: { serverUrl: 'https://ambient.invalid/mcp' } } });
        assert.equal(code, 0, stderr);
        assert.deepEqual(observation.config.mcpServers.docs, { serverUrl: url(), headers: { Authorization: `Bearer ${TOKEN}` } });
        assert.equal(observation.config.mcpServers.ambient, undefined, 'exclusive runs replace the copied config');
        assert.equal(observation.mode, '600');
        assert.deepEqual(observation.skills, ['release-notes'], 'exclusive runs start from an empty skills directory');
        assert.equal(observation.skill, true);
        assert.equal(observation.tokenEnv, null, 'the agent process does not get the token');
        assert.equal(observation.template, null);
        // The stub stdio server answered through the real bridge with its secret from the inherited env.
        assert.deepEqual(observation.tools, ['lookup:secret-ok']);
        // The preflight used the substituted header.
        assert.deepEqual(authorizations, [`Bearer ${TOKEN}`]);
        assert.equal(existsSync(join(home, '.gemini', 'config', 'mcp_config.json')), false, 'deleted after the run');
        assert.ok(!readdirSync(source, { recursive: true }).some(entry => String(entry).includes('mcp_config')), 'never copied to the host directory');
        assert.ok(!stderr.includes(TOKEN));
    });

    test('non-exclusive runs keep the copied config and skills', async () => {
        status = 200;
        const { code, stderr, observation } = await runEntrypoint('shared', policy(url(), { exclusiveMcp: false }), { mcpServers: { ambient: { serverUrl: 'https://ambient.invalid/mcp' } } });
        assert.equal(code, 0, stderr);
        assert.deepEqual(Object.keys(observation.config.mcpServers).sort(), ['ambient', 'docs', 'local']);
        assert.deepEqual(observation.skills, ['ambient', 'release-notes']);
    });

    test('a 401 stops the run with a clear error instead of an OAuth wait', async () => {
        status = 401;
        const { code, stderr, home, observation } = await runEntrypoint('unauthorized', policy(url()));
        assert.equal(code, 3);
        assert.match(stderr, /PROPR_MCP_AUTH_FAILED: MCP server "docs" refused the run credential \(HTTP 401\)/);
        assert.equal(observation, null, 'agy never started');
        assert.equal(existsSync(join(home, '.gemini', 'config', 'mcp_config.json')), false);
        assert.ok(!stderr.includes(TOKEN));
    });

});
