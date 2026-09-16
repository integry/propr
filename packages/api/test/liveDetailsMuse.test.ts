import assert from 'node:assert/strict';
import { after, test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.GH_APP_ID = process.env.GH_APP_ID || '1';
process.env.GH_PRIVATE_KEY_PATH = process.env.GH_PRIVATE_KEY_PATH || '/tmp/missing-key.pem';
process.env.GH_INSTALLATION_ID = process.env.GH_INSTALLATION_ID || '1';

const { detectStoredOutputFormat } = await import('../routes/liveDetailsStoredOutputFormat.js');
const { parseMuseOutputToConversationResult } = await import('../routes/liveDetailsOutputParsers.js');

after(async () => {
  const { db } = await import('@propr/core');
  await db.destroy();
});

const output = [
  JSON.stringify({
    stream: { kind: 'session', id: 'muse-session' },
    payload_type: 'run.model.configured',
    payload: { model_id: 'muse-spark-1.3' },
  }),
  JSON.stringify({
    payload_type: 'run.terminal.completed',
    payload: { terminal: 'completed', text: 'Review complete' },
  }),
].join('\n');

test('detectStoredOutputFormat recognizes Muse Code JSONL', () => {
  assert.equal(detectStoredOutputFormat(output), 'muse');
});

test('Muse Code stored output exposes the terminal response in live details', () => {
  const parsed = parseMuseOutputToConversationResult(output);
  assert.equal(parsed?.events.length, 1);
  assert.equal(parsed?.events[0]?.content, 'Review complete');
  assert.deepEqual(parsed?.todos, []);
});
