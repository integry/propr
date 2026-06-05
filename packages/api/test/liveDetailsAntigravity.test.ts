import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { detectStoredOutputFormat } from '../routes/liveDetailsStoredOutputFormat.js';

process.env.NODE_ENV = 'test';

after(async () => {
  const { db } = await import('@propr/core');
  await db.destroy();
});

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

test('stored output detection keeps Codex tool result JSONL classified as Codex', () => {
  const output = [
    JSON.stringify({ type: 'tool_result', result: 'package.json contents', timestamp: '2026-06-05T13:00:02.000Z' })
  ].join('\n');

  assert.equal(detectStoredOutputFormat(output), 'codex');
});

test('stored output detection does not treat generic init JSONL as Antigravity', () => {
  const output = [
    JSON.stringify({ type: 'init', timestamp: '2026-06-05T13:00:00.000Z' })
  ].join('\n');

  assert.equal(detectStoredOutputFormat(output), 'unknown');
});

test('stored output detection recognizes Antigravity JSONL from result stats when init is missing', () => {
  const output = [
    JSON.stringify({ type: 'message', role: 'assistant', content: 'done', timestamp: '2026-06-05T13:00:01.000Z' }),
    JSON.stringify({ type: 'tool_result', result: 'package.json contents', timestamp: '2026-06-05T13:00:02.000Z' }),
    JSON.stringify({ type: 'result', status: 'success', stats: { input_tokens: 10, output_tokens: 2 }, timestamp: '2026-06-05T13:00:03.000Z' })
  ].join('\n');

  assert.equal(detectStoredOutputFormat(output), 'antigravity');
});

test('stored output detection recognizes truncated Antigravity result JSON', () => {
  const output = JSON.stringify({
    type: 'result',
    status: 'success',
    stats: { input_tokens: 10, output_tokens: 2 },
    timestamp: '2026-06-05T13:00:02.000Z'
  });

  assert.equal(detectStoredOutputFormat(output), 'antigravity');
});

test('stored output detection recognizes Antigravity message JSON with model metadata', () => {
  const output = JSON.stringify({
    type: 'message',
    role: 'assistant',
    content: 'done',
    model: 'gemini-3-pro-preview',
    timestamp: '2026-06-05T13:00:01.000Z'
  });

  assert.equal(detectStoredOutputFormat(output), 'antigravity');
});

test('stored output parsing renders Antigravity stream events through live details', async () => {
  process.env.GH_APP_ID = process.env.GH_APP_ID || '1';
  process.env.GH_PRIVATE_KEY_PATH = process.env.GH_PRIVATE_KEY_PATH || '/tmp/missing-key.pem';
  process.env.GH_INSTALLATION_ID = process.env.GH_INSTALLATION_ID || '1';
  const { parseStoredOutputContent } = await import('../routes/liveDetailsRoutes.js');
  const output = [
    JSON.stringify({ type: 'init', timestamp: '2026-06-05T13:00:00.000Z', session_id: 'session-1', model: 'gemini-3-pro-preview' }),
    JSON.stringify({ type: 'message', role: 'assistant', content: 'I will inspect the repo.', timestamp: '2026-06-05T13:00:01.000Z' }),
    JSON.stringify({ type: 'tool_result', result: 'package.json contents', timestamp: '2026-06-05T13:00:02.000Z' }),
    JSON.stringify({ type: 'result', status: 'success', stats: { input_tokens: 10, output_tokens: 2 }, timestamp: '2026-06-05T13:00:03.000Z' })
  ].join('\n');

  const parsed = parseStoredOutputContent(output);

  assert.equal(parsed.format, 'antigravity');
  assert.deepEqual(parsed.parsed?.events, [
    { type: 'thought', content: 'I will inspect the repo.', timestamp: '2026-06-05T13:00:01.000Z' },
    { type: 'tool_result', result: 'package.json contents', isError: false, timestamp: '2026-06-05T13:00:02.000Z' }
  ]);
  assert.deepEqual(parsed.parsed?.tokenUsage, {
    input_tokens: 10,
    output_tokens: 2,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0
  });
});
