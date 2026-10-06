import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { closeConnection, type NetworkEgressReport } from '@propr/core';
import { networkEgressEvent, runWithNetworkPolicy, shouldRecordNetworkEgress } from '../src/jobs/networkEgress.js';

after(closeConnection);

const report = (overrides: Partial<NetworkEgressReport> = {}): NetworkEgressReport => ({
    mode: 'restricted', source: 'workflow', allow: [], restrictedContainers: 1, fallbacks: [], refusals: [],
    allowedConnections: 12, deniedConnections: 0, deniedHosts: [], omittedDeniedHosts: 0, omittedDeniedAttempts: 0, ...overrides,
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
    assert.equal(shouldRecordNetworkEgress(report({ mode: 'open', source: 'instance' })), false, 'the default open mode adds no event');
    assert.equal(shouldRecordNetworkEgress(report({ mode: 'open', source: 'workflow' })), true);
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
