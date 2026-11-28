import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// The spec's restriction must confine the container through the real executor and egress
// boundary, with no ambient run policy and no instance policy: only the spawn is captured.
const socketRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'propr-spec-egress-'));
process.env.PROPR_EGRESS_SOCKET_DIR = socketRoot;
delete process.env.HOST_PROPR_EGRESS_SOCKET_DIR;

const childProcess = await import('node:child_process');
let spawned: string[][] = [];
await mock.module('node:child_process', { namedExports: { ...childProcess,
    spawn: (_command: string, args: string[]) => {
        spawned.push(args);
        throw new Error('Captured spawn');
    },
} });

const { DockerRuntime } = await import('../packages/core/src/agents/runtime/dockerRuntime.js');
const { runAgent } = await import('../packages/core/src/agents/runtime/registry.js');
const { AgentRunSpecBuilder, agentRunNetwork } = await import('../packages/core/src/agents/runtime/agentRunSpec.js');
const { currentAgentNetworkPolicy, executeWithNetworkPolicy, setUnscopedNetworkPolicyResolver } = await import('../packages/core/src/network/egressExecution.js');
const { closeConnection } = await import('../packages/core/src/db/connection.js');

const restriction = { mode: 'restricted' as const, source: 'workflow' as const, allow: ['registry.npmjs.org'], instanceAllow: [] };

function restrictedSpec(name: string, policy: typeof restriction | { mode: 'restricted'; source: 'instance_enforced'; allow: string[] } = restriction) {
    const built = new AgentRunSpecBuilder({
        agentType: 'claude', image: 'test-agent', name, stdin: true,
        network: agentRunNetwork('bridge'), workspace: { hostPath: socketRoot, containerPath: '/home/node/workspace', readOnly: false },
    }).command('-p', '-').build();
    return {
        ...built,
        network: { ...built.network, restriction: policy },
        repoSetup: { agentType: 'claude' as const, shell: '/bin/bash', script: 'exec "$@"', providerEntrypoint: 'claude', env: [{ name: 'PROPR_AGENT_TYPE', value: 'claude' }] },
    };
}

function assertConfined(args: string[]): void {
    const networks = args.flatMap((arg, index) => arg === '--network' ? [args[index + 1]] : []);
    assert.deepEqual(networks, ['none'], 'the bridge network the spec named is replaced by none');
    assert.ok(args.includes('PROPR_NETWORK_MODE=restricted'));
    assert.ok(args.some(arg => arg.startsWith('HTTPS_PROXY=http://127.0.0.1:')), 'traffic goes through the egress proxy');
    assert.ok(args.some(arg => arg.startsWith(`${socketRoot}/`) && arg.endsWith(':/run/propr-egress:ro')), 'the run socket is mounted');
}

beforeEach(() => { spawned = []; });
after(async () => {
    await closeConnection().catch(() => undefined);
    await fs.rm(socketRoot, { recursive: true, force: true });
});

test('DockerRuntime.start confines a restricted spec outside any run or instance policy', async () => {
    assert.equal(currentAgentNetworkPolicy(), undefined);
    const handle = new DockerRuntime().start(restrictedSpec('claude-issue-1-direct'), { timeout: 5000, costCapExempt: true });
    await assert.rejects(handle.wait(), /Captured spawn/);
    assert.equal(spawned.length, 1);
    assertConfined(spawned[0]);
    assert.deepEqual(await fs.readdir(socketRoot), [], 'the proxy directory is released after the launch');
});

test('runAgent confines a restricted spec outside any run or instance policy', async () => {
    await assert.rejects(runAgent(null, restrictedSpec('claude-issue-1-run-agent'), { timeout: 5000, costCapExempt: true }), /Captured spawn/);
    assert.equal(spawned.length, 1);
    assertConfined(spawned[0]);
});

test('an exemption reason does not open a spec that demands confinement', async () => {
    const handle = new DockerRuntime().start(restrictedSpec('claude-issue-1-exempt'), { timeout: 5000, costCapExempt: true, networkPolicyExempt: 'probe' });
    await assert.rejects(handle.wait(), /Captured spawn/);
    assertConfined(spawned[0]);
});

test('an enclosing open run policy is narrowed to the spec restriction', async () => {
    await assert.rejects(executeWithNetworkPolicy({ mode: 'open', source: 'instance', allow: [] },
        () => new DockerRuntime().start(restrictedSpec('claude-issue-1-open-scope'), { timeout: 5000, costCapExempt: true }).wait()), /Captured spawn/);
    assertConfined(spawned[0]);
});

test('a spec restriction that differs from the applying policy is refused before spawning', async () => {
    const other = { mode: 'restricted' as const, source: 'workflow' as const, allow: ['example.com'], instanceAllow: [] };
    await assert.rejects(executeWithNetworkPolicy(other,
        () => new DockerRuntime().start(restrictedSpec('claude-issue-1-conflict'), { timeout: 5000, costCapExempt: true }).wait()),
    /differs from the policy applying at launch \(workflow\)/);
    const enforced = { mode: 'restricted' as const, source: 'instance_enforced' as const, allow: [], instanceAllow: [] };
    setUnscopedNetworkPolicyResolver(async () => enforced);
    try {
        await assert.rejects(new DockerRuntime().start(restrictedSpec('claude-issue-1-enforced'), { timeout: 5000, costCapExempt: true }).wait(),
            /differs from the policy applying at launch \(instance_enforced\)/, 'the stronger enforced instance policy is not replaced');
        assert.equal(spawned.length, 0);
        await assert.rejects(new DockerRuntime().start(restrictedSpec('claude-issue-1-enforced-same', enforced), { timeout: 5000, costCapExempt: true }).wait(), /Captured spawn/);
        assertConfined(spawned[0]);
        setUnscopedNetworkPolicyResolver(async () => { throw new Error('settings unreadable'); });
        await assert.rejects(new DockerRuntime().start(restrictedSpec('claude-issue-1-unreadable'), { timeout: 5000, costCapExempt: true }).wait(), /settings unreadable/);
        assert.equal(spawned.length, 1, 'an unreadable instance policy spawns nothing');
    } finally {
        setUnscopedNetworkPolicyResolver(undefined);
    }
});

test('runAgent refuses a spec restriction that differs from an enclosing run policy instead of replacing it', async () => {
    const other = { mode: 'restricted' as const, source: 'workflow' as const, allow: ['example.com'], instanceAllow: [] };
    await assert.rejects(executeWithNetworkPolicy(other,
        () => runAgent(null, restrictedSpec('claude-issue-1-run-agent-conflict'), { timeout: 5000, costCapExempt: true })),
    /claude-issue-1-run-agent-conflict carries a restricted network policy \(workflow\) that differs from the policy applying at launch \(workflow\)/);
    assert.equal(spawned.length, 0, 'nothing is spawned under the enclosing allowlist');
    await assert.rejects(executeWithNetworkPolicy(other,
        () => runAgent(null, restrictedSpec('claude-issue-1-run-agent-conflict-exempt'), { timeout: 5000, costCapExempt: true, networkPolicyExempt: 'probe' })),
    /differs from the policy applying at launch/, 'an exemption reason does not skip the comparison');
    assert.equal(spawned.length, 0);
    await assert.rejects(executeWithNetworkPolicy({ ...restriction, allow: [...restriction.allow] },
        () => runAgent(null, restrictedSpec('claude-issue-1-run-agent-same'), { timeout: 5000, costCapExempt: true })), /Captured spawn/);
    assert.equal(spawned.length, 1, 'a matching enclosing policy launches');
    assertConfined(spawned[0]);
});

test('runAgent refuses a spec restriction that differs from the enforced instance policy', async () => {
    const enforced = { mode: 'restricted' as const, source: 'instance_enforced' as const, allow: ['example.com'], instanceAllow: [] };
    setUnscopedNetworkPolicyResolver(async () => enforced);
    try {
        await assert.rejects(runAgent(null, restrictedSpec('claude-issue-1-run-agent-enforced'), { timeout: 5000, costCapExempt: true }),
            /carries a restricted network policy \(workflow\) that differs from the policy applying at launch \(instance_enforced\)/);
        assert.equal(spawned.length, 0);
        await assert.rejects(runAgent(null, restrictedSpec('claude-issue-1-run-agent-enforced-same', enforced), { timeout: 5000, costCapExempt: true }), /Captured spawn/);
        assert.equal(spawned.length, 1);
        assertConfined(spawned[0]);
    } finally {
        setUnscopedNetworkPolicyResolver(undefined);
    }
});
