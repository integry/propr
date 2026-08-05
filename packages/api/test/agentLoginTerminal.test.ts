import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  sanitizeTerminalChunk,
  type TerminalSanitizerState,
} from '../services/agentLoginTerminal.js';

function state(): TerminalSanitizerState {
  return {
    escapeState: 'text',
    controlStringBuffer: '',
    emittedTerminalLinks: new Set<string>(),
  };
}

test('recovers visible output after an oversized unterminated control string', () => {
  const session = state();
  const output = sanitizeTerminalChunk(
    session,
    `\u001b]0;${'x'.repeat(16 * 1024 + 1)}VISIBLE`,
  );

  assert.match(output, /VISIBLE$/);
  assert.equal(session.escapeState, 'text');
  assert.equal(session.controlStringBuffer, '');
});

test('recovers visible output after an oversized unterminated CSI sequence', () => {
  const session = state();
  const output = sanitizeTerminalChunk(
    session,
    `\u001b[${'?'.repeat(65)}VISIBLE`,
  );

  assert.match(output, /VISIBLE$/);
  assert.equal(session.escapeState, 'text');
  assert.equal(session.escapeSequenceLength, 0);
});

test('recovers visible output after oversized escape intermediates', () => {
  const session = state();
  const output = sanitizeTerminalChunk(
    session,
    `\u001b${' '.repeat(65)}VISIBLE`,
  );

  assert.match(output, /VISIBLE$/);
  assert.equal(session.escapeState, 'text');
});

test('bounds remembered OSC-8 hyperlinks and evicts the oldest target', () => {
  const session = state();
  for (let index = 0; index < 140; index++) {
    sanitizeTerminalChunk(
      session,
      `\u001b]8;;https://example.test/login/${index}\u0007link\u001b]8;;\u0007`,
    );
  }

  assert.equal(session.emittedTerminalLinks.size, 128);
  assert.equal(session.emittedTerminalLinks.has('https://example.test/login/0'), false);
  assert.equal(session.emittedTerminalLinks.has('https://example.test/login/139'), true);

  const reEmitted = sanitizeTerminalChunk(
    session,
    '\u001b]8;;https://example.test/login/0\u0007link\u001b]8;;\u0007',
  );
  assert.match(reEmitted, /https:\/\/example\.test\/login\/0/);
  assert.equal(session.emittedTerminalLinks.size, 128);
});
