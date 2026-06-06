import assert from 'node:assert/strict';
import test, { after } from 'node:test';

process.env.NODE_ENV = 'test';

after(async () => {
  const { closeConnection } = await import('@propr/core');
  await closeConnection();
});

test('detectStoredOutputFormat keeps Codex message streams with session_id as codex', async () => {
  const { detectStoredOutputFormat } = await import('../routes/liveDetailsStoredOutputFormat.js');
  const output = JSON.stringify({
    type: 'message',
    session_id: 'codex-session',
    role: 'assistant',
    content: 'Codex response'
  });

  assert.equal(detectStoredOutputFormat(output), 'codex');
});

test('detectStoredOutputFormat does not classify bare conversation_id JSON as Claude', async () => {
  const { detectStoredOutputFormat } = await import('../routes/liveDetailsStoredOutputFormat.js');
  assert.equal(detectStoredOutputFormat('{"conversation_id":"provider-session"}\n'), 'unknown');
});

test('detectStoredOutputFormat keeps Claude-shaped conversation_id JSON as Claude', async () => {
  const { detectStoredOutputFormat } = await import('../routes/liveDetailsStoredOutputFormat.js');
  assert.equal(
    detectStoredOutputFormat('{"conversation_id":"claude-session","role":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}\n'),
    'claude'
  );
});

test('parseOpenCodeOutputToConversationResult separates structured assistant text parts', async () => {
  const { parseOpenCodeOutputToConversationResult } = await import('../routes/liveDetailsOpenCodeParser.js');
  const output = JSON.stringify({
    type: 'message',
    sessionID: 'opencode-session',
    message: {
      role: 'assistant',
      parts: [
        { type: 'text', text: 'First part.' },
        { type: 'text', text: 'Second part.' }
      ]
    }
  });

  const result = parseOpenCodeOutputToConversationResult(output);

  assert.equal(result?.events[0]?.type, 'message');
  assert.equal(result?.events[0]?.content, 'First part.\nSecond part.');
});
