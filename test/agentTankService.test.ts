import { after, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';

import { closeConnection } from '../packages/core/src/db/connection.js';
import {
    normalizeAgentTankAgents,
    normalizeAgentTankStatus,
    toAgentTankAgent,
    toProprAgent
} from '../packages/core/src/services/agentTankService.js';

after(async () => {
    await closeConnection();
});

test('maps ProPR antigravity alias to Agent Tank agy key', () => {
    assert.equal(toAgentTankAgent('antigravity'), 'agy');
});

test('maps Agent Tank agy key back to ProPR antigravity alias', () => {
    assert.equal(toProprAgent('agy'), 'antigravity');
});

test('leaves Agent Tank provider keys unchanged', () => {
    assert.equal(toAgentTankAgent('agy'), 'agy');
    assert.equal(toAgentTankAgent('claude'), 'claude');
    assert.equal(toAgentTankAgent('codex'), 'codex');
});

test('normalizes individual Agent Tank status responses to ProPR names', () => {
    assert.equal(normalizeAgentTankStatus({ name: 'agy', usage: {} }).name, 'antigravity');
});

test('normalizes Agent Tank usage maps to ProPR keys and names', () => {
    const normalized = normalizeAgentTankAgents({
        agy: { name: 'agy', usage: { models: [] } },
        claude: { name: 'claude', usage: {} },
    });

    assert.deepEqual(Object.keys(normalized).sort(), ['antigravity', 'claude']);
    assert.equal(normalized.antigravity.name, 'antigravity');
});
