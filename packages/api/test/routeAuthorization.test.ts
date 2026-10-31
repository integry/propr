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
import { createOperatorRequestRateLimiter } from '../requestRateLimits.js';
import { configureDemoMode, DEMO_VIEWER_PERMISSIONS, resetConfiguredDemoMode } from '../demoMode.js';
import { SUMMARY_TREE_ROUTE_PATH } from '../routes/summaryBrowserRoutes.js';

after(async () => closeConnection());

const terminalHandler: RequestHandler = (req, res) => {
  res.json({ method: req.method, path: req.path });
};

function handlerCollection(): never {
  return new Proxy({}, {
    get: () => terminalHandler,
  }) as never;
}

function createAuthorizationTestApp(operatorRateLimiter: RequestHandler = createOperatorRequestRateLimiter({ PROPR_OPERATOR_RATE_LIMIT_MAX: '1000' })) {
  const app = express();
  app.use((req, _res, next) => {
    const role = req.header('x-test-role');
    const admin = role === 'admin';
    const demo = role === 'demo';
    req.authorization = {
      role: admin ? 'admin' : 'member',
      permissions: admin
        ? [
            'instance.manage_agents',
            'instance.manage_members',
            'instance.manage_runtime',
            'instance.manage_settings',
          ]
        : demo ? [...DEMO_VIEWER_PERMISSIONS] : [],
      source: admin ? 'local' : demo ? 'demo' : 'implicit',
    };
    next();
  });

  const routes = [
    ...createMemberCatalogRouteEntries({ instanceCatalogRoutes: handlerCollection() }),
    ...createManagementRouteEntries({
      adminRoutes: handlerCollection(),
      adminMcpRoutes: handlerCollection(),
      agentLoginRoutes: handlerCollection(),
      agentRuntimeRoutes: handlerCollection(),
      agentVersionRoutes: handlerCollection(),
      configRoutes: handlerCollection(),
      followupHandoffRoutes: handlerCollection(),
      operatorRateLimiter,
      visualPreviewAuthRoutes: handlerCollection(),
    }),
  ];
  assertNoDuplicateRoutes(routes);
  registerRouteEntries(app, routes);
  return app;
}

async function withServer(
  callback: (origin: string) => Promise<void>,
  app = createAuthorizationTestApp(),
): Promise<void> {
  const server = app.listen(0, '127.0.0.1');
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
  ['GET', '/api/config/synthetic-agents'],
  ['POST', '/api/config/synthetic-agents'],
  ['GET', '/api/config/agent-tank/usage'],
  ['GET', '/api/config/agent-tank/history'],
  ['GET', '/api/admin/members'],
  ['GET', '/api/admin/followup-handoffs'],
  ['GET', '/api/admin/followup-handoffs/integry/propr/42'],
  ['POST', '/api/admin/followup-handoffs/integry/propr/42/resume'],
  ['POST', '/api/admin/followup-handoffs/integry/propr/42/release'],
  ['GET', '/api/config/preview-storage'],
  ['GET', '/api/config/visual-preview-auth'],
  ['POST', '/api/config/visual-preview-auth'],
  ['PUT', '/api/config/visual-preview-auth/token'],
  ['DELETE', '/api/config/visual-preview-auth'],
  ['GET', '/api/agent-runtime/packages'],
  ['POST', '/api/agent-runtime/packages/verify'],
  ['GET', '/api/agents/codex/images'],
  ['POST', '/api/agents/codex/login-sessions'],
] as const;

describe('assembled instance permission routes', () => {
  test('captures Express 5 named wildcard parameters as path segments', async () => {
    const app = express();
    app.get(SUMMARY_TREE_ROUTE_PATH, (req, res) => res.json(req.params));

    await withServer(async origin => {
      const response = await fetch(`${origin}/api/summaries/integry/propr/tree/src/routes/file.ts`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        owner: 'integry',
        repo: 'propr',
        path: ['src', 'routes', 'file.ts'],
      });
    }, app);
  });

  test('members can read only the sanitized catalog endpoints', async () => {
    await withServer(async origin => {
      for (const path of ['/api/catalog', '/api/instance/catalog', '/api/repositories/indexing-status']) {
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

  test('demo users can read only the synthetic Agent Tank usage feed', async () => {
    configureDemoMode(true);
    try {
      await withServer(async origin => {
        const headers = { 'x-test-role': 'demo' };
        const usageResponse = await fetch(`${origin}/api/config/agent-tank/usage`, { headers });
        assert.equal(usageResponse.status, 200);

        // History is real installation data, not the synthetic usage feed.
        for (const path of ['/api/config/agent-tank', '/api/config/agent-tank/status', '/api/config/agent-tank/history']) {
          const response = await fetch(`${origin}${path}`, { headers });
          assert.equal(response.status, 403, path);
        }
      });
    } finally {
      resetConfiguredDemoMode();
    }
  });

  test('every follow-up handoff operator route is rate limited after the admin guard', async () => {
    const followupHandoffRequests = managementRequests.filter(([, path]) => path.startsWith('/api/admin/followup-handoffs'));
    assert.equal(followupHandoffRequests.length, 4);
    const limit = followupHandoffRequests.length;
    const app = createAuthorizationTestApp(createOperatorRequestRateLimiter({
      PROPR_OPERATOR_RATE_LIMIT_MAX: String(limit),
      PROPR_OPERATOR_RATE_LIMIT_WINDOW_MS: '60000',
    }));

    await withServer(async origin => {
      const send = (method: string, path: string, role?: string) =>
        fetch(`${origin}${path}`, { method, headers: role ? { 'x-test-role': role } : {} });

      // Denied members never reach the limiter, so they neither see 429 nor drain the operator budget.
      for (let round = 0; round < 3; round += 1) {
        for (const [method, path] of followupHandoffRequests) {
          const denied = await send(method, path);
          assert.equal(denied.status, 403, `${method} ${path}`);
          assert.equal(denied.headers.get('ratelimit'), null, `${method} ${path}`);
          assert.equal((await denied.json() as { code: string }).code, 'INSUFFICIENT_INSTANCE_PERMISSION');
        }
      }

      // The full budget remains for administrators and is shared by all four routes.
      for (const [method, path] of followupHandoffRequests) {
        const allowed = await send(method, path, 'admin');
        assert.equal(allowed.status, 200, `${method} ${path}`);
        assert.match(allowed.headers.get('ratelimit') ?? '', /"operator-recovery"/, `${method} ${path}`);
      }
      for (const [method, path] of followupHandoffRequests) {
        const limited = await send(method, path, 'admin');
        assert.equal(limited.status, 429, `${method} ${path}`);
        assert.deepEqual(await limited.json(), {
          code: 'RATE_LIMIT_EXCEEDED',
          error: 'Too many requests. Please try again later.',
        });
      }

      // An exhausted budget does not mask authorization: members are still refused by the guard.
      for (const [method, path] of followupHandoffRequests) {
        assert.equal((await send(method, path)).status, 403, `${method} ${path}`);
      }
      // Other admin routes do not share the operator budget.
      assert.equal((await send('GET', '/api/admin/members', 'admin')).status, 200);
    }, app);
  });
});
