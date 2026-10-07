import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
        const child = spawn(command, args, { env, stdio: ['pipe', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-2000); });
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
    return async (policy: AgentToolPolicy, mcp: boolean): Promise<RuntimeObservation> => {
        captured.mcpAuthorizations.length = 0;
        captured.mcpMethods.length = 0;
        captured.modelBodies.length = 0;
        const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const withMcp: AgentToolPolicy = mcp ? {
            ...policy,
            mcpServers: [{ name: PROPR_MCP_SERVER_NAME, url: `${baseUrl}/mcp`, bearerTokenEnv: PROPR_MCP_BEARER_TOKEN_ENV, bearerToken: TOKEN }],
        } : policy;
        const launchArgs = build(withMcp);
        assert.ok(!launchArgs.cliArgs.some(arg => arg.includes(TOKEN)), 'the token never appears in the arguments');
        const { command, args, env } = launch({ baseUrl, home, launchArgs });
        const stderr = await runCli(command, args, { PATH: process.env.PATH ?? '', HOME: home, ...env, ...launchArgs.env }, 'Reply with OK.');
        assert.ok(captured.modelBodies.length > 0, `${command} reached the model stand-in${stderr ? `; stderr: ${stderr}` : ''}`);
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

    test('web off removes web search and the MCP server authenticates from the token variable', { timeout: 120_000 }, async () => {
        const { tools, mcpAuthorizations, mcpMethods } = await run({ allowWeb: false }, true);
        assert.ok(!tools.includes('web_search'), `tools: ${tools.join(', ')}`);
        // Codex defers MCP tools behind tool search, so the MCP handshake is the evidence.
        assert.ok(mcpMethods.includes('tools/list'));
        assert.ok(mcpAuthorizations.length > 0);
        assert.ok(mcpAuthorizations.every(header => header === `Bearer ${TOKEN}`), `Authorization: ${mcpAuthorizations.join(', ')}`);
    });
});
