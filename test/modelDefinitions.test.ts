import { test } from 'node:test';
import assert from 'node:assert';
import { MODEL_INFO_MAP } from '../packages/shared/src/modelDefinitions.ts';

test('Mistral Medium uses the OpenRouter pricing model ID', () => {
    assert.strictEqual(
        MODEL_INFO_MAP['mistral-medium-3.5']?.openRouterId,
        'mistralai/mistral-medium-3-5'
    );
});
