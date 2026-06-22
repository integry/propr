import assert from 'node:assert/strict';
import test from 'node:test';

import { validateRoutingUrl } from '../packages/shared/src/validateRoutingUrl.js';

test('validateRoutingUrl accepts secure origins, including the documented default', () => {
  assert.equal(validateRoutingUrl('wss://routing.propr.dev'), null);
  assert.equal(validateRoutingUrl('https://routing.propr.dev'), null);
  assert.equal(validateRoutingUrl('wss://routing.propr.dev/'), null); // lone trailing slash is an empty path
});

test('validateRoutingUrl allows insecure schemes only for localhost', () => {
  assert.equal(validateRoutingUrl('ws://localhost:8080'), null);
  assert.equal(validateRoutingUrl('http://127.0.0.1:8080'), null);
  assert.equal(validateRoutingUrl('http://[::1]:8080'), null);
});

test('validateRoutingUrl rejects insecure non-localhost origins', () => {
  assert.match(validateRoutingUrl('ws://routing.propr.dev') ?? '', /wss:\/\/ or https:\/\//);
  assert.match(validateRoutingUrl('http://routing.propr.dev') ?? '', /wss:\/\/ or https:\/\//);
});

test('validateRoutingUrl rejects unsupported schemes and unparseable values', () => {
  assert.match(validateRoutingUrl('ftp://routing.propr.dev') ?? '', /wss:\/\/ or https:\/\//);
  assert.match(validateRoutingUrl('not a url') ?? '', /not a valid URL/);
});

test('validateRoutingUrl rejects path-bearing origins', () => {
  assert.match(validateRoutingUrl('wss://routing.propr.dev/v1') ?? '', /origin without a path/);
  assert.match(validateRoutingUrl('wss://routing.propr.dev?foo=bar') ?? '', /origin without a path/);
  assert.match(validateRoutingUrl('wss://routing.propr.dev#frag') ?? '', /origin without a path/);
});
