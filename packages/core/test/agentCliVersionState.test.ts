import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { closeConnection } from '../src/db/connection.js';
import {
    agentCliVersionWarnings,
    describeAgentCliVersionStates,
    isAwaitingWorkerImagePreparation,
} from '../src/agents/agentCliVersionState.js';
import { agentRuntimeEvent, instrumentAgentRuntimeEvents } from '../src/agents/agentRuntimeEvent.js';
import type { AgentRegistryOperationalStatus } from '../src/agents/agentRegistryTypes.js';
import type { Agent, AgentConfig } from '../src/agents/types.js';

after(() => closeConnection());

const codex = (cliVersionResolved: string, overrides: Partial<AgentConfig> = {}): AgentConfig => ({
    id: 'codex-1', type: 'codex', alias: 'codex', enabled: true, dockerImage: 'propr/runtime-agent:old',
    configPath: '/tmp/codex', supportedModels: ['gpt-5.5'], cliVersionType: 'specific', cliVersion: cliVersionResolved,
    cliVersionResolved, ...overrides,
});

function registry(live: AgentConfig[], unifiedAgentImage: AgentRegistryOperationalStatus['unifiedAgentImage']) {
    return {
        getAgentByAlias: (alias: string) => live.map(config => ({ config }) as unknown as Agent).find(agent => agent.config.alias === alias),
        getOperationalStatus: () => ({ unifiedAgentImage }),
    };
}

describe('agent CLI version state', () => {
    test('reports a pending version while runs keep the previous one', () => {
        const states = describeAgentCliVersionStates([codex('0.170.0')], registry([codex('0.171.0')], {
            status: 'unavailable', imageTag: 'propr/agent:bundle-new',
            error: 'Unified agent image propr/agent:bundle-new has not been prepared by the worker', recordedAt: new Date().toISOString(),
        }));
        assert.deepEqual(states, [{
            agentId: 'codex-1', alias: 'codex', type: 'codex', configuredVersion: '0.170.0', effectiveVersion: '0.171.0', status: 'preparing',
        }]);
        const [warning] = agentCliVersionWarnings(states);
        assert.match(warning, /preparing the image for codex CLI 0\.170\.0/);
        assert.match(warning, /Runs keep using codex CLI 0\.171\.0 until it is ready/);
    });

    test('reports ready once the live registry runs the configured version', () => {
        const states = describeAgentCliVersionStates([codex('0.170.0')], registry([codex('0.170.0')], { status: 'ready' }));
        assert.equal(states[0].status, 'ready');
        assert.deepEqual(agentCliVersionWarnings(states), []);
    });

    test('reports a failed preparation with its error and retry time', () => {
        const nextRetryAt = new Date(Date.now() + 60_000).toISOString();
        const states = describeAgentCliVersionStates([codex('0.170.0')], registry([codex('0.171.0')], {
            status: 'unavailable', error: 'npm install failed', recordedAt: new Date().toISOString(), retryCount: 1, nextRetryAt,
        }));
        assert.equal(states[0].status, 'failed');
        assert.equal(states[0].error, 'npm install failed');
        assert.equal(states[0].nextRetryAt, nextRetryAt);
        assert.match(agentCliVersionWarnings(states)[0], /failed \(npm install failed\)/);
    });

    test('skips disabled agents and reports no live agent as not in use', () => {
        const states = describeAgentCliVersionStates(
            [codex('0.170.0'), codex('0.170.0', { id: 'off', alias: 'off', enabled: false })],
            registry([], { status: 'unavailable', error: 'has not been prepared by the worker', recordedAt: new Date().toISOString() }),
        );
        assert.equal(states.length, 1);
        assert.equal(states[0].effectiveVersion, null);
        assert.match(agentCliVersionWarnings(states)[0], /cannot start until it is ready/);
    });

    test('recognises the expected not-yet-prepared errors only', () => {
        assert.equal(isAwaitingWorkerImagePreparation('Unified agent image x has not been prepared by the worker; slot busy'), true);
        assert.equal(isAwaitingWorkerImagePreparation('Agent runtime image for x has not been prepared by the worker'), true);
        assert.equal(isAwaitingWorkerImagePreparation('Docker daemon unavailable'), false);
        assert.equal(isAwaitingWorkerImagePreparation(undefined), false);
    });
});

describe('agent runtime timeline event', () => {
    test('names the version a run used and a still-pending configured version', () => {
        const event = agentRuntimeEvent({ agentAlias: 'codex', agentType: 'codex', cliVersion: '0.171.0', image: 'propr/runtime-agent:old', configuredCliVersion: '0.170.0' });
        assert.equal(event.reason, 'Agent codex ran codex CLI 0.171.0; configured 0.170.0 was still being prepared');
        assert.equal(event.metadata.event, 'agent.runtime');
        assert.equal(agentRuntimeEvent({ agentAlias: 'codex', agentType: 'codex', cliVersion: '0.170.0', image: 'img' }).reason, 'Agent codex ran codex CLI 0.170.0');
    });

    test('instrumentation is idempotent and leaves runs without a task untouched', async () => {
        const calls: unknown[] = [];
        const agent = { config: codex('0.170.0'), executeTask: async (options: unknown) => { calls.push(options); return { success: true } as never; } } as unknown as Agent;
        assert.equal(instrumentAgentRuntimeEvents(instrumentAgentRuntimeEvents(agent)), agent);
        await agent.executeTask({ prompt: 'p' } as never);
        assert.deepEqual(calls, [{ prompt: 'p' }]);
    });
});
