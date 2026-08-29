import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildSocketConnection, normalizeApiBaseUrl } from '../src/index.js';

describe('Socket.IO connection configuration', () => {
  it('uses same-origin session cookies and explicit reconnect defaults', () => {
    const connection = buildSocketConnection(
      normalizeApiBaseUrl(''),
      { type: 'session' }
    );

    assert.equal(connection.url, undefined);
    assert.equal(connection.options.withCredentials, true);
    assert.equal(connection.options.path, '/socket.io/');
    assert.deepEqual(connection.options.transports, ['websocket']);
    assert.equal(connection.options.reconnection, true);
    assert.equal(connection.options.reconnectionAttempts, Infinity);
    assert.equal(connection.options.reconnectionDelay, 1000);
    assert.equal(connection.options.reconnectionDelayMax, 5000);
  });

  it('targets remote instances and resolves bearer auth for every connection attempt', async () => {
    let token = 'first-token';
    const connection = buildSocketConnection(
      normalizeApiBaseUrl('https://propr.example.com'),
      { type: 'bearer', getAccessToken: () => token }
    );

    assert.equal(connection.url, 'https://propr.example.com');
    assert.equal(connection.options.withCredentials, false);
    assert.equal(typeof connection.options.auth, 'function');

    const resolveAuth = (): Promise<unknown> => new Promise(resolve => {
      (connection.options.auth as (callback: (data: unknown) => void) => void)(resolve);
    });
    assert.deepEqual(await resolveAuth(), { token: 'first-token' });
    token = 'refreshed-token';
    assert.deepEqual(await resolveAuth(), { token: 'refreshed-token' });
  });
});
