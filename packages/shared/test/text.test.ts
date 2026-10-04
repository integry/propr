import assert from 'node:assert/strict';
import { test } from 'node:test';
import { truncateAtWord } from '../src/text.js';

test('truncateAtWord leaves text within the limit untouched', () => {
  assert.equal(truncateAtWord('Short title', 100), 'Short title');
  assert.equal(truncateAtWord('x'.repeat(100), 100), 'x'.repeat(100));
});

test('truncateAtWord cuts at the last word boundary and marks the cut', () => {
  const title = 'Expose task changes and logs through the MCP server so an MCP client can actually inspect a running task';
  const shortened = truncateAtWord(title, 100);
  assert.ok(shortened.length <= 100);
  assert.equal(shortened, 'Expose task changes and logs through the MCP server so an MCP client can actually inspect a running…');
  assert.equal(truncateAtWord('Fix the seed test, then rerun everything again', 20), 'Fix the seed test…');
});

test('truncateAtWord drops trailing punctuation before the ellipsis', () => {
  assert.equal(truncateAtWord('Add retries: then backoff and jitter', 15), 'Add retries…');
  assert.equal(truncateAtWord('One, two, three, four', 11), 'One, two…');
});

test('truncateAtWord never returns more than max characters', () => {
  for (const max of [1, 2, 5, 10, 37, 100]) {
    assert.ok(truncateAtWord('a'.repeat(250), max).length <= max);
    assert.ok(truncateAtWord('word '.repeat(60), max).length <= max);
  }
  assert.equal(truncateAtWord('Unbroken-identifier-that-is-long', 10), 'Unbroken…');
});
