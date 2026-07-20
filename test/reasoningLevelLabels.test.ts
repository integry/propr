import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  REASONING_LEVELS,
  parseReasoningLevelFromLabels,
} from '@propr/shared';
import {
  resolveClaudeReasoningLevel,
  resolveCodexReasoningLevel,
} from '../packages/core/src/config/configManagerReasoning.ts';

const { closeConnection } = await import('../packages/core/src/db/connection.ts');

after(async () => {
  await closeConnection();
});

describe('parseReasoningLevelFromLabels', () => {
  test('parses every accepted reasoning level', () => {
    for (const level of REASONING_LEVELS) {
      assert.equal(parseReasoningLevelFromLabels([`level-${level}`]), level);
    }
  });

  test('is case-insensitive', () => {
    assert.equal(parseReasoningLevelFromLabels(['LEVEL-XHIGH']), 'xhigh');
    assert.equal(parseReasoningLevelFromLabels(['Level-UltraCode']), 'ultracode');
  });

  test('supports GitHub label objects and raw label strings', () => {
    assert.equal(parseReasoningLevelFromLabels([{ name: 'level-max' }]), 'max');
    assert.equal(parseReasoningLevelFromLabels(['AI', { name: 'level-high' }]), 'high');
  });

  test('ignores invalid level labels', () => {
    assert.equal(parseReasoningLevelFromLabels(['level-extreme']), undefined);
    assert.equal(parseReasoningLevelFromLabels(['level-extra-high']), undefined);
    assert.equal(parseReasoningLevelFromLabels(['some-level-high']), undefined);
  });

  test('returns the first matching level', () => {
    assert.equal(parseReasoningLevelFromLabels(['level-low', 'level-max']), 'low');
  });
});

describe('reasoning level runtime clamping', () => {
  test('clamps Claude-only ultracode to Codex ultra and omits Codex auto', () => {
    assert.equal(resolveCodexReasoningLevel('ultracode'), 'ultra');
    assert.equal(resolveCodexReasoningLevel('auto'), null);
  });

  test('clamps Codex-only ultra to Claude max and passes Claude auto through', () => {
    assert.equal(resolveClaudeReasoningLevel('ultra'), 'max');
    assert.equal(resolveClaudeReasoningLevel('auto'), 'auto');
  });
});
