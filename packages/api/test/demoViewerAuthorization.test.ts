import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, afterEach, describe, test } from 'node:test';
import express, { type Request, type RequestHandler } from 'express';
import { closeConnection } from '@propr/core';
import { DEMO_MODE_READ_ONLY_CODE, INSTANCE_PERMISSIONS } from '@propr/shared';
import { authenticatedUserResponse, hasPermission, resolveInstanceAuthorization } from '../authorization.js';
import {
  configureDemoMode,
  demoModeReadOnlyMiddleware,
  getDemoUser,
  resetConfiguredDemoMode,
} from '../demoMode.js';
import { DEMO_LIVE_DATA_UNAVAILABLE_CODE } from '../permissionGuards.js';
import { DEMO_VIEWER_MANAGEMENT_READS } from '../demoViewerRoutes.js';
import { createRequestRateLimiter } from '../requestRateLimits.js';
import { createExtensionProfileRoutes } from '../routes/extensionProfileRoutes.js';
import { createManagementRouteEntries, registerRouteEntries, type RouteEntry } from '../routeRegistry.js';

after(async () => closeConnection());
afterEach(() => resetConfiguredDemoMode());

const terminalHandler: RequestHandler = (req, res) => {
  res.json({ method: req.method, path: req.path });
};

function handlerCollection(): never {
  return new Proxy({}, { get: () => terminalHandler }) as never;
}

function managementRoutes(): RouteEntry[] {
  return createManagementRouteEntries({
    adminRoutes: handlerCollection(),
    adminMcpRoutes: handlerCollection(),
    agentLoginRoutes: handlerCollection(),
    agentRuntimeRoutes: handlerCollection(),
    agentVersionRoutes: handlerCollection(),
    configRoutes: handlerCollection(),
    followupHandoffRoutes: handlerCollection(),
    operatorRateLimiter: (_req, _res, next) => next(),
    visualPreviewAuthRoutes: handlerCollection(),
  });
}

/** Every fixture app is rate limited first, as server.ts limits /api before authorization. */
function rateLimitedApp() {
  const app = express();
  app.use(createRequestRateLimiter({ identifier: 'demo-viewer-test-fixture', limit: 1000, windowMs: 60_000 }));
  return app;
}

/** The demo request path as server.ts assembles it: write barrier, demo identity, then the routes. */
function createDemoApp(options: { writeBarrier: boolean }) {
  const app = rateLimitedApp();
  if (options.writeBarrier) app.use('/api', demoModeReadOnlyMiddleware);
  app.use(async (req, _res, next) => {
    req.user = getDemoUser();
    req.authorization = await resolveInstanceAuthorization(req.user);
    next();
  });
  registerRouteEntries(app, managementRoutes());
  return app;
}

async function withServer(app: express.Express, callback: (origin: string) => Promise<void>): Promise<void> {
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>(resolve => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

const concretePath = (path: string) => path.replace(/:[A-Za-z]+/g, 'demo');

describe('demo viewer authorization', () => {
  test('the demo identity is a read-only viewer of every instance permission', async () => {
    configureDemoMode(true);
    const user = getDemoUser();
    const authorization = await resolveInstanceAuthorization(user);

    assert.deepEqual(authorization, { role: 'member', permissions: [...INSTANCE_PERMISSIONS], source: 'demo' });
    assert.deepEqual(authenticatedUserResponse(user, authorization).permissions, [...INSTANCE_PERMISSIONS]);
  });

  test('viewer permissions grant reads only, and only while demo mode is on', () => {
    const authorization = { role: 'member' as const, permissions: [...INSTANCE_PERMISSIONS], source: 'demo' as const };
    const request = (method: string) => ({ method, authorization }) as Request;

    configureDemoMode(true);
    for (const permission of INSTANCE_PERMISSIONS) {
      assert.equal(hasPermission(request('GET'), permission), true, permission);
      assert.equal(hasPermission(request('HEAD'), permission), true, permission);
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        assert.equal(hasPermission(request(method), permission), false, `${method} ${permission}`);
      }
    }

    configureDemoMode(false);
    for (const permission of INSTANCE_PERMISSIONS) {
      assert.equal(hasPermission(request('GET'), permission), false, permission);
    }
  });

  test('every demo-readable management read is a registered GET route', () => {
    const registered = new Set(managementRoutes().map(([method, path]) => `${method} ${path}`));
    for (const route of DEMO_VIEWER_MANAGEMENT_READS) assert.ok(registered.has(route), route);
  });

  test('demo reads the curated management views, not live installation state, and every write is refused', async () => {
    configureDemoMode(true);
    await withServer(createDemoApp({ writeBarrier: true }), async origin => {
      for (const [method, path] of managementRoutes()) {
        const response = await fetch(`${origin}${concretePath(path)}`, { method: method.toUpperCase() });
        const body = await response.json() as { code?: string };
        const label = `${method} ${path}`;
        if (method !== 'get') {
          assert.equal(response.status, 405, label);
          assert.equal(body.code, DEMO_MODE_READ_ONLY_CODE, label);
        } else if (DEMO_VIEWER_MANAGEMENT_READS.has(`${method} ${path}`)) {
          assert.equal(response.status, 200, label);
        } else {
          assert.equal(response.status, 403, label);
          assert.equal(body.code, DEMO_LIVE_DATA_UNAVAILABLE_CODE, label);
        }
      }
    });
  });

  test('viewer permissions do not authorize a write even if it passes the write barrier', async () => {
    configureDemoMode(true);
    await withServer(createDemoApp({ writeBarrier: false }), async origin => {
      for (const [method, path] of managementRoutes().filter(([method]) => method !== 'get')) {
        const response = await fetch(`${origin}${concretePath(path)}`, { method: method.toUpperCase() });
        assert.equal(response.status, 403, `${method} ${path}`);
        assert.equal((await response.json() as { code: string }).code, 'INSUFFICIENT_INSTANCE_PERMISSION');
      }
    });
  });

  test('a demo-shaped authorization unlocks nothing with demo mode off', async () => {
    configureDemoMode(false);
    const app = rateLimitedApp();
    app.use((req, _res, next) => {
      req.user = getDemoUser();
      req.authorization = { role: 'member', permissions: [...INSTANCE_PERMISSIONS], source: 'demo' };
      next();
    });
    registerRouteEntries(app, managementRoutes());
    await withServer(app, async origin => {
      for (const [method, path] of managementRoutes()) {
        const response = await fetch(`${origin}${concretePath(path)}`, { method: method.toUpperCase() });
        assert.equal(response.status, 403, `${method} ${path}`);
        assert.equal((await response.json() as { code: string }).code, 'INSUFFICIENT_INSTANCE_PERMISSION');
      }
    });
  });

  test('extension profiles, which hold sealed secrets, are explained rather than read by the demo', async () => {
    configureDemoMode(true);
    const store = new Proxy({}, { get: () => () => { throw new Error('demo must not read extension profiles'); } });
    const routes = createExtensionProfileRoutes(store as never);
    const app = rateLimitedApp();
    app.use((req, _res, next) => {
      req.user = getDemoUser();
      req.authorization = { role: 'member', permissions: [...INSTANCE_PERMISSIONS], source: 'demo' };
      next();
    });
    app.get('/api/instance/extensions/v1', routes.list);
    await withServer(app, async origin => {
      const response = await fetch(`${origin}/api/instance/extensions/v1`);
      assert.equal(response.status, 403);
      assert.equal((await response.json() as { code: string }).code, DEMO_LIVE_DATA_UNAVAILABLE_CODE);
    });
  });
});
