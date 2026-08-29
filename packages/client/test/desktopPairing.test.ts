import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PROPR_API_COMPATIBILITY, PROPR_UI_COMPATIBILITY } from '@propr/shared';
import { ProprClient, ProprClientError } from '../src/index.js';

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const discovery = {
  product: 'ProPR',
  version: '0.8.15',
  apiCompatibility: PROPR_API_COMPATIBILITY,
  uiCompatibility: PROPR_UI_COMPATIBILITY,
  desktopAuthentication: {
    protocolVersion: 1 as const,
    browserPairing: true,
    instanceBearerTokens: true,
    socketIoBearerAuthentication: true,
  },
};

describe('desktop instance protocol', () => {
  it('discovers capabilities, opens approval, and polls to a single opaque token', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    let polls = 0;
    const client = new ProprClient({
      baseUrl: 'https://propr.example.test',
      authentication: { type: 'none' },
      fetch: async (input, init) => {
        const url = input.toString();
        requests.push({ url, init });
        if (url.endsWith('/api/desktop/discovery')) return json(discovery);
        if (url.endsWith('/api/desktop/pairings')) return json({
          pairingId: `dpr_${'A'.repeat(22)}`,
          deviceSecret: 'B'.repeat(43),
          approvalUrl: `https://propr.example.test/api/desktop/pairings/dpr_${'A'.repeat(22)}/browser`,
          expiresAt: '2030-01-01T00:00:00.000Z',
          interval: 2,
        }, 201);
        polls += 1;
        return polls === 1
          ? json({ status: 'pending', interval: 3 }, 202)
          : json({ status: 'complete', token: `propr_it_${'C'.repeat(43)}`, tokenType: 'Bearer', expiresAt: null });
      },
    });

    const metadata = await client.discoverDesktop();
    assert.equal(metadata.compatibility.compatible, true);
    assert.equal(metadata.desktopAuthentication.browserPairing, true);

    const opened: string[] = [];
    const sleeps: number[] = [];
    const complete = await client.pairDesktop('Test desktop', {
      now: () => Date.parse('2029-01-01T00:00:00.000Z'),
      sleep: async milliseconds => { sleeps.push(milliseconds); },
      onApprovalRequired: url => { opened.push(url); },
    });

    assert.deepEqual(complete, { token: `propr_it_${'C'.repeat(43)}`, tokenType: 'Bearer', expiresAt: null });
    assert.deepEqual(opened, [`https://propr.example.test/api/desktop/pairings/dpr_${'A'.repeat(22)}/browser`]);
    assert.deepEqual(sleeps, [2000, 3000]);
    assert.equal(requests.every(request => !request.url.includes('B'.repeat(43))), true);
    assert.equal(requests.filter(request => request.url.endsWith('/poll')).every(request =>
      String(request.init?.body).includes('B'.repeat(43))), true);
  });

  it('cancels and expires without another poll request', async () => {
    const client = new ProprClient({ fetch: async () => { throw new Error('must not request'); } });
    const start = {
      pairingId: `dpr_${'A'.repeat(22)}`,
      deviceSecret: 'B'.repeat(43),
      approvalUrl: 'https://propr.example.test/approve',
      expiresAt: '2026-01-01T00:00:00.000Z',
      interval: 1,
    };
    await assert.rejects(
      // Importing through the client keeps the public helper covered separately
      // from the start endpoint.
      import('../src/index.js').then(({ completeDesktopPairing }) => completeDesktopPairing(client, start, {
        now: () => Date.parse('2026-01-01T00:00:00.000Z'),
      })),
      (error: unknown) => error instanceof ProprClientError && error.code === 'PAIRING_EXPIRED',
    );

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      import('../src/index.js').then(({ completeDesktopPairing }) => completeDesktopPairing(client, {
        ...start,
        expiresAt: '2030-01-01T00:00:00.000Z',
      }, { signal: controller.signal })),
      (error: unknown) => error instanceof ProprClientError && error.kind === 'aborted',
    );
  });

  it('rejects an unsafe approval URL', async () => {
    const client = new ProprClient({
      fetch: async () => json({
        pairingId: `dpr_${'A'.repeat(22)}`,
        deviceSecret: 'B'.repeat(43),
        approvalUrl: 'http://remote.example.test/approve',
        expiresAt: '2030-01-01T00:00:00.000Z',
        interval: 2,
      }, 201),
    });
    await assert.rejects(client.startDesktopPairing('Desktop'), (error: unknown) =>
      error instanceof ProprClientError && error.kind === 'invalid_response');
  });
});
