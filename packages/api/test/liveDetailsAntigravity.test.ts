import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectStoredOutputFormat } from '../routes/liveDetailsStoredOutputFormat.js';

process.env.NODE_ENV = 'test';

test('stored output detection recognizes Antigravity stream JSON', () => {
  const output = [
    JSON.stringify({ type: 'init', timestamp: '2026-06-05T13:00:00.000Z', session_id: 'session-1', model: 'gemini-3-pro-preview' }),
    JSON.stringify({ type: 'message', role: 'assistant', content: 'done', timestamp: '2026-06-05T13:00:01.000Z' }),
    JSON.stringify({ type: 'result', status: 'success', stats: { input_tokens: 10, output_tokens: 2 }, timestamp: '2026-06-05T13:00:02.000Z' })
  ].join('\n');

  assert.equal(detectStoredOutputFormat(output), 'antigravity');
});

test('stored output detection keeps Codex message JSONL classified as Codex', () => {
  const output = [
    JSON.stringify({ type: 'message', role: 'assistant', content: 'Codex says hi' })
  ].join('\n');

  assert.equal(detectStoredOutputFormat(output), 'codex');
});

test('stored output detection keeps Codex result JSONL classified as Codex', () => {
  const output = [
    JSON.stringify({ type: 'result', result: 'Success', status: 'success' })
  ].join('\n');

  assert.equal(detectStoredOutputFormat(output), 'codex');
});
