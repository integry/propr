import { describe, test } from 'node:test';
import assert from 'node:assert';
import { getFixEnvironmentRepairInstructions } from '../src/jobs/environmentRepairPrompt.js';

describe('getFixEnvironmentRepairInstructions', () => {
    test('returns setup repair guidance for /fix mode', () => {
        const instructions = getFixEnvironmentRepairInstructions('fix');

        assert.ok(instructions.includes('Environment Repair for /fix'));
        assert.ok(instructions.includes('.propr/setup.sh'));
        assert.ok(instructions.includes('sudo apt-get update/install'));
        assert.ok(instructions.includes('retry the failed verification command once'));
    });

    test('returns empty guidance for non-fix modes', () => {
        assert.strictEqual(getFixEnvironmentRepairInstructions('default'), '');
        assert.strictEqual(getFixEnvironmentRepairInstructions('review'), '');
        assert.strictEqual(getFixEnvironmentRepairInstructions(undefined), '');
    });
});
