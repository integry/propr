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

  it('preserves handshake metadata while only the fresh provider can supply the bearer token', async () => {
    let token = 'first-token';
    const connection = buildSocketConnection(
      normalizeApiBaseUrl('https://propr.example.com'),
      { type: 'bearer', getAccessToken: () => token },
      { auth: { proprDesktopTransportScope: 'scope-a', token: 'metadata-token' } }
    );

    const resolveAuth = (): Promise<unknown> => new Promise(resolve => {
      (connection.options.auth as (callback: (data: unknown) => void) => void)(resolve);
    });
    assert.deepEqual(await resolveAuth(), {
      proprDesktopTransportScope: 'scope-a',
      token: 'first-token',
    });
    token = 'refreshed-token';
    assert.deepEqual(await resolveAuth(), {
      proprDesktopTransportScope: 'scope-a',
      token: 'refreshed-token',
    });
  });

  it('routes Connect Socket.IO to the same origin and fixed proxy path', () => {
    const connection = buildSocketConnection(
      normalizeApiBaseUrl('https://t-instance123.propr.dev'),
      { type: 'none' }
    );

    assert.equal(connection.url, 'https://t-instance123.propr.dev');
    assert.equal(connection.options.path, '/socket.io/');
    assert.equal(connection.options.reconnection, true);
    assert.equal(connection.options.reconnectionAttempts, Infinity);
  });
});
