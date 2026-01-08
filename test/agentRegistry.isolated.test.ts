import { test, after } from 'node:test';
import assert from 'node:assert';
import { AgentRegistry } from '@gitfix/core';

// Test 1: Singleton only
test('AgentRegistry - singleton test only', async () => {
    console.log('Starting singleton test...');
    const registry1 = AgentRegistry.getInstance();
    const registry2 = AgentRegistry.getInstance();
    assert.strictEqual(registry1, registry2, 'Should return the same instance');
    console.log('Singleton test passed');
});

// Cleanup after test
after(async () => {
    console.log('Starting cleanup...');
    try {
        await AgentRegistry.resetInstance();
        console.log('Cleanup completed');
    } catch (error) {
        console.error('Cleanup error:', error);
    }
});