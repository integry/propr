import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateTaskId } from '../packages/api/routes/validation.js';

test('validateTaskId accepts model-derived task IDs with dotted versions', () => {
  const result = validateTaskId('integry-propr-site-12-antigravity-antigravity-gemini-3.5-flash-medium-0afb47c9-29e8-4daa-9ed4-a889993293a5');
  assert.equal(result.valid, true);
});

test('validateTaskId still rejects unsafe path characters', () => {
  assert.equal(validateTaskId('../bad-task').valid, false);
  assert.equal(validateTaskId('bad/task').valid, false);
  assert.equal(validateTaskId('bad task').valid, false);
  assert.equal(validateTaskId('bad:task').valid, false);
  assert.equal(validateTaskId('.').valid, false);
  assert.equal(validateTaskId('..').valid, false);
});
