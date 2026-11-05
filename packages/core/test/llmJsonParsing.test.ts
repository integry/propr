import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLlmJson, JsonParseError } from '../src/utils/jsonUtils.ts';

test('recovers pretty-printed JSON with literal newlines inside string values', () => {
  const response = '{\n  "action": "modified",\n  "summary": "Reworked storage.\n\n**Task 1**\trewritten",\n  "plan": []\n}';
  const parsed = parseLlmJson<{ action: string; summary: string; plan: unknown[] }>(response);
  assert.equal(parsed.action, 'modified');
  assert.equal(parsed.summary, 'Reworked storage.\n\n**Task 1**\trewritten');
  assert.deepEqual(parsed.plan, []);
});

test('keeps apostrophes intact while recovering literal newlines', () => {
  const response = '{\n  "summary": "Removed it.\nI didn\'t add a file backend",\n  "plan": []\n}';
  assert.equal(parseLlmJson<{ summary: string }>(response).summary, "Removed it.\nI didn't add a file backend");
});

test('still applies loose fixes to JS-style objects', () => {
  assert.deepEqual(parseLlmJson("{action: 'answered', plan: [],}"), { action: 'answered', plan: [] });
});

test('reports the defect position rather than damage from the recovery passes', () => {
  const response = '{\n  "summary": "says "hi" here",\n  "plan": []\n}';
  assert.throws(() => parseLlmJson(response), (error: unknown) => {
    assert.ok(error instanceof JsonParseError);
    assert.match(error.message, /line 2/);
    assert.match(error.message, /Context: \.\.\.\{\n  "summary": "says "/);
    return true;
  });
});

test('recovers single-quoted strings that hold literal newlines', () => {
  assert.deepEqual(parseLlmJson("{summary: 'line one\nline two'}"), { summary: 'line one\nline two' });
  const tasks = "[{'title':'A','body':'line one\nline two','implementation':'c'}]";
  assert.deepEqual(parseLlmJson(tasks), [{ title: 'A', body: 'line one\nline two', implementation: 'c' }]);
});
