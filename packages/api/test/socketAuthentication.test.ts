import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, afterEach, describe, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Request, RequestHandler } from 'express';
import { Server as SocketIOServer } from 'socket.io';
import { io as createSocketClient, type Socket as ClientSocket } from 'socket.io-client';
import { closeConnection } from '@propr/core';
import type { GitHubUser } from '../authTypes.js';
import {
  authenticateSocketRequest,
  SocketAuthenticationError,
  type SocketAuthenticationDependencies,
  type SocketPrincipal,
} from '../auth.js';
import { configureSocketAuthentication } from '../services/socketAuthentication.js';

const originalBearerSetting = process.env.ENABLE_BEARER_AUTH;

after(async () => { await closeConnection(); });

afterEach(() => {
  if (originalBearerSetting === undefined) delete process.env.ENABLE_BEARER_AUTH;
  else process.env.ENABLE_BEARER_AUTH = originalBearerSetting;
});

function user(overrides: Partial<GitHubUser> = {}): GitHubUser {
  return {
    id: '42',
    login: 'octocat',
    username: 'octocat',
    displayName: 'Octocat',
    email: null,
    avatarUrl: null,
    ...overrides,
  };
}

function principal(githubUser = user()): SocketPrincipal {
  return {
    user: githubUser,
    authorization: { role: 'member', permissions: [], source: 'implicit' },
  };
}

function dependencies(overrides: Partial<SocketAuthenticationDependencies> = {}): SocketAuthenticationDependencies {
  return {
    validateToken: async () => user(),
    isWhitelisted: () => true,
    resolveInstanceAuthorization: async () => ({ role: 'member', permissions: [], source: 'implicit' }),
    refreshToken: async () => ({ status: 'not-needed' }),
    ...overrides,
  };
}

function request(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    isAuthenticated: () => false,
    ...overrides,
  } as Request;
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

describe('Socket.IO authentication', () => {
  test('rejects an anonymous handshake', async () => {
    await assert.rejects(
      authenticateSocketRequest(request(), dependencies()),
      (error: unknown) => error instanceof SocketAuthenticationError
        && error.code === 'AUTHENTICATION_REQUIRED',
    );
  });

  test('accepts a whitelisted bearer identity and resolves its instance role', async () => {
    const validated = user({ id: '99', username: 'allowed' });
    const result = await authenticateSocketRequest(
      request({ headers: { authorization: 'Bearer valid-token' } }),
      dependencies({
        validateToken: async token => token === 'valid-token' ? validated : null,
        isWhitelisted: username => username === 'allowed',
        resolveInstanceAuthorization: async () => ({ role: 'admin', permissions: [], source: 'durable' }),
      }),
    );

    assert.equal(result.user.id, '99');
    assert.equal(result.authorization.role, 'admin');
  });

  test('rejects a session user removed from the whitelist', async () => {
    const sessionUser = user({ username: 'removed' });
    await assert.rejects(
      authenticateSocketRequest(
        request({ isAuthenticated: () => true, user: sessionUser }),
        dependencies({ isWhitelisted: () => false }),
      ),
      (error: unknown) => error instanceof SocketAuthenticationError
        && error.code === 'USER_NOT_WHITELISTED',
    );
  });

  test('fails closed when an expired session cannot be refreshed', async () => {
    const sessionUser = user({ tokenExpiresAt: Date.now() - 1, refreshToken: 'refresh' });
    await assert.rejects(
      authenticateSocketRequest(
        request({ isAuthenticated: () => true, user: sessionUser }),
        dependencies({ refreshToken: async () => ({ status: 'temporarily-unavailable' }) }),
      ),
      (error: unknown) => error instanceof SocketAuthenticationError
        && error.code === 'GITHUB_TOKEN_REFRESH_UNAVAILABLE',
    );
  });

  test('does not accept bearer credentials when bearer auth is disabled', async () => {
    process.env.ENABLE_BEARER_AUTH = 'false';
    await assert.rejects(
      authenticateSocketRequest(
        request({ headers: { authorization: 'Bearer valid-token' } }),
        dependencies(),
      ),
      (error: unknown) => error instanceof SocketAuthenticationError
        && error.code === 'AUTHENTICATION_REQUIRED',
    );
  });

  test('runs Engine.IO middleware before the mandatory identity gate', async () => {
    const httpServer = createServer();
    const io = new SocketIOServer(httpServer, { transports: ['websocket'] });
    const markerMiddleware: RequestHandler = (req, _res, next) => {
      (req as Request & { socketMiddlewareRan?: boolean }).socketMiddlewareRan = true;
      next();
    };
    configureSocketAuthentication(io, {
      engineMiddleware: [markerMiddleware],
      authenticate: async req => {
        assert.equal((req as Request & { socketMiddlewareRan?: boolean }).socketMiddlewareRan, true);
        assert.equal(req.headers.authorization, 'Bearer test-token');
        return principal();
      },
    });

    let connectedPrincipal: SocketPrincipal | undefined;
    io.on('connection', socket => {
      connectedPrincipal = socket.data.principal as SocketPrincipal;
    });
    await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve));
    const port = (httpServer.address() as AddressInfo).port;
    const client = createSocketClient(`http://127.0.0.1:${port}`, {
      transports: ['websocket'],
      extraHeaders: { Authorization: 'Bearer test-token' },
      reconnection: false,
    });

    try {
      await waitForConnect(client);
      assert.equal(connectedPrincipal?.user.username, 'octocat');
    } finally {
      client.disconnect();
      await io.close();
      await new Promise<void>(resolve => httpServer.close(() => resolve()));
    }
  });

  test('surfaces a stable authentication error code to rejected clients', async () => {
    const httpServer = createServer();
    const io = new SocketIOServer(httpServer, { transports: ['websocket'] });
    configureSocketAuthentication(io, {
      engineMiddleware: [],
      authenticate: async () => {
        throw new SocketAuthenticationError('USER_NOT_WHITELISTED', 'not allowed');
      },
    });
    await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve));
    const port = (httpServer.address() as AddressInfo).port;
    const client = createSocketClient(`http://127.0.0.1:${port}`, {
      transports: ['websocket'],
      reconnection: false,
    });

    try {
      const error = await waitForConnectError(client);
      assert.equal(error.data?.code, 'USER_NOT_WHITELISTED');
    } finally {
      client.disconnect();
      await io.close();
      await new Promise<void>(resolve => httpServer.close(() => resolve()));
    }
  });
});
