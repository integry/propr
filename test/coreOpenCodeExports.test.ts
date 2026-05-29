import { after, test } from 'node:test';
import assert from 'node:assert';

process.env.NODE_ENV = 'test';

const core = await import('@propr/core');

after(async () => {
    await core.closeConnection();
});

test('@propr/core exports OpenCode agent and helpers', () => {
    assert.strictEqual(typeof core.OpenCodeAgent, 'function');
    assert.strictEqual(typeof core.buildOpenCodePrompt, 'function');
    assert.strictEqual(typeof core.parseOpenCodeStreamOutput, 'function');
});
