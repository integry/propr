import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, describe, test } from 'node:test';
import express, { type RequestHandler } from 'express';
import { closeConnection } from '@propr/core';
import {
  assertNoDuplicateRoutes,
  createManagementRouteEntries,
  createMemberCatalogRouteEntries,
  registerRouteEntries,
} from '../routeRegistry.js';

after(async () => closeConnection());

const terminalHandler: RequestHandler = (req, res) => {
  res.json({ method: req.method, path: req.path });
};

function handlerCollection(): never {
  return new Proxy({}, {
    get: () => terminalHandler,
  }) as never;
}

function createAuthorizationTestApp() {
  const app = express();
  app.use((req, _res, next) => {
    const admin = req.header('x-test-role') === 'admin';
    req.authorization = {
      role: admin ? 'admin' : 'member',
      permissions: admin
        ? [
            'instance.manage_agents',
            'instance.manage_members',
            'instance.manage_runtime',
            'instance.manage_settings',
          ]
        : [],
      source: admin ? 'local' : 'implicit',
    };
    next();
  });

  const routes = [
    ...createMemberCatalogRouteEntries({ instanceCatalogRoutes: handlerCollection() }),
    ...createManagementRouteEntries({
      adminRoutes: handlerCollection(),
      agentLoginRoutes: handlerCollection(),
      agentRuntimeRoutes: handlerCollection(),
      agentVersionRoutes: handlerCollection(),
      configRoutes: handlerCollection(),
    }),
  ];
  assertNoDuplicateRoutes(routes);
  registerRouteEntries(app, routes);
  return app;
}

async function withServer(
  callback: (origin: string) => Promise<void>
): Promise<void> {
  const server = createAuthorizationTestApp().listen(0, '127.0.0.1');
  try {
    await new Promise<void>(resolve => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  }
}

const managementRequests = [
  ['GET', '/api/config/settings'],
  ['GET', '/api/config/agents'],
  ['GET', '/api/admin/members'],
  ['GET', '/api/agent-runtime/packages'],
  ['GET', '/api/agents/codex/images'],
  ['POST', '/api/agents/codex/login-sessions'],
] as const;

describe('assembled instance permission routes', () => {
  test('members can read only the sanitized catalog endpoints', async () => {
    await withServer(async origin => {
      for (const path of ['/api/catalog', '/api/repositories/indexing-status']) {
        const response = await fetch(`${origin}${path}`);
        assert.equal(response.status, 200, path);
      }

      for (const [method, path] of managementRequests) {
        const response = await fetch(`${origin}${path}`, { method });
        assert.equal(response.status, 403, `${method} ${path}`);
        const body = await response.json() as { code: string; message: string };
        assert.equal(body.code, 'INSUFFICIENT_INSTANCE_PERMISSION');
        assert.match(body.message, /requires the instance\.manage_/);
      }
    });
  });

  test('administrators pass every management guard in the route matrix', async () => {
    await withServer(async origin => {
      for (const [method, path] of managementRequests) {
        const response = await fetch(`${origin}${path}`, {
          method,
          headers: { 'x-test-role': 'admin' },
        });
        assert.equal(response.status, 200, `${method} ${path}`);
      }
    });
  });
});
