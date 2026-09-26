import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveApiListenHost } from '../listenAddress.js';

test('direct API execution binds to loopback by default', () => {
  assert.equal(resolveApiListenHost({}), '127.0.0.1');
});

test('containerized API execution remains reachable through its published port', () => {
  assert.equal(resolveApiListenHost({ PROPR_CONTAINERIZED: '1' }), '0.0.0.0');
});

test('an explicit API listen host overrides environment defaults', () => {
  assert.equal(
    resolveApiListenHost({ PROPR_CONTAINERIZED: '1', DASHBOARD_API_HOST: ' 127.0.0.2 ' }),
    '127.0.0.2',
  );
});
