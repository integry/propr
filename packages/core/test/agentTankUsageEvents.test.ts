import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import {
    agentTankUsageFingerprint,
    observeAgentTankUsage,
    resetAgentTankUsageTracking,
} from '../src/services/agentTankUsageEvents.js';
import type { AgentStatusResponse } from '../src/services/agentTankTypes.js';

const snapshot = (percent: number, resetsInSeconds = 764): AgentStatusResponse => ({
    name: 'claude',
    usage: {
        session: { percent, resetsInSeconds },
        weeklyAll: { percent: 31, resetsInSeconds: 364_364 },
    },
    lastUpdated: new Date(percent * 1000).toISOString(),
});

beforeEach(() => resetAgentTankUsageTracking());

describe('agent tank usage change detection', () => {
    test('countdowns and refresh timestamps are not usage changes', () => {
        assert.equal(
            agentTankUsageFingerprint(snapshot(42, 764)),
            agentTankUsageFingerprint(snapshot(42, 12)),
        );
        assert.notEqual(
            agentTankUsageFingerprint(snapshot(42)),
            agentTankUsageFingerprint(snapshot(58)),
        );
    });

    test('key order in the provider response is not a usage change', () => {
        const ordered: AgentStatusResponse = {
            name: 'claude',
            usage: { session: { percent: 42 }, weeklyAll: { percent: 31 } },
        };
        const reordered: AgentStatusResponse = {
            name: 'claude',
            usage: { weeklyAll: { percent: 31 }, session: { percent: 42 } },
        };
        assert.equal(
            agentTankUsageFingerprint(ordered),
            agentTankUsageFingerprint(reordered),
        );
    });

    test('only an observed change publishes, and the first read just seeds', async () => {
        let published = 0;
        const publish = async () => { published += 1; };

        await observeAgentTankUsage(snapshot(42), publish);
        assert.equal(published, 0, 'the baseline read is not a change');

        await observeAgentTankUsage(snapshot(42, 12), publish);
        assert.equal(published, 0, 'an unchanged poll must not publish');

        await observeAgentTankUsage(snapshot(58), publish);
        assert.equal(published, 1);

        await observeAgentTankUsage(snapshot(58), publish);
        assert.equal(published, 1);
    });

    test('each agent is tracked separately', async () => {
        let published = 0;
        const publish = async () => { published += 1; };

        await observeAgentTankUsage({ ...snapshot(42), name: 'claude' }, publish);
        await observeAgentTankUsage({ ...snapshot(42), name: 'codex' }, publish);
        assert.equal(published, 0);

        await observeAgentTankUsage({ ...snapshot(50), name: 'codex' }, publish);
        assert.equal(published, 1);
    });

    test('a failed publish is swallowed so the status read still returns', async () => {
        await observeAgentTankUsage(snapshot(42));
        await assert.doesNotReject(observeAgentTankUsage(snapshot(58), async () => {
            throw new Error('Redis is unreachable');
        }));
    });
});
