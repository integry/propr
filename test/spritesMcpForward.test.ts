import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import http from 'node:http';
import type net from 'node:net';
import { after, before, test } from 'node:test';
import ssh2 from 'ssh2';
import { closeConnection } from '../packages/core/src/db/connection.ts';
after(closeConnection);
import { AgentRunSpecBuilder, agentRunMcpGrant, agentRunNetwork } from '../packages/core/src/agents/runtime/agentRunSpec.ts';
import { agentRunNetworkPolicy } from '../packages/core/src/agents/runtime/agentRunNetworkPolicy.ts';
import { planAgentRunMcpTransport } from '../packages/core/src/agents/runtime/agentRunMcpTransport.ts';
import { DOCKER_RUNTIME_CAPABILITIES } from '../packages/core/src/agents/runtime/dockerRuntime.ts';
import { FlyMachinesRuntime } from '../packages/core/src/agents/runtime/flyMachinesRuntime.ts';
import { assertAgentRuntimeSupports } from '../packages/core/src/agents/runtime/registry.ts';
import { SpritesMcpForward, SpritesMcpForwardError } from '../packages/core/src/agents/runtime/sprites/spritesMcpForward.ts';
import {
    SPRITES_MCP_FORWARD_PORT, SPRITES_MCP_SSHD_PORT, isSpritesMcpForwardUrl, spritesMcpAuthorizedKey, spritesMcpForwardTarget, spritesMcpSshdConfig,
    type SpritesMcpForwardTarget,
} from '../packages/core/src/agents/runtime/sprites/spritesMcpForwardConfig.ts';
import { spriteNetworkPolicy } from '../packages/core/src/agents/runtime/sprites/spritesNetwork.ts';
import { SpritesRuntime } from '../packages/core/src/agents/runtime/spritesRuntime.ts';
import { WORKSPACE_TRANSPORT_SCRIPT } from '../packages/core/src/git/workspaceTransportScript.ts';
import logger from '../packages/core/src/utils/logger.ts';
import { agentRunToolPolicy } from '../src/jobs/agentRuns/toolPolicy.ts';
import { requestAgentRunMcpGrant } from '../src/jobs/agentRuns/mcpGrantClient.ts';
import { FakeSprite, FakeSprites } from './helpers/fakeSprites.ts';
import { FakeSpriteSshd } from './helpers/fakeSpriteSshd.ts';

const sprites = new SpritesRuntime(new FakeSprites(), {});
const FORWARD_URL = `http://127.0.0.1:${SPRITES_MCP_FORWARD_PORT}/api/mcp`;
const GRANT_TOKEN = 'grant-secret-token';

// --- the ProPR API stand-in: echoes the grant header and streams SSE --------
let api: http.Server;
let apiPort = 0;
const apiRequests: Array<{ url?: string; authorization?: string }> = [];
let releaseSecondEvent: () => void = () => {};
before(async () => {
    SpritesMcpForward.defaults = { retries: 2, retryDelayMs: 10 };
    api = http.createServer((req, res) => {
        apiRequests.push({ url: req.url, authorization: req.headers.authorization });
        if (req.url === '/api/mcp' && req.headers.accept === 'text/event-stream') {
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
            res.write('data: one\n\n');
            releaseSecondEvent = () => res.end('data: two\n\n');
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'get_task' }] } }));
    });
    await new Promise<void>(resolve => api.listen(0, '127.0.0.1', () => resolve()));
    apiPort = (api.address() as net.AddressInfo).port;
});
after(() => { api.closeAllConnections(); api.close(); });

const target = (): SpritesMcpForwardTarget => ({ protocol: 'http:', host: '127.0.0.1', port: apiPort, url: FORWARD_URL });

/** What the agent inside the Sprite does: an MCP POST to the loopback listener. */
function mcpCall(port: number, accept = 'application/json'): Promise<{ status: number; body: string; firstChunk: string }> {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/api/mcp', method: 'POST',
            headers: { Authorization: `Bearer ${GRANT_TOKEN}`, Accept: accept, 'Content-Type': 'application/json' } }, res => {
            let body = '';
            let firstChunk = '';
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => {
                if (!firstChunk) {
                    firstChunk = chunk;
                    releaseSecondEvent();
                }
                body += chunk;
            });
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body, firstChunk }));
        });
        req.on('error', reject);
        req.end('{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
    });
}

/** Wait for a condition the SSH server observes asynchronously (bounded by the test timeout). */
function until(condition: () => boolean): Promise<void> {
    return new Promise(resolve => { const poll = () => condition() ? resolve() : setTimeout(poll, 5); poll(); });
}

function forwardSprite() {
    const sprite = new FakeSprite('propr-forward');
    return { sprite, sshd: new FakeSpriteSshd(sprite) };
}

// --- transport selection ---------------------------------------------------

test('Sprites without a public HTTPS MCP URL select the SSH reverse forward to the internal API', () => {
    const none = planAgentRunMcpTransport(sprites, {});
    assert.equal(none.transport, 'ssh-reverse-forward');
    assert.equal(none.transport === 'ssh-reverse-forward' && none.url, FORWARD_URL);
    assert.match(none.reason, /SSH reverse forward/);
    for (const environment of [
        { API_PUBLIC_URL: 'http://propr.example.com' },
        { API_PUBLIC_URL: 'https://localhost:4000' },
        { API_PUBLIC_URL: 'https://192.168.1.20' },
        { PROPR_AGENT_MCP_URL: 'http://api:4000/api/mcp' },
        { PROPR_AGENT_MCP_URL: 'https://propr.internal/api/mcp' },
    ]) {
        assert.equal(planAgentRunMcpTransport(sprites, environment).transport, 'ssh-reverse-forward', JSON.stringify(environment));
        assert.equal(planAgentRunMcpTransport(sprites, environment, 'restricted').transport, 'ssh-reverse-forward', JSON.stringify(environment));
    }
    const prefixed = planAgentRunMcpTransport(sprites, { PROPR_INTERNAL_API_URL: 'http://propr-api:8080/propr/' });
    assert.equal(prefixed.transport === 'ssh-reverse-forward' && prefixed.url, `http://127.0.0.1:${SPRITES_MCP_FORWARD_PORT}/propr/api/mcp`);
    assert.deepEqual(spritesMcpForwardTarget({ PROPR_INTERNAL_API_URL: 'https://api.internal' }),
        { protocol: 'https:', host: 'api.internal', port: 443, url: FORWARD_URL });
    assert.deepEqual(spritesMcpForwardTarget({}), { protocol: 'http:', host: 'api', port: 4000, url: FORWARD_URL });
});

test('an explicit or public HTTPS MCP URL is used directly before the forward', () => {
    const cases: Array<[NodeJS.ProcessEnv, string]> = [
        [{ PROPR_SPRITES_MCP_URL: 'https://gateway.example.net/api/mcp' }, 'https://gateway.example.net/api/mcp'],
        [{ PROPR_AGENT_MCP_URL: 'https://mcp.example.com/api/mcp' }, 'https://mcp.example.com/api/mcp'],
        [{ API_PUBLIC_URL: 'https://propr.example.com/' }, 'https://propr.example.com/api/mcp'],
    ];
    for (const [environment, url] of cases) {
        for (const mode of ['open', 'restricted'] as const) {
            assert.deepEqual(planAgentRunMcpTransport(sprites, environment, mode).transport, 'reachable-url');
            const plan = planAgentRunMcpTransport(sprites, environment, mode);
            assert.equal(plan.transport === 'reachable-url' && plan.url, url);
        }
    }
    // An explicit Sprites endpoint is the operator's choice even when it is not public; open runs use it as given.
    assert.equal(planAgentRunMcpTransport(sprites, { PROPR_SPRITES_MCP_URL: 'http://10.0.0.5/api/mcp' }).transport, 'reachable-url');
});

test('runs are refused with an actionable message when neither a public URL nor the forward is possible', () => {
    const disabled = planAgentRunMcpTransport(sprites, { PROPR_SPRITES_MCP_FORWARD: '0' });
    assert.equal(disabled.transport, 'unavailable');
    assert.match(disabled.reason, /API_PUBLIC_URL/);
    const restricted = planAgentRunMcpTransport(sprites, { PROPR_SPRITES_MCP_FORWARD: 'off', PROPR_AGENT_MCP_URL: 'http://api:4000/api/mcp' }, 'restricted');
    assert.equal(restricted.transport, 'unavailable');
    assert.match(restricted.reason, /PROPR_SPRITES_MCP_URL/);
    for (const url of ['ftp://api:21', 'http://user:pass@api:4000', 'not a url', 'http://api:4000/?q=1']) {
        const refused = planAgentRunMcpTransport(sprites, { PROPR_INTERNAL_API_URL: url });
        assert.equal(refused.transport, 'unavailable', url);
        assert.match(refused.reason, /PROPR_SPRITES_MCP_URL \(or API_PUBLIC_URL\).*PROPR_INTERNAL_API_URL/);
    }
});

test('the forward is Sprites-only: Docker and Fly Machines keep their transports and refuse forward grants', () => {
    assert.equal(planAgentRunMcpTransport({ kind: 'docker', capabilities: DOCKER_RUNTIME_CAPABILITIES }, {}).transport, 'private-network');
    const fly = new FlyMachinesRuntime(undefined, {});
    assert.notEqual(planAgentRunMcpTransport(fly, {}).transport, 'ssh-reverse-forward');
    const spec = forwardSpec();
    assert.throws(() => assertAgentRuntimeSupports(fly, spec), { capability: 'mcp_reverse_forward' });
    assert.doesNotThrow(() => assertAgentRuntimeSupports(sprites, spec));
});

// --- grant plumbing --------------------------------------------------------

test('a forward plan yields a forward grant, tool policy and spec grant naming the loopback URL', async () => {
    const grant = await requestAgentRunMcpGrant('run-1', 'report', {
        environment: { SYSTEM_TASK_SECRET: 's', PROPR_INTERNAL_API_URL: 'http://api:4000' },
        planTransport: () => planAgentRunMcpTransport(sprites, {}),
        fetchImpl: (async () => new Response(JSON.stringify({ grantId: 'g', url: 'http://api:4000/api/mcp', token: GRANT_TOKEN, expiresAt: 1 }))) as typeof fetch,
    });
    assert.equal(grant.transport, 'ssh-reverse-forward');
    assert.equal(grant.url, FORWARD_URL);
    assert.equal(grant.network, null);
    const policy = agentRunToolPolicy({ phase: 'action', capabilities: [], mcpGrant: grant });
    assert.equal(policy.mcpTransport, 'ssh-reverse-forward');
    assert.equal(policy.dockerNetwork, undefined);
    assert.equal(policy.mcpServers?.[0].bearerToken, GRANT_TOKEN, 'the per-run grant token is still required');
    assert.deepEqual(agentRunMcpGrant(policy), { servers: ['propr'], transport: 'ssh-reverse-forward', url: FORWARD_URL });
});

test('restricted Sprites add no MCP host for the loopback forward and refuse a forward grant naming another URL', () => {
    const restriction = { mode: 'restricted' as const, source: 'instance' as const, allow: ['example.com'], instanceAllow: [] };
    const spec = forwardSpec({ ...agentRunNetwork('bridge'), restriction, policy: agentRunNetworkPolicy('antigravity', restriction) });
    const policy = spriteNetworkPolicy(spec);
    assert.deepEqual(policy?.rules.filter(rule => rule.action === 'allow').map(rule => rule.domain).filter(domain => domain?.includes('127.0.0.1')), []);
    assert.ok(policy?.rules.some(rule => rule.domain === 'example.com'));
    assert.throws(() => spriteNetworkPolicy(forwardSpec(agentRunNetwork('bridge'), 'http://api:4000/api/mcp')), /loopback forward listener/);
    assert.ok(isSpritesMcpForwardUrl(`http://127.0.0.1:${SPRITES_MCP_FORWARD_PORT}/propr/api/mcp`));
    assert.ok(!isSpritesMcpForwardUrl(`http://localhost:${SPRITES_MCP_FORWARD_PORT}/api/mcp`));
});

// --- sshd configuration ----------------------------------------------------

test('the run sshd binds loopback only, accepts one key and permits only the loopback MCP listener', () => {
    const config = spritesMcpSshdConfig('/run/propr-mcp-forward');
    const lines = new Map(config.trim().split('\n').map(line => {
        const [key, ...value] = line.split(' ');
        return [key, value.join(' ')];
    }));
    assert.equal(lines.get('ListenAddress'), `127.0.0.1:${SPRITES_MCP_SSHD_PORT}`);
    assert.equal(config.match(/^ListenAddress /gm)?.length, 1);
    assert.equal(lines.get('AddressFamily'), 'inet');
    for (const [key, value] of Object.entries({
        AuthenticationMethods: 'publickey', PasswordAuthentication: 'no', KbdInteractiveAuthentication: 'no', HostbasedAuthentication: 'no',
        PermitRootLogin: 'no', PermitEmptyPasswords: 'no', UsePAM: 'no', AllowUsers: 'propr-mcp', MaxSessions: '0', PermitTTY: 'no',
        AllowTcpForwarding: 'remote', PermitListen: `127.0.0.1:${SPRITES_MCP_FORWARD_PORT}`, PermitOpen: 'none', GatewayPorts: 'no',
        AllowAgentForwarding: 'no', AllowStreamLocalForwarding: 'no', X11Forwarding: 'no', PermitTunnel: 'no',
        AuthorizedKeysFile: '/run/propr-mcp-forward/authorized_keys', HostKey: '/run/propr-mcp-forward/host_key',
    })) assert.equal(lines.get(key), value, key);
    assert.doesNotMatch(config, /Subsystem|ForceCommand/);
    const key = ssh2.utils.generateKeyPairSync('ed25519').public;
    const authorized = spritesMcpAuthorizedKey(key);
    assert.match(authorized, new RegExp(`^restrict,port-forwarding,permitlisten="127\\.0\\.0\\.1:${SPRITES_MCP_FORWARD_PORT}" ssh-ed25519 \\S+ propr-mcp-forward\\n$`));
    assert.throws(() => spritesMcpAuthorizedKey('command="sh" ssh-ed25519 AAAA'), /Invalid/);
    assert.throws(() => spritesMcpAuthorizedKey('ssh-rsa AAAA'), /Invalid/);
});

test('the forward helper stops the run sshd with its per-connection children and removes its files', { skip: process.platform !== 'linux' }, () => {
    const dir = execFileSync('mktemp', ['-d']).toString().trim();
    try {
        // A stand-in daemon with one child, as sshd has per forwarded connection.
        const script = `
            set -euo pipefail
            source scripts/sprites-mcp-forward.sh
            run_dir="$1"
            sh -c 'sleep 30 & echo $! > "$0/child.pid"; wait' "$run_dir" & daemon=$!
            echo "$daemon" > "$run_dir/sshd.pid"
            for _ in $(seq 50); do [ -s "$run_dir/child.pid" ] && break; sleep 0.05; done
            child="$(cat "$run_dir/child.pid")"
            stop_sshd
            for _ in $(seq 50); do kill -0 "$child" 2>/dev/null || break; sleep 0.05; done
            if kill -0 "$child" 2>/dev/null || kill -0 "$daemon" 2>/dev/null; then echo alive; fi
            [ -e "$run_dir" ] && echo present
            echo stopped`;
        const result = spawnSync('bash', ['-c', script, 'test', dir], { encoding: 'utf8', timeout: 10_000 });
        assert.equal(result.stdout.trim(), 'stopped', result.stderr);
        const refused = spawnSync('bash', ['scripts/sprites-mcp-forward.sh', 'start', '/tmp/elsewhere'], { encoding: 'utf8' });
        assert.notEqual(refused.status, 0);
        assert.match(refused.stderr, /must run as root|refusing files outside/);
    } finally { execFileSync('rm', ['-rf', dir]); }
});

// --- the forward -----------------------------------------------------------

test('the forward carries MCP JSON and streamed SSE responses to the internal API with the grant token', async () => {
    const { sprite, sshd: fake } = forwardSprite();
    const forward = await SpritesMcpForward.start({ sprite: sprite as never, target: target(), signal: new AbortController().signal, onLost: () => assert.fail('lost') });
    try {
        assert.deepEqual(fake.forwardRequests, [{ bindAddr: '127.0.0.1', bindPort: SPRITES_MCP_FORWARD_PORT }]);
        assert.equal(fake.started[0].config, spritesMcpSshdConfig('/run/propr-mcp-forward'));
        assert.ok(![...sprite.files.keys()].some(file => file.includes('mcp-forward-')), 'the inbox copy of the keys is removed');
        const port = await fake.listenPort!;
        const json = await mcpCall(port);
        assert.equal(json.status, 200);
        assert.deepEqual(JSON.parse(json.body).result.tools, [{ name: 'get_task' }]);
        const sse = await mcpCall(port, 'text/event-stream');
        assert.equal(sse.firstChunk, 'data: one\n\n', 'the first event arrives before the API sends the second');
        assert.equal(sse.body, 'data: one\n\ndata: two\n\n');
        assert.equal(apiRequests.at(-1)?.authorization, `Bearer ${GRANT_TOKEN}`);
    } finally { await forward.close(); }
    assert.equal(fake.stops, 1);
    assert.deepEqual(sprite.events, ['forward-start', 'forward-stop']);
});

test('each forward uses its own client and host keys, and an impostor sshd is refused', async () => {
    const first = forwardSprite();
    const second = forwardSprite();
    const forwards = await Promise.all([first, second].map(({ sprite }) => SpritesMcpForward.start({ sprite: sprite as never, target: target(), signal: AbortSignal.timeout(10_000), onLost: () => {} })));
    await Promise.all(forwards.map(forward => forward.close()));
    assert.notEqual(first.sshd.started[0].authorizedKeys, second.sshd.started[0].authorizedKeys);
    const impostor = forwardSprite();
    impostor.sshd.hostKeyOverride = ssh2.utils.generateKeyPairSync('ed25519').private;
    await assert.rejects(SpritesMcpForward.start({ sprite: impostor.sprite as never, target: target(), signal: AbortSignal.timeout(10_000), onLost: () => {} }),
        (error: SpritesMcpForwardError) => error.code === 'MCP_TRANSPORT_LOST' && /could not be established/.test(error.message));
    assert.equal(impostor.sshd.authAttempts, 0, 'the worker never authenticates to an unverified host');
    assert.equal(impostor.sshd.stops, 1, 'a failed start still stops the run sshd');
});

test('a dropped forward reconnects and keeps serving MCP calls', async () => {
    const { sprite, sshd: fake } = forwardSprite();
    const forward = await SpritesMcpForward.start({ sprite: sprite as never, target: target(), signal: AbortSignal.timeout(10_000), onLost: () => assert.fail('lost') });
    try {
        const before = await fake.listenPort!;
        assert.equal((await mcpCall(before)).status, 200);
        fake.drop();
        await until(() => forward.connections === 2);
        const port = await fake.listenPort!;
        assert.equal((await mcpCall(port)).status, 200);
        assert.equal(fake.forwardRequests.length, 2);
    } finally { await forward.close(); }
});

test('a forward that cannot reconnect reports a clear MCP transport error once', async () => {
    const { sprite, sshd: fake } = forwardSprite();
    const lost: SpritesMcpForwardError[] = [];
    const forward = await SpritesMcpForward.start({ sprite: sprite as never, target: target(), signal: AbortSignal.timeout(10_000), onLost: error => lost.push(error) });
    fake.refuseProxy = true;
    fake.drop();
    await until(() => lost.length > 0);
    await forward.close();
    assert.equal(lost.length, 1);
    assert.equal(lost[0].code, 'MCP_TRANSPORT_LOST');
    assert.match(lost[0].message, /ProPR MCP transport lost: .* could not be re-established after 2 reconnect attempts/);
});

// --- runtime lifecycle -----------------------------------------------------

function forwardSpec(network = agentRunNetwork('bridge'), url = FORWARD_URL) {
    return new AgentRunSpecBuilder({
        name: 'forward', stdin: true, agentType: 'antigravity', image: 'test', network, user: '0:0',
        mcpGrant: agentRunMcpGrant({ mcpServers: [{ name: 'propr', url, bearerTokenEnv: 'PROPR_MCP_TOKEN', bearerToken: GRANT_TOKEN }], mcpTransport: 'ssh-reverse-forward' }),
        workspace: { hostPath: '/unused', containerPath: '/home/node/workspace', readOnly: false, mode: 'clone',
            clone: { remote: 'unused', baseRef: 'base', baseCommit: 'unused', branch: 'test', resultDir: '/tmp/propr-workspace-result', script: WORKSPACE_TRANSPORT_SCRIPT } },
    }).command('agy', '--version').build();
}

function runtimeFixture(configure: (sprite: FakeSprite) => void = () => {}) {
    const client = new FakeSprites();
    const daemons: FakeSpriteSshd[] = [];
    client.setup = sprite => { daemons.push(new FakeSpriteSshd(sprite)); configure(sprite); };
    const runtime = new SpritesRuntime(client, { PROPR_SPRITES_TOKEN: 'org-secret', PROPR_INTERNAL_API_URL: `http://127.0.0.1:${apiPort}` });
    return { client, daemons, runtime };
}

function captureLogs(t: { mock: { method: (object: object, name: string, implementation: (...args: unknown[]) => void) => unknown } }) {
    const lines: string[] = [];
    for (const level of ['info', 'warn', 'error', 'debug'] as const) {
        t.mock.method(logger, level, (...args: unknown[]) => { lines.push(JSON.stringify(args, (_key, value) => value instanceof Error ? value.message : value)); });
    }
    return lines;
}

test('a run starts the forward before the agent and tears it down after success and failure', async t => {
    const logs = captureLogs(t);
    for (const exitCode of [0, 1]) {
        const { client, runtime, daemons } = runtimeFixture(sprite => { sprite.exitCode = exitCode; });
        const run = runtime.start(forwardSpec());
        const result = await run.wait();
        assert.equal(result.exitCode, exitCode);
        const sprite = client.created[0];
        assert.deepEqual(sprite.events.filter(event => ['forward-start', 'launch', 'forward-stop'].includes(event)), ['forward-start', 'launch', 'forward-stop']);
        await until(() => daemons[0].connections.size === 0);
        const inspected = await run.inspect!();
        assert.ok(inspected.diagnostics?.some(line => line.includes('ssh-reverse-forward')));
        for (const text of [...sprite.launches, ...logs]) assert.doesNotMatch(text, /PRIVATE KEY/);
        await run.release!();
        await runtime.close();
    }
    assert.ok(logs.some(line => line.includes('ProPR MCP SSH reverse forward established') && line.includes('ssh-reverse-forward')));
    for (const line of logs) assert.ok(!line.includes(GRANT_TOKEN), 'the grant token never reaches the logs');
});

test('a cancelled run tears the forward down; MCP calls work while it runs and after a reconnect', async () => {
    const { client, runtime, daemons } = runtimeFixture(sprite => { sprite.hold = true; });
    const run = runtime.start(forwardSpec());
    await until(() => !!client.created[0]);
    const sprite = client.created[0];
    await sprite.launched.promise;
    const fake = daemons[0];
    assert.equal((await mcpCall(await fake.listenPort!)).status, 200);
    fake.drop();
    await until(() => fake.forwardRequests.length === 2 && fake.connections.size > 0);
    assert.equal((await mcpCall(await fake.listenPort!)).status, 200);
    await run.stop();
    assert.ok(sprite.events.includes('forward-stop'));
    await until(() => fake.connections.size === 0);
    await run.release!();
    await runtime.close();
});

test('a forward lost mid-run fails the run with an MCP transport error instead of hanging', async () => {
    const { client, runtime, daemons } = runtimeFixture(sprite => { sprite.hold = true; });
    const run = runtime.start(forwardSpec());
    await until(() => !!client.created[0]);
    await client.created[0].launched.promise;
    await daemons[0].listenPort;
    daemons[0].refuseProxy = true;
    daemons[0].drop();
    await assert.rejects(run.wait(), (error: SpritesMcpForwardError) => error.code === 'MCP_TRANSPORT_LOST' && /ProPR MCP transport lost/.test(error.message));
    assert.ok(client.created[0].events.includes('forward-stop'));
    await run.release!();
    await runtime.close();
});

test('a forward that cannot start fails the run before the agent launches', async () => {
    const { client, runtime, daemons } = runtimeFixture();
    client.setup = sprite => { const fake = new FakeSpriteSshd(sprite); fake.failStart = true; daemons.push(fake); };
    const run = runtime.start(forwardSpec());
    await assert.rejects(run.wait(), (error: SpritesMcpForwardError) => error.code === 'MCP_TRANSPORT_LOST' && /Could not start/.test(error.message));
    assert.deepEqual(client.created[0].launches, []);
    await run.release!();
    await runtime.close();
});

test('a forward grant whose URL does not match the runtime forward listener is refused at start', () => {
    const { runtime } = runtimeFixture();
    assert.throws(() => runtime.start(forwardSpec(agentRunNetwork('bridge'), `http://127.0.0.1:${SPRITES_MCP_FORWARD_PORT}/other/api/mcp`)), /does not match/);
});
