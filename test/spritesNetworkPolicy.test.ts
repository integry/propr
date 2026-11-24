import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { closeConnection } from '../packages/core/src/db/connection.ts';
after(closeConnection);
import { AgentRunSpecBuilder, agentRunMcpGrant, agentRunNetwork } from '../packages/core/src/agents/runtime/agentRunSpec.ts';
import { agentRunNetworkPolicy } from '../packages/core/src/agents/runtime/agentRunNetworkPolicy.ts';
import { planAgentRunMcpTransport } from '../packages/core/src/agents/runtime/agentRunMcpTransport.ts';
import { assertAgentRuntimeSupports } from '../packages/core/src/agents/runtime/registry.ts';
import { spriteNetworkPolicy } from '../packages/core/src/agents/runtime/sprites/spritesNetwork.ts';
import { SpritesRuntime } from '../packages/core/src/agents/runtime/spritesRuntime.ts';
import { WORKSPACE_TRANSPORT_SCRIPT } from '../packages/core/src/git/workspaceTransportScript.ts';
import type { AgentRunSpec } from '../packages/core/src/agents/runtime/types.ts';
import { executeWithNetworkPolicy } from '../packages/core/src/network/egressExecution.ts';
import logger from '../packages/core/src/utils/logger.ts';
import { FakeSprites } from './helpers/fakeSprites.ts';

const restriction = { mode: 'restricted' as const, source: 'instance' as const, allow: ['*.example.com', 'docs.example.org:8443', '203.0.113.9'], instanceAllow: ['10.0.0.5'] };

function build(network = agentRunNetwork('bridge'), mcpUrl?: string): AgentRunSpec {
    const spec = new AgentRunSpecBuilder({
        name: 'net', stdin: true, agentType: 'claude', image: 'test', network, user: '0:0',
        mcpGrant: mcpUrl ? agentRunMcpGrant({ mcpServers: [{ name: 'propr', url: mcpUrl, bearerTokenEnv: 'T', bearerToken: 't' }] }) : undefined,
        workspace: { hostPath: '/unused', containerPath: '/home/node/workspace', readOnly: false, mode: 'clone',
            clone: { remote: 'unused', baseRef: 'base', baseCommit: 'unused', branch: 'test', resultDir: '/tmp/propr-workspace-result', script: WORKSPACE_TRANSPORT_SCRIPT } },
    }).command('claude', '--version').build();
    return spec;
}

const restricted = (mcpUrl?: string) => build({ ...agentRunNetwork('bridge'), restriction, policy: agentRunNetworkPolicy('claude', restriction) }, mcpUrl);

test('the run allowlist becomes a deny-by-default DNS policy that never covers a bare wildcard zone or raw IPs', () => {
    const policy = spriteNetworkPolicy(restricted('https://PROPR.example.net./api/mcp'))!;
    const rules = new Map(policy.rules.map(rule => [rule.domain, rule.action]));
    assert.equal(rules.get('*'), 'deny');
    assert.equal(rules.get('*.example.com'), 'allow');
    assert.equal(rules.get('example.com'), 'deny', 'a ProPR *.zone never includes the zone itself');
    assert.equal(rules.get('docs.example.org'), 'allow');
    assert.equal(rules.get('api.anthropic.com'), 'allow', 'the agent base list is included');
    assert.equal(rules.get('propr.example.net'), 'allow', 'the granted ProPR MCP host is reachable');
    assert.ok(![...rules.keys()].some(domain => domain && /^\d/.test(domain)), 'IP literals are not domain rules');
    assert.equal(spriteNetworkPolicy(build()), undefined);
});

test('neutral policy hostnames use the same normalization as MCP endpoints', () => {
    const spec = build({ ...agentRunNetwork('bridge'), policy: { mode: 'restricted', privateAddressAllow: [], allow: [
        { host: ' DOCS.example.org. ', ports: [443], wildcard: false },
        { host: '[2001:db8::1]', ports: [443], wildcard: false },
    ] } });
    assert.deepEqual(spriteNetworkPolicy(spec)?.rules, [{ domain: 'docs.example.org', action: 'allow' }, { domain: '*', action: 'deny' }]);
});

test('a broader wildcard allows the bare zone of a nested wildcard', () => {
    const overlap = { ...restriction, allow: ['*.service.example.com', '*.example.com', '*.otherexample.com'] };
    const spec = build({ ...agentRunNetwork('bridge'), restriction: overlap, policy: agentRunNetworkPolicy('claude', overlap) });
    const rules = new Map(spriteNetworkPolicy(spec)!.rules.map(rule => [rule.domain, rule.action]));
    assert.equal(rules.get('*.example.com'), 'allow');
    assert.equal(rules.get('*.service.example.com'), 'allow');
    assert.equal(rules.has('service.example.com'), false, 'the broader wildcard already allows this host');
    assert.equal(rules.get('example.com'), 'deny');
    assert.equal(rules.get('otherexample.com'), 'deny', 'wildcards match only at a DNS label boundary');
});

test('Sprites still refuses what it cannot enforce', () => {
    assert.throws(() => spriteNetworkPolicy(build(agentRunNetwork('propr_default'))), /cannot join network/);
    const malformed = { ...agentRunNetwork('bridge'), policy: { mode: 'restricted' as const, allow: [{ host: 'x.com', wildcard: false, ports: [] }], privateAddressAllow: [] } };
    assert.throws(() => spriteNetworkPolicy(build(malformed)), /malformed/);
    const disagree = { ...agentRunNetwork('bridge'), restriction, policy: agentRunNetworkPolicy('claude', { ...restriction, allow: ['*'] }) };
    assert.throws(() => spriteNetworkPolicy(build(disagree)), /differs/);
    for (const url of ['http://propr.example.net/api/mcp', 'https://api:4000/api/mcp', 'https://localhost/api/mcp', 'https://1.1.1.1/api/mcp', 'https://[2001:db8::1]/api/mcp',
        ...['LOCAL.', 'lan', 'home.arpa', 'svc.cluster.local', 'internal'].map(zone => `https://service.${zone}/api/mcp`)]) {
        const plan = planAgentRunMcpTransport(new SpritesRuntime(new FakeSprites(), {}), { PROPR_SPRITES_MCP_URL: url }, 'restricted');
        assert.equal(plan.transport, 'unavailable');
        assert.match(plan.reason, /public HTTPS URL/);
        assert.equal(spriteNetworkPolicy(build(undefined, url)), undefined, url);
        assert.throws(() => spriteNetworkPolicy(restricted(url)), /public HTTPS URL/, url);
    }
    const privateGrant = build();
    privateGrant.mcpGrant = { servers: ['propr'], network: 'propr_propr-agent-mcp', transport: 'private-network' };
    assert.throws(() => spriteNetworkPolicy(privateGrant), /cannot join MCP network/);
});

test('admission accepts restricted Sprites runs, and the Sprites MCP URL wins over the generic fallback', () => {
    const runtime = new SpritesRuntime(new FakeSprites(), {});
    assert.doesNotThrow(() => assertAgentRuntimeSupports(runtime, restricted()));
    assert.equal(runtime.capabilities.restrictedNetworkEnforcement.method, 'sprites-dns-allowlist');
    const plan = planAgentRunMcpTransport(runtime, { PROPR_SPRITES_MCP_URL: ' https://gateway.example.net/api/mcp ', API_PUBLIC_URL: 'https://propr.example.net', PROPR_AGENT_MCP_URL: 'http://api:4000/api/mcp' }, 'restricted');
    assert.deepEqual([plan.transport, (plan as { url: string }).url], ['reachable-url', 'https://gateway.example.net/api/mcp']);
    assert.equal(planAgentRunMcpTransport({ kind: 'docker', capabilities: runtime.capabilities }, { PROPR_SPRITES_MCP_URL: 'https://gateway.example.net' }).transport, 'unavailable');
});

test('the policy is applied before upload and launch, cleared after restore, and a Sprite that keeps it is discarded', async t => {
    const client = new FakeSprites();
    const runtime = new SpritesRuntime(client, { PROPR_SPRITES_TOKEN: 'org-token' });
    const run = runtime.start(restricted('https://propr.example.net/api/mcp'));
    await run.wait();
    const sprite = client.created[0];
    assert.deepEqual(sprite.events, ['checkpoint', 'restore', 'restrict', 'launch']);
    assert.equal(JSON.parse(sprite.launches[0]).agent.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
    const restore = sprite.restoreCheckpoint.bind(sprite);
    const restoring = Promise.withResolvers<void>();
    const finishRestore = Promise.withResolvers<void>();
    sprite.restoreCheckpoint = async id => {
        const stream = await restore(id);
        return (async function* () {
            restoring.resolve();
            await finishRestore.promise;
            yield* stream;
        })();
    };
    const release = run.release!();
    await restoring.promise;
    assert.deepEqual(sprite.networkPolicy, spriteNetworkPolicy(restricted('https://propr.example.net/api/mcp')));
    finishRestore.resolve();
    await release;
    assert.deepEqual(sprite.events.slice(-4), ['restart', 'wipe', 'restore', 'open']);
    assert.deepEqual(sprite.networkPolicy, { rules: [] });

    const open = runtime.start(build(undefined, 'http://api:4000/api/mcp'));
    await open.wait();
    assert.equal(sprite.launches.length, 2);
    await open.release!();
    assert.deepEqual(sprite.events.slice(-4), ['launch', 'restart', 'wipe', 'restore'], 'an open run never touches the policy');

    const next = runtime.start(restricted());
    await next.wait();
    const warn = t.mock.method(logger, 'warn');
    sprite.failPolicy = true;
    await next.release!();
    assert.deepEqual(client.deleted, [sprite.name], 'a Sprite whose policy cannot be cleared is never reused');
    assert.equal(client.created.length, 2);
    assert.deepEqual(warn.mock.calls.at(-1)?.arguments[0], { run: 'net', sprite: sprite.name, step: 'clear network policy', error: 'policy update failed' });
});

test('release logs the verification step and replaces a Sprite when clear read-back omits the rules', async t => {
    const client = new FakeSprites();
    const runtime = new SpritesRuntime(client, { PROPR_SPRITES_TOKEN: 'org-token' });
    const run = runtime.start(restricted());
    await run.wait();
    const sprite = client.created[0];
    const getPolicy = sprite.getNetworkPolicy.bind(sprite);
    sprite.getNetworkPolicy = async () => sprite.networkPolicy.rules.length ? getPolicy() : JSON.parse('{}');
    const warn = t.mock.method(logger, 'warn');
    await run.release!();
    assert.deepEqual(client.deleted, [sprite.name]);
    assert.deepEqual(warn.mock.calls.at(-1)?.arguments[0], {
        run: 'net', sprite: sprite.name, step: 'verify cleared network policy', error: 'Sprite did not verify the cleared network policy',
    });
    await runtime.close();
});

test('a policy that fails to apply refuses the run before upload and discards the unverified Sprite', async () => {
    const client = new FakeSprites();
    const runtime = new SpritesRuntime(client, { PROPR_SPRITES_TOKEN: 'org-token' });
    const first = runtime.start(build());
    await first.wait();
    await first.release!();
    const sprite = client.created[0];
    sprite.getNetworkPolicy = async () => ({ rules: [] });
    const run = runtime.start(restricted());
    await assert.rejects(run.wait(), /did not report the network policy/);
    await run.release!();
    assert.equal(sprite.launches.length, 1, 'nothing was launched under an unverified policy');
    assert.equal(sprite.events.at(-1), 'restrict');
    assert.deepEqual(client.deleted, [sprite.name]);
});

test('a restricted Sprite whose cleanup fails is discarded with egress still restricted', async () => {
    for (const failure of ['failWipe', 'failRestore'] as const) {
        const client = new FakeSprites();
        const runtime = new SpritesRuntime(client, { PROPR_SPRITES_TOKEN: 'org-token' });
        const run = runtime.start(restricted());
        await run.wait();
        const sprite = client.created[0];
        sprite[failure] = true;
        await run.release!();
        assert.deepEqual(client.deleted, [sprite.name]);
        assert.ok(!sprite.events.includes('open'), failure);
        await runtime.close();
    }
});

test('restricted environment defaults preserve explicit values and stay out of open runs', async t => {
    const client = new FakeSprites();
    const subject = new SpritesRuntime(client, { PROPR_SPRITES_TOKEN: 'org-token' });
    const key = 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC';
    const inherited = restricted();
    inherited.env.push({ name: key, order: 0 });
    const previous = process.env[key];
    process.env[key] = 'configured';
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
    for (const [spec, options, expected] of [
        [restricted(), { extraEnvVars: { [key]: '' } }, ''],
        [inherited, {}, 'configured'],
        [build(), {}, undefined],
    ] as const) {
        const run = subject.start(spec, options);
        await run.wait();
        assert.equal(JSON.parse(client.created[0].launches.at(-1)!).agent.env[key], expected);
        await run.release!();
    }
    await subject.close();
});

test('release records a changed policy against the lease and discards before cleanup, even during shutdown', async t => {
    const client = new FakeSprites();
    const runtime = new SpritesRuntime(client, { PROPR_SPRITES_TOKEN: 'org-token' });
    const warn = t.mock.method(logger, 'warn');
    const store = mkdtempSync(path.join(tmpdir(), 'sprite-tamper-'));
    t.after(() => rmSync(store, { recursive: true, force: true }));
    for (const closing of [false, true]) {
        const { report } = await executeWithNetworkPolicy(restriction, async () => {
            const spec = restricted();
            spec.mounts.push({ type: 'bind', source: store, target: '/home/node/.claude', readOnly: true, purpose: 'credential', order: 0,
                credentialStore: { provider: 'claude', store: 'config', perRun: true } });
            const run = runtime.start(spec);
            await run.wait();
            const sprite = client.created.at(-1)!;
            sprite.networkPolicy = { rules: [] };
            const events = [...sprite.events];
            const read = t.mock.method(sprite, 'getNetworkPolicy');
            if (closing) await runtime.close();
            await Promise.all([run.release!(), run.release!()]);
            assert.equal(read.mock.callCount(), 1);
            assert.deepEqual(sprite.events, events);
            assert.ok(client.deleted.includes(sprite.name));
            const diagnostic = `Network policy mismatch at release for run net on Sprite ${sprite.name}`;
            assert.deepEqual((await run.inspect()).diagnostics, [diagnostic]);
            assert.deepEqual(warn.mock.calls.at(-1)?.arguments[0], {
                sprite: sprite.name, run: 'net', step: 'check applied network policy', error: diagnostic,
            });
        });
        assert.deepEqual(report.diagnostics, [`Network policy mismatch at release for run net on Sprite ${client.deleted.at(-1)}`]);
    }
    assert.equal(client.created.length, 2);
});
