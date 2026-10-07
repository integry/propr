import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { closeConnection, prepareDockerRunNetwork, type NetworkEgressReport } from '@propr/core';
import { networkEgressEvent, runWithNetworkPolicy, shouldRecordNetworkEgress } from '../src/jobs/networkEgress.js';

after(closeConnection);

const report = (overrides: Partial<NetworkEgressReport> = {}): NetworkEgressReport => ({
    mode: 'restricted', source: 'workflow', allow: [], restrictedContainers: 1, fallbacks: [], refusals: [],
    allowedConnections: 12, deniedConnections: 0, deniedHosts: [], omittedDeniedHosts: 0, omittedDeniedAttempts: 0, failedConnections: 0, failedHosts: [], ...overrides,
});

test('the timeline event names the mode and counts every denied host', () => {
    assert.equal(networkEgressEvent(report()).reason, 'Restricted network: no connections denied');
    const denied = networkEgressEvent(report({ deniedConnections: 4, deniedHosts: [{ host: 'paste.example.org', count: 3 }], omittedDeniedHosts: 1, omittedDeniedAttempts: 1 }));
    assert.equal(denied.reason, 'Restricted network: denied 4 connections to 2 hosts');
    assert.equal(denied.metadata.event, 'network.egress');
    assert.deepEqual((denied.metadata.networkEgress as NetworkEgressReport).deniedHosts, [{ host: 'paste.example.org', count: 3 }]);
    assert.equal(networkEgressEvent(report({ restrictedContainers: 0, fallbacks: [{ agentType: 'antigravity', reason: 'unverified' }] })).reason,
        'Restricted network unavailable for antigravity; ran with open network');
    assert.equal(networkEgressEvent(report({ restrictedContainers: 0, refusals: [{ agentType: 'antigravity', reason: 'unverified' }] })).reason,
        'Restricted network enforced: refused antigravity');
    assert.equal(networkEgressEvent(report({ failedConnections: 3, failedHosts: [{ host: 'api.example.com', count: 3 }] })).reason,
        'Restricted network: no connections denied; 3 allowed connections failed', 'a worker proxy that refuses allowed hosts is visible');
    assert.equal(networkEgressEvent(report({ restrictedContainers: 0 })).reason, 'Restricted network: no agent container started',
        'a run that failed before any container never claims a container ran behind the proxy');
    assert.equal(shouldRecordNetworkEgress(report({ mode: 'open', source: 'instance' })), false, 'the default open mode adds no event');
    assert.equal(shouldRecordNetworkEgress(report({ mode: 'open', source: 'workflow' })), true);
});

test('a refusal followed by a supported agent behind the proxy is labelled by the final outcome', () => {
    const refusals = [{ agentType: 'antigravity', reason: 'unverified' }];
    const mixed = networkEgressEvent(report({ source: 'instance_enforced', restrictedContainers: 1, refusals }));
    assert.equal(mixed.reason, 'Restricted network: no connections denied');
    assert.deepEqual((mixed.metadata.networkEgress as NetworkEgressReport).refusals, refusals, 'the refusal stays in the details');
    assert.equal(networkEgressEvent(report({ restrictedContainers: 2, refusals, deniedConnections: 1, deniedHosts: [{ host: 'x.example.com', count: 1 }] })).reason,
        'Restricted network: denied 1 connection to 1 host');
    assert.equal(networkEgressEvent(report({ restrictedContainers: 1, fallbacks: [{ agentType: 'antigravity', reason: 'unverified' }] })).reason,
        'Restricted network: no connections denied');
});

test('work without a task logs a report that needs attention instead of recording it', async () => {
    const warnings: unknown[] = [];
    let recorded = 0;
    const options = {
        correlatedLogger: { warn(...args: unknown[]) { warnings.push(args); } },
        resolvePolicy: async () => ({ mode: 'restricted' as const, source: 'instance' as const, allow: [] }),
        record: async () => { recorded++; },
    };
    assert.equal(await runWithNetworkPolicy(options, async () => 'indexed'), 'indexed');
    assert.equal(warnings.length, 0, 'a clean run logs nothing');
    // A container without a network option is on the default bridge, so it is subject to the policy too.
    await runWithNetworkPolicy(options, () => prepareDockerRunNetwork('docker', ['run', '--rm', '-e', 'PROPR_AGENT_TYPE=antigravity', 'agent:test']));
    assert.equal(recorded, 0);
    assert.equal(warnings.length, 1);
    assert.match(String((warnings[0] as unknown[])[1]), /Restricted network unavailable for antigravity/);
});

test('the aggregated report is recorded once per run, after success and after failure', async () => {
    const recorded: Array<{ taskId: string; report: NetworkEgressReport }> = [];
    const options = {
        taskId: 'task-1', correlatedLogger: { warn() {} },
        resolvePolicy: async () => ({ mode: 'restricted' as const, source: 'instance' as const, allow: [] }),
        record: async (taskId: string, value: NetworkEgressReport) => { recorded.push({ taskId, report: value }); },
    };
    assert.equal(await runWithNetworkPolicy(options, async () => 'done'), 'done');
    await assert.rejects(runWithNetworkPolicy(options, async () => { throw new Error('agent failed'); }), /agent failed/);
    assert.deepEqual(recorded.map(entry => [entry.taskId, entry.report.mode]), [['task-1', 'restricted'], ['task-1', 'restricted']]);
});
