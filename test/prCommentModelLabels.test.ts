import { describe, test } from 'node:test';
import assert from 'node:assert';
import { extractModelLabelToken } from '../src/jobs/prModelLabelUtils.js';

describe('PR comment model labels', () => {
    test('preserves agent-prefixed model labels so follow-ups use the same agent', () => {
        const llm = extractModelLabelToken([{ name: 'gitfix' }, { name: 'llm-vibe-mistral' }]);

        assert.strictEqual(llm, 'vibe-mistral');
    });

    test('returns null when no model label exists', () => {
        const llm = extractModelLabelToken([{ name: 'gitfix' }]);

        assert.strictEqual(llm, null);
    });
});
