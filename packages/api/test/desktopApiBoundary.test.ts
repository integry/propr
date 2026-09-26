import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, describe, test } from 'node:test';
import express, { type RequestHandler } from 'express';
import { closeConnection } from '@propr/core';
import { registerDesktopApiBoundary, type DesktopApiBoundaryRoutes } from '../desktopApiBoundary.js';

after(async () => closeConnection());

const reached = (name: string): RequestHandler => (_req, res) => {
  res.status(204).set('X-ProPR-Route', name).end();
};

const publicRoutes: DesktopApiBoundaryRoutes = {
  discovery: reached('discovery'),
  startPairing: reached('start'),
  pollPairing: reached('poll'),
  activatePairing: reached('activate'),
  cancelPairing: reached('cancel'),
  openPairingApproval: reached('browser'),
  revokeCurrentToken: reached('revoke'),
};

const fetchFromApp = async (
  app: express.Express,
  path: string,
  init?: RequestInit,
): Promise<Response> => {
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>(resolve => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    return await fetch(`http://127.0.0.1:${port}${path}`, init);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  }
};

describe('assembled desktop API authentication boundary', () => {
  test('keeps discovery and bounded pairing bootstrap ahead of the operational API guard', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.isAuthenticated = () => false;
      next();
    });
    registerDesktopApiBoundary(app, publicRoutes);
    app.get('/api/status', (_req, res) => res.json({ operational: true }));

    for (const [method, path, expected] of [
      ['GET', '/api/desktop/discovery', 'discovery'],
      ['POST', '/api/desktop/pairings', 'start'],
      ['POST', '/api/desktop/pairings/dpr_AAAAAAAAAAAAAAAAAAAAAA/poll', 'poll'],
      ['POST', '/api/desktop/pairings/dpr_AAAAAAAAAAAAAAAAAAAAAA/activate', 'activate'],
      ['POST', '/api/desktop/pairings/dpr_AAAAAAAAAAAAAAAAAAAAAA/cancel', 'cancel'],
      ['GET', '/api/desktop/pairings/dpr_AAAAAAAAAAAAAAAAAAAAAA/browser', 'browser'],
    ] as const) {
      const response = await fetchFromApp(app, path, { method });
      assert.equal(response.status, 204, `${method} ${path}`);
      assert.equal(response.headers.get('x-propr-route'), expected, `${method} ${path}`);
    }

    const protectedResponse = await fetchFromApp(app, '/api/status');
    assert.equal(protectedResponse.status, 401);
    assert.deepEqual(await protectedResponse.json(), { error: 'Unauthorized' });
  });
});
