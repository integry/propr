import assert from 'node:assert/strict';
import { after, test } from 'node:test';

process.env.NODE_ENV ??= 'test';

// Importing @propr/core (through the grant client) opens the shared database connection.
after(async () => {
    const { closeConnection } = await import('../packages/core/src/db/connection.ts');
    await closeConnection();
});

const { registerAgentRuntime, runAgent, assertAgentRuntimeSupports, AgentRuntimeCapabilityError } = await import('../packages/core/src/agents/runtime/registry.ts');
const { agentRunEgressRules, agentRunNetworkPolicy, agentRunPrivateAddressRules, withAgentRunNetworkPolicy, OPEN_AGENT_RUN_NETWORK_POLICY } = await import('../packages/core/src/agents/runtime/agentRunNetworkPolicy.ts');
const { planAgentRunMcpTransport, agentRunMcpReachableUrl } = await import('../packages/core/src/agents/runtime/agentRunMcpTransport.ts');
const { readAgentRuntimeCapabilityReport } = await import('../packages/core/src/agents/runtime/agentRuntimeCapabilityReport.ts');
const { executeDockerRunWithSpecNetwork, DOCKER_RESTRICTED_NETWORK_ENFORCEMENT } = await import('../packages/core/src/agents/runtime/dockerNetwork.ts');
const { DOCKER_RUNTIME_CAPABILITIES } = await import('../packages/core/src/agents/runtime/dockerRuntime.ts');
const { AgentRunSpecBuilder, agentRunNetwork, agentRunMcpGrant } = await import('../packages/core/src/agents/runtime/agentRunSpec.ts');
const { executeWithNetworkPolicy } = await import('../packages/core/src/network/egressExecution.ts');
const { baseEgressAllowlist } = await import('../packages/core/src/network/egressAllowlist.ts');
const { requestAgentRunMcpGrant } = await import('../src/jobs/agentRuns/mcpGrantClient.ts');
const { agentRunToolPolicy } = await import('../src/jobs/agentRuns/toolPolicy.ts');

function spec() {
    return new AgentRunSpecBuilder({
        agentType: 'claude', image: 'propr/agent:test', name: 'claude-issue-9-net', stdin: true,
        network: agentRunNetwork('bridge'),
        workspace: { hostPath: '/tmp/w', containerPath: '/home/node/workspace', readOnly: false },
    }).workspaceMount().command('claude', '-p', '-').build();
}

const capabilities = (overrides: Record<string, unknown> = {}) => ({
    supportsBindMounts: true, supportsRestrictedNetwork: false, supportsMcpPrivateNetwork: false, reattach: false, supportsRuntimePackages: true, ...overrides,
});

function standIn(kind: string, caps: ReturnType<typeof capabilities>) {
    const started: any[] = [];
    registerAgentRuntime(kind, () => ({
        kind,
        capabilities: caps,
        start: (runSpec: any) => {
            started.push(runSpec);
            return { wait: async () => ({ stdout: '', stderr: '', exitCode: 0, messageTimestamps: new Map() }) } as any;
        },
    }));
    return started;
}

const workflowPolicy = { mode: 'restricted' as const, source: 'workflow' as const, allow: ['registry.example.com:8443', 'registry.example.com', '*.cdn.example.com'], instanceAllow: ['10.0.0.5'] };

test('the neutral network policy is a host/port allowlist: base hosts plus additions, ports merged', () => {
    assert.deepEqual(agentRunNetworkPolicy('claude'), OPEN_AGENT_RUN_NETWORK_POLICY);
    const policy = agentRunNetworkPolicy('claude', workflowPolicy);
    assert.equal(policy.mode, 'restricted');
    assert.equal(policy.source, 'workflow');
    const hosts = policy.allow.map(rule => `${rule.wildcard ? '*.' : ''}${rule.host}`);
    for (const host of baseEgressAllowlist('claude')) assert.ok(hosts.includes(host), `base host ${host}`);
    assert.deepEqual(policy.allow.find(rule => rule.host === 'registry.example.com'), { host: 'registry.example.com', wildcard: false, ports: [80, 443, 8443] });
    assert.deepEqual(policy.allow.find(rule => rule.host === 'cdn.example.com'), { host: 'cdn.example.com', wildcard: true, ports: [80, 443] });
    assert.deepEqual(policy.privateAddressAllow, [{ host: '10.0.0.5', wildcard: false, ports: [80, 443] }]);
    assert.deepEqual(agentRunEgressRules(['not a host', '*.com']), [], 'invalid entries never widen the allowlist');
});

test('only exact IP literals in the instance allowlist may reach private addresses', async () => {
    const instanceAllow = ['registry.example.com:443', '*.internal.example.com', '10.0.0.5:8080', '10.0.0.5', '[fd00:0:0:0:0:0:0:7]:5432', 'fe80::1'];
    const mixed = { ...workflowPolicy, instanceAllow, allow: [...workflowPolicy.allow, ...instanceAllow] };
    const expected = [
        { host: '10.0.0.5', wildcard: false, ports: [80, 443, 8080] },
        { host: 'fd00::7', wildcard: false, ports: [5432] },
        { host: 'fe80::1', wildcard: false, ports: [80, 443] },
    ];
    assert.deepEqual(agentRunPrivateAddressRules(instanceAllow), expected, 'hostname and wildcard entries never authorize private addresses');
    const policy = agentRunNetworkPolicy('claude', mixed);
    assert.deepEqual(policy.privateAddressAllow, expected);
    assert.ok(policy.allow.some(rule => rule.host === 'registry.example.com' && rule.ports.includes(443)), 'a hostname entry still reaches its public addresses');
    assert.ok(policy.allow.some(rule => rule.host === 'internal.example.com' && rule.wildcard));

    // Dispatch hands the runtime the filtered list.
    const started = standIn('net-private-ip-only', capabilities({ supportsRestrictedNetwork: true, restrictedNetworkEnforcement: { method: 'firewall', description: 'test' } }));
    await executeWithNetworkPolicy(mixed, () => runAgent({ runtime: 'net-private-ip-only' }, spec(), {}));
    assert.deepEqual(started[0].network.policy.privateAddressAllow, expected);

    // A supplied policy naming a hostname or wildcard as a private destination is malformed, never passed on.
    for (const rule of [{ host: 'registry.example.com', wildcard: false, ports: [443] }, { host: 'internal.example.com', wildcard: true, ports: [443] }]) {
        const supplied = { ...spec(), network: { ...spec().network, policy: { ...agentRunNetworkPolicy('claude', workflowPolicy), privateAddressAllow: [rule] } } };
        await assert.rejects(runAgent({ runtime: 'net-private-ip-only' }, supplied as any, {}), /malformed restricted network policy/);
    }
    assert.equal(started.length, 1);
});

test('dispatch attaches the neutral policy; a runtime that enforces restricted mode receives it', async () => {
    const started = standIn('net-enforcing', capabilities({ supportsRestrictedNetwork: true, restrictedNetworkEnforcement: { method: 'firewall', description: 'test' } }));
    await executeWithNetworkPolicy(workflowPolicy, () => runAgent({ runtime: 'net-enforcing' }, spec(), {}));
    assert.equal(started[0].network.policy.mode, 'restricted');
    assert.deepEqual(started[0].network.policy, agentRunNetworkPolicy('claude', workflowPolicy));
    await runAgent({ runtime: 'net-enforcing' }, spec(), {});
    assert.deepEqual(started[1].network.policy, OPEN_AGENT_RUN_NETWORK_POLICY, 'open runs carry an explicit open policy');
});

test('a restricted run on a runtime that cannot enforce it is refused with a typed error, never run open', async () => {
    const started = standIn('net-open-only', capabilities());
    const refusal = await executeWithNetworkPolicy(workflowPolicy, () => runAgent({ runtime: 'net-open-only' }, spec(), {})).then(() => null, error => error);
    assert.ok(refusal instanceof AgentRuntimeCapabilityError);
    assert.equal(refusal.code, 'AGENT_RUNTIME_CAPABILITY_UNSUPPORTED');
    assert.equal(refusal.capability, 'restricted_network');
    assert.equal(refusal.runtime, 'net-open-only');
    assert.match(refusal.message, /cannot enforce the restricted network policy \(workflow\).*refused instead of running with open networking/);
    assert.equal(started.length, 0);
    // A spec restricted only through its neutral policy is refused the same way.
    const neutral = { ...spec(), network: { ...spec().network, policy: agentRunNetworkPolicy('claude', workflowPolicy) } };
    assert.throws(() => assertAgentRuntimeSupports({ kind: 'net-open-only', capabilities: capabilities() } as any, neutral), /cannot enforce the restricted network policy/);
});

test('dispatch keeps a spec restricted only through its neutral policy: enforced or refused, never launched open', async () => {
    const neutral = () => ({ ...spec(), network: { ...spec().network, policy: agentRunNetworkPolicy('claude', workflowPolicy) } });
    assert.deepEqual(withAgentRunNetworkPolicy(neutral()).network.policy, agentRunNetworkPolicy('claude', workflowPolicy), 'normalization never replaces it with open');

    const refused = standIn('neutral-open-only', capabilities());
    const refusal = await runAgent({ runtime: 'neutral-open-only' }, neutral(), {}).then(() => null, error => error);
    assert.ok(refusal instanceof AgentRuntimeCapabilityError, 'no ambient policy: the supplied restricted policy still refuses');
    assert.equal(refusal.capability, 'restricted_network');
    assert.equal(refused.length, 0);

    const enforcing = standIn('neutral-enforcing', capabilities({ supportsRestrictedNetwork: true, restrictedNetworkEnforcement: { method: 'firewall', description: 'test' } }));
    await runAgent({ runtime: 'neutral-enforcing' }, neutral(), {});
    assert.deepEqual(enforcing[0].network.policy, agentRunNetworkPolicy('claude', workflowPolicy));
    assert.equal(enforcing[0].network.restriction, undefined);
    await runAgent({ runtime: 'neutral-enforcing' }, neutral(), { networkPolicyExempt: 'test exemption' });
    assert.equal(enforcing[1].network.policy.mode, 'restricted', 'an exemption does not lift the spec\'s own policy');

    // The same policy applying at launch attaches the restriction Docker's proxy enforces.
    await executeWithNetworkPolicy(workflowPolicy, () => runAgent({ runtime: 'neutral-enforcing' }, neutral(), {}));
    assert.deepEqual(enforcing[2].network.restriction, workflowPolicy);
    assert.deepEqual(enforcing[2].network.policy, agentRunNetworkPolicy('claude', workflowPolicy));

    // A different applying policy refuses rather than replacing either allowlist.
    const other = { ...workflowPolicy, allow: ['other.example.com'] };
    await assert.rejects(executeWithNetworkPolicy(other, () => runAgent({ runtime: 'neutral-enforcing' }, neutral(), {})), /differs from the policy applying at launch/);
    const malformed = { ...spec(), network: { ...spec().network, policy: { mode: 'restricted', allow: [{ host: 'x.example.com', wildcard: false, ports: [] }], privateAddressAllow: [] } } };
    await assert.rejects(runAgent({ runtime: 'neutral-enforcing' }, malformed as any, {}), /malformed restricted network policy/);
    assert.equal(enforcing.length, 3);
});

test('a spec whose restriction and restricted neutral policy disagree is refused before either launch path runs', async () => {
    // The restriction permits extra.example.com; the supplied neutral policy does not.
    const neutralPolicy = agentRunNetworkPolicy('claude', workflowPolicy);
    const broader = { ...workflowPolicy, allow: [...workflowPolicy.allow, 'extra.example.com'] };
    const conflicting = () => ({ ...spec(), network: { ...spec().network, restriction: broader, policy: neutralPolicy } });
    assert.ok(!neutralPolicy.allow.some(rule => rule.host === 'extra.example.com'));

    assert.throws(() => withAgentRunNetworkPolicy(conflicting()), /differs from its network restriction \(workflow\)/, 'normalization never replaces the supplied policy');

    const started = standIn('conflict-enforcing', capabilities({ supportsRestrictedNetwork: true, restrictedNetworkEnforcement: { method: 'firewall', description: 'test' } }));
    await assert.rejects(runAgent({ runtime: 'conflict-enforcing' }, conflicting(), {}), /differs from its network restriction/);
    await assert.rejects(runAgent({ runtime: 'conflict-enforcing' }, conflicting(), { networkPolicyExempt: 'test exemption' }), /differs from its network restriction/);
    await assert.rejects(executeWithNetworkPolicy(broader, () => runAgent({ runtime: 'conflict-enforcing' }, conflicting(), {})), /differs from its network restriction/,
        'an applying policy equal to the restriction does not settle the conflict');
    // The reverse: a supplied policy broader than the restriction is refused too.
    const widened = { ...spec(), network: { ...spec().network, restriction: workflowPolicy, policy: agentRunNetworkPolicy('claude', broader) } };
    await assert.rejects(runAgent({ runtime: 'conflict-enforcing' }, widened, {}), /differs from its network restriction/);
    assert.equal(started.length, 0, 'the runtime never starts a conflicting spec');

    let launched = 0;
    await assert.rejects(executeDockerRunWithSpecNetwork(conflicting(), async () => { launched++; }), /differs from its network restriction/);
    await assert.rejects(executeDockerRunWithSpecNetwork(widened, async () => { launched++; }), /differs from its network restriction/);
    assert.equal(launched, 0, 'direct Docker execution never launches a conflicting spec');

    // Agreeing representations still dispatch and launch.
    const agreeing = () => ({ ...spec(), network: { ...spec().network, restriction: workflowPolicy, policy: neutralPolicy } });
    await runAgent({ runtime: 'conflict-enforcing' }, agreeing(), {});
    assert.deepEqual(started[0].network.policy, neutralPolicy);
    assert.equal(started[0].network.restriction, workflowPolicy);
    await executeDockerRunWithSpecNetwork(agreeing(), async () => { launched++; });
    assert.equal(launched, 1);
});

test('Docker declares how it enforces restricted mode and refuses a restricted policy it cannot enforce', async () => {
    assert.equal(DOCKER_RUNTIME_CAPABILITIES.supportsRestrictedNetwork, true);
    assert.equal(DOCKER_RUNTIME_CAPABILITIES.restrictedNetworkEnforcement, DOCKER_RESTRICTED_NETWORK_ENFORCEMENT);
    assert.equal(DOCKER_RESTRICTED_NETWORK_ENFORCEMENT.method, 'egress-proxy-socket');
    let launched = 0;
    const neutralOnly = { ...spec(), network: { ...spec().network, policy: agentRunNetworkPolicy('claude', workflowPolicy) } };
    await assert.rejects(executeDockerRunWithSpecNetwork(neutralOnly, async () => { launched++; }), /no restriction the Docker egress proxy can enforce/);
    assert.equal(launched, 0);
    await executeDockerRunWithSpecNetwork(spec(), async () => { launched++; });
    assert.equal(launched, 1, 'an open spec launches unchanged');
});

test('MCP networking is a capability: private network, else a reachable URL, else unavailable', () => {
    const docker = { kind: 'docker', capabilities: DOCKER_RUNTIME_CAPABILITIES };
    assert.equal(planAgentRunMcpTransport(docker, {}).transport, 'private-network');
    const remote = { kind: 'remote', capabilities: capabilities() };
    assert.deepEqual(planAgentRunMcpTransport(remote, { API_PUBLIC_URL: 'https://propr.example.com/' }).transport, 'reachable-url');
    assert.equal(agentRunMcpReachableUrl({ API_PUBLIC_URL: 'https://propr.example.com/' }), 'https://propr.example.com/api/mcp');
    assert.equal(agentRunMcpReachableUrl({ API_PUBLIC_URL: '  https://propr.example.com/propr///  ' }), 'https://propr.example.com/propr/api/mcp');
    assert.equal(agentRunMcpReachableUrl({ API_PUBLIC_URL: '///' }), undefined);
    assert.equal(agentRunMcpReachableUrl({ PROPR_AGENT_MCP_URL: 'https://mcp.example.com/api/mcp', API_PUBLIC_URL: 'https://propr.example.com' }), 'https://mcp.example.com/api/mcp');
    assert.equal(agentRunMcpReachableUrl({ PROPR_AGENT_MCP_URL: 'http://api:4000/api/mcp', PROPR_AGENT_DOCKER_NETWORK: 'private' }), undefined,
        'an MCP URL pinned to a private network is not reachable without it');
    const none = planAgentRunMcpTransport(remote, {});
    assert.equal(none.transport, 'unavailable');
    assert.match(none.reason, /PROPR_AGENT_MCP_URL.*API_PUBLIC_URL/);
    const noHttp = { kind: 'sealed', capabilities: capabilities({ supportsMcpReachableUrl: false }) };
    assert.equal(planAgentRunMcpTransport(noHttp, { API_PUBLIC_URL: 'https://propr.example.com' }).transport, 'unavailable');
});

test('a private-network MCP grant is refused on a runtime without private networking; a reachable-URL grant runs', () => {
    const remote = { kind: 'remote-mcp', capabilities: capabilities() } as any;
    const privateGrant = agentRunMcpGrant({ mcpServers: [{ name: 'propr', url: 'http://api:4000/api/mcp' }], dockerNetwork: 'propr_propr-agent-mcp' } as any)!;
    assert.equal(privateGrant.transport, 'private-network');
    assert.throws(() => assertAgentRuntimeSupports(remote, { ...spec(), mcpGrant: privateGrant }), (error: any) => error.capability === 'mcp_private_network' && /API_PUBLIC_URL/.test(error.message));
    const reachable = agentRunMcpGrant({ mcpServers: [{ name: 'propr', url: 'https://propr.example.com/api/mcp' }] } as any)!;
    assert.deepEqual(reachable, { servers: ['propr'], transport: 'reachable-url', url: 'https://propr.example.com/api/mcp' });
    assert.doesNotThrow(() => assertAgentRuntimeSupports(remote, { ...spec(), mcpGrant: reachable }));
    assert.throws(() => assertAgentRuntimeSupports({ ...remote, capabilities: capabilities({ supportsMcpReachableUrl: false }) }, { ...spec(), mcpGrant: reachable }), /reachable URL/);
});

test('the grant client falls back to the reachable URL and per-run token, and never issues an unusable grant', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => { calls.push(url); return Response.json({ grantId: 'g-9', url: 'http://api:4000/api/mcp', token: 'propr_mcp_run', expiresAt: 5 }); }) as unknown as typeof fetch;
    const environment = { SYSTEM_TASK_SECRET: 'secret' };
    const grant = await requestAgentRunMcpGrant('run-9', 'report', {
        environment, fetchImpl, now: () => 1,
        planTransport: () => ({ transport: 'reachable-url', url: 'https://propr.example.com/api/mcp', reason: 'test' }),
        resolveNetwork: async () => { throw new Error('private network discovery must not run'); },
    });
    assert.deepEqual(grant, { grantId: 'g-9', phase: 'report', url: 'https://propr.example.com/api/mcp', token: 'propr_mcp_run', expiresAt: 5, network: null, transport: 'reachable-url', scopes: [] });
    const policy = agentRunToolPolicy({ phase: 'report', capabilities: ['propr_mcp'], mcpGrant: { ...grant, network: 'ignored' } });
    assert.equal(policy.dockerNetwork, undefined, 'a reachable-URL grant never joins a private network');
    assert.equal(policy.mcpServers?.[0].url, 'https://propr.example.com/api/mcp');

    await assert.rejects(requestAgentRunMcpGrant('run-9', 'report', {
        environment, fetchImpl, now: () => 1,
        planTransport: () => ({ transport: 'unavailable', reason: 'no reachable MCP URL is configured' }),
    }), (error: any) => error.code === 'MCP_NETWORK_UNAVAILABLE' && /no reachable MCP URL/.test(error.message));
    assert.equal(calls.length, 1, 'no grant is requested when the run could not use it');

    await assert.rejects(requestAgentRunMcpGrant('run-9', 'report', { environment, fetchImpl, runtime: 'no-such-runtime' }), /Unknown agent runtime "no-such-runtime"/);
    assert.equal(calls.length, 1);
});

test('restricted Sprites admission refuses incompatible MCP endpoints before issuing either phase grant', async () => {
    const { executeWithNetworkPolicy } = await import('@propr/core');
    const url = 'http://api:4000/api/mcp';
    let requests = 0;
    const fetchImpl = async () => {
        requests++;
        return Response.json({ grantId: 'g', token: 'test', expiresAt: 5 });
    };
    for (const setting of ['PROPR_SPRITES_MCP_URL', 'PROPR_AGENT_MCP_URL', 'API_PUBLIC_URL']) {
        const environment = { PROPR_AGENT_RUNTIME: 'sprites', SYSTEM_TASK_SECRET: 'test', [setting]: url };
        const report = await readAgentRuntimeCapabilityReport({ environment, loadPolicy: async () => ({
            mode: 'restricted', enforced: true, allow: [], ignoreRepositoryAllow: false,
        }) });
        assert.equal(report.mcp.transport, 'unavailable', setting);
        assert.match(report.mcp.reason, /public HTTPS URL/);
        for (const phase of ['report', 'action'] as const) {
            await assert.rejects(executeWithNetworkPolicy(workflowPolicy, () =>
                requestAgentRunMcpGrant('run-1', phase, { environment, fetchImpl })),
            { code: 'MCP_NETWORK_UNAVAILABLE', message: report.mcp.reason });
        }
    }
    assert.equal(requests, 0);
    const environment = { SYSTEM_TASK_SECRET: 'test', PROPR_SPRITES_MCP_URL: url };
    const open = await executeWithNetworkPolicy({ mode: 'open', source: 'workflow', allow: [] }, () =>
        requestAgentRunMcpGrant('run-1', 'report', { runtime: 'sprites', environment, fetchImpl }));
    assert.equal(open.result.url, url);
    assert.equal(requests, 1);
});

test('an explicit MCP URL without a pinned network: the report and the issued grant both say reachable-url on Docker', async () => {
    const environment = { SYSTEM_TASK_SECRET: 'secret', PROPR_AGENT_MCP_URL: 'https://mcp.example.com/api/mcp' };
    const report = await readAgentRuntimeCapabilityReport({ environment, loadPolicy: async () => ({ mode: 'open' as const, enforced: false, allow: [], ignoreRepositoryAllow: false }) });
    assert.equal(report.runtime, 'docker');
    assert.deepEqual(report.mcp, {
        transport: 'reachable-url',
        reason: 'PROPR_AGENT_MCP_URL is set without PROPR_AGENT_DOCKER_NETWORK; runs on agent runtime "docker" reach ProPR MCP at that URL with their per-run grant token and join no private network.',
    });

    const fetchImpl = (async () => Response.json({ grantId: 'g-3', url: 'http://api:4000/api/mcp', token: 'propr_mcp_run', expiresAt: 5 })) as unknown as typeof fetch;
    const grant = await requestAgentRunMcpGrant('run-3', 'report', {
        environment, fetchImpl, now: () => 1,
        resolveNetwork: async () => { throw new Error('an unpinned custom endpoint must not discover a private network'); },
    });
    assert.equal(grant.transport, report.mcp.transport);
    assert.equal(grant.url, 'https://mcp.example.com/api/mcp');
    assert.equal(grant.network, null);
    const policy = agentRunToolPolicy({ phase: 'report', capabilities: ['propr_mcp'], mcpGrant: grant });
    assert.equal(policy.dockerNetwork, undefined);

    // Pinning a network beside the URL keeps the private-network preference.
    const pinned = { ...environment, PROPR_AGENT_DOCKER_NETWORK: 'propr_propr-agent-mcp' };
    assert.equal(planAgentRunMcpTransport({ kind: 'docker', capabilities: DOCKER_RUNTIME_CAPABILITIES }, pinned).transport, 'private-network');
    // A runtime that cannot reach a URL cannot use an unpinned custom endpoint, even with private networking.
    const privateOnly = { kind: 'private-only', capabilities: capabilities({ supportsMcpPrivateNetwork: true, supportsMcpReachableUrl: false }) };
    assert.equal(planAgentRunMcpTransport(privateOnly, environment).transport, 'unavailable');
    assert.equal(planAgentRunMcpTransport(privateOnly, pinned).transport, 'private-network');
});

test('the capability report says in advance which runs admission refuses', async () => {
    const restricted = async () => ({ mode: 'restricted' as const, enforced: true, allow: [], ignoreRepositoryAllow: false });
    const docker = await readAgentRuntimeCapabilityReport({ environment: {}, loadPolicy: restricted });
    assert.equal(docker.runtime, 'docker');
    assert.equal(docker.selectedBy, 'default');
    assert.equal(docker.network.restrictedRuns, 'enforced');
    assert.equal(docker.network.enforcement?.method, 'egress-proxy-socket');
    assert.equal(docker.network.refusingRuns, false);
    assert.equal(docker.mcp.transport, 'private-network');

    standIn('report-open-only', capabilities());
    const remote = await readAgentRuntimeCapabilityReport({ environment: { PROPR_AGENT_RUNTIME: 'report-open-only', API_PUBLIC_URL: 'https://propr.example.com' }, loadPolicy: restricted });
    assert.equal(remote.selectedBy, 'PROPR_AGENT_RUNTIME');
    assert.equal(remote.network.restrictedRuns, 'refused');
    assert.equal(remote.network.refusingRuns, true);
    assert.match(remote.network.refusal ?? '', /"report-open-only" cannot enforce the restricted network policy/);
    assert.deepEqual(remote.mcp, {
        transport: 'reachable-url',
        reason: 'Agent runtime "report-open-only" cannot join a private network; runs reach ProPR MCP at a reachable URL with their per-run grant token.',
    });

    // A restricted default that is not enforced applies only to runs whose effective policy stays restricted.
    const notEnforced = await readAgentRuntimeCapabilityReport({ environment: { PROPR_AGENT_RUNTIME: 'report-open-only' }, loadPolicy: async () => ({ mode: 'restricted' as const, enforced: false, allow: [], ignoreRepositoryAllow: false }) });
    assert.equal(notEnforced.network.instanceMode, 'restricted');
    assert.equal(notEnforced.network.restrictedRuns, 'refused');
    assert.equal(notEnforced.network.refusingRuns, false);

    const unreadable = await readAgentRuntimeCapabilityReport({ environment: { PROPR_AGENT_RUNTIME: 'report-open-only' }, loadPolicy: async () => { throw new Error('db locked'); } });
    assert.equal(unreadable.network.instanceMode, null);
    assert.equal(unreadable.network.refusingRuns, false);
    assert.match(unreadable.network.unavailable ?? '', /fail closed/);
    assert.ok(!JSON.stringify(unreadable).includes('db locked'));
});
