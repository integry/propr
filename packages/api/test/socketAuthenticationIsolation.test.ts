import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';
import { closeConnection } from '@propr/core';
import { Server as SocketIOServer, type Socket as ServerSocket } from 'socket.io';
import { io as createSocketClient, type Socket as ClientSocket } from 'socket.io-client';
import {
  SocketAuthenticationError,
  type SocketPrincipal,
} from '../auth.js';
import type { GitHubUser } from '../authTypes.js';
import {
  configureSocketAuthentication,
  revalidateSocketAuthentication,
} from '../services/socketAuthentication.js';

after(async () => { await closeConnection(); });

function user(id: string): GitHubUser {
  return {
    id,
    login: id,
    username: id,
    displayName: id,
    email: null,
    avatarUrl: null,
  };
}

function principal(id: string): SocketPrincipal {
  return {
    user: user(id),
    authorization: { role: 'member', permissions: [], source: 'implicit' },
  };
}

async function waitForConnect(socket: ClientSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
}

async function waitForConnectError(socket: ClientSocket): Promise<Error & { data?: { code?: string } }> {
  return await new Promise((resolve, reject) => {
    socket.once('connect', () => reject(new Error('Socket unexpectedly connected')));
    socket.once('connect_error', error => resolve(error as Error & { data?: { code?: string } }));
  });
}

test('isolates authentication and revalidation across namespaces on one transport', async () => {
  const httpServer = createServer();
  const io = new SocketIOServer(httpServer, { transports: ['websocket'] });
  const seenAuthorization: string[] = [];
  configureSocketAuthentication(io, {
    engineMiddleware: [],
    authenticate: async request => {
      assert.equal(Object.isFrozen(request.headers), true);
      const authorization = request.headers.authorization;
      seenAuthorization.push(authorization ?? '<missing>');
      if (authorization === 'Bearer anchor-token') return principal('anchor');
      if (authorization === 'Bearer replacement-token') return principal('replacement');
      throw new SocketAuthenticationError('AUTHENTICATION_REQUIRED', 'missing bearer');
    },
  });

  let anchorServerSocket: ServerSocket | undefined;
  io.of('/anchor').on('connection', socket => {
    anchorServerSocket = socket;
  });
  io.of('/replaceable').on('connection', () => undefined);
  await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  const port = (httpServer.address() as AddressInfo).port;
  const anchor = createSocketClient(`http://127.0.0.1:${port}/anchor`, {
    transports: ['websocket'],
    auth: { token: 'anchor-token' },
    autoConnect: false,
    reconnection: false,
  });
  const replaceable = anchor.io.socket('/replaceable');
  replaceable.auth = { token: 'rejected-token' };

  try {
    const anchorConnected = waitForConnect(anchor);
    anchor.connect();
    await anchorConnected;
    const engineId = anchor.io.engine?.id;
    assert(engineId);
    assert(anchorServerSocket);
    assert.equal(anchorServerSocket.request.headers.authorization, undefined);

    const rejected = waitForConnectError(replaceable);
    replaceable.connect();
    const error = await rejected;
    assert.equal(error.data?.code, 'AUTHENTICATION_REQUIRED');
    assert.equal(anchor.io.engine?.id, engineId);
    assert.equal(anchorServerSocket.request.headers.authorization, undefined);
    assert.equal(await revalidateSocketAuthentication(anchorServerSocket), true);
    assert.equal(anchor.connected, true);

    replaceable.auth = { token: 'replacement-token' };
    const replacementConnected = waitForConnect(replaceable);
    replaceable.connect();
    await replacementConnected;
    assert.equal(anchor.io.engine?.id, engineId);
    assert.equal(anchorServerSocket.request.headers.authorization, undefined);
    assert.equal(await revalidateSocketAuthentication(anchorServerSocket), true);
    assert.equal(anchor.connected, true);
    assert.deepEqual(seenAuthorization, [
      'Bearer anchor-token',
      'Bearer rejected-token',
      'Bearer anchor-token',
      'Bearer replacement-token',
      'Bearer anchor-token',
    ]);
  } finally {
    anchor.disconnect();
    replaceable.disconnect();
    await io.close();
    await new Promise<void>(resolve => httpServer.close(() => resolve()));
  }
});
