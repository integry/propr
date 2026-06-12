import assert from 'node:assert/strict';
import { test } from 'node:test';

import { validateRelayUrl } from '../packages/shared/src/validateRelayUrl.js';

test('validateRelayUrl allows https and localhost http URLs', () => {
  assert.equal(validateRelayUrl('https://relay.example.com/v1'), null);
  assert.equal(validateRelayUrl('http://localhost:3000/v1'), null);
  assert.equal(validateRelayUrl('http://127.0.0.1:3000/v1'), null);
  assert.equal(validateRelayUrl('http://[::1]:3000/v1'), null);
});

test('validateRelayUrl rejects non-localhost http and non-http schemes', () => {
  assert.match(validateRelayUrl('http://example.com/v1') ?? '', /https/);
  assert.match(validateRelayUrl('ftp://localhost/v1') ?? '', /https/);
  assert.match(validateRelayUrl('file://localhost/tmp/relay') ?? '', /https/);
});

test('validateRelayUrl reports invalid URLs', () => {
  assert.match(validateRelayUrl('not a url') ?? '', /not a valid URL/);
});
