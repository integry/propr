import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  REASONING_LEVELS,
  isReasoningLevelLabel,
  parseReasoningLevelFromLabels,
} from '@propr/shared';
import {
  resolveClaudeReasoningLevel,
  resolveCodexReasoningLevel,
  resolveMuseReasoningLevel,
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

  test('selects the highest-priority matching level deterministically', () => {
    assert.equal(parseReasoningLevelFromLabels(['level-low', 'level-max']), 'max');
    assert.equal(parseReasoningLevelFromLabels(['level-auto', 'level-high']), 'high');
    assert.equal(parseReasoningLevelFromLabels(['level-ultra', 'level-ultracode']), 'ultracode');
  });

  test('detects valid reasoning labels', () => {
    assert.equal(isReasoningLevelLabel('level-xhigh'), true);
    assert.equal(isReasoningLevelLabel({ name: 'LEVEL-AUTO' }), true);
    assert.equal(isReasoningLevelLabel('level-extreme'), false);
    assert.equal(isReasoningLevelLabel({ name: null }), false);
  });
});

describe('reasoning level runtime clamping', () => {
  test('clamps Claude-only ultracode to Codex ultra and omits Codex auto', () => {
    assert.equal(resolveCodexReasoningLevel('ultracode'), 'ultra');
    assert.equal(resolveCodexReasoningLevel('auto'), null);
  });

  test('clamps Codex-only ultra to Claude max and passes Claude auto', () => {
    assert.equal(resolveClaudeReasoningLevel('ultra'), 'max');
    assert.equal(resolveClaudeReasoningLevel('auto'), 'auto');
  });

  test('omits none and minimal on the Claude and Codex runtimes', () => {
    assert.equal(resolveCodexReasoningLevel('none'), null);
    assert.equal(resolveCodexReasoningLevel('minimal'), null);
    assert.equal(resolveClaudeReasoningLevel('none'), null);
    assert.equal(resolveClaudeReasoningLevel('minimal'), null);
  });

  test('omits none, auto, ultracode, and ultra on the Muse runtime', () => {
    assert.equal(resolveMuseReasoningLevel('auto'), null);
    assert.equal(resolveMuseReasoningLevel('ultracode'), null);
    assert.equal(resolveMuseReasoningLevel('ultra'), null);
    assert.equal(resolveMuseReasoningLevel('none'), null);
    assert.equal(resolveMuseReasoningLevel('minimal'), 'minimal');
  });
});
