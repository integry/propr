import { afterEach, describe, expect, it, vi } from 'vitest';
import { getSystemStatus } from './proprApi';

describe('getSystemStatus', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('maps dynamic agents and indexing status from /api/status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        daemon: 'running',
        redis: 'connected',
        workerCount: 2,
        githubAuth: 'connected',
        claudeAuth: 'disconnected',
        indexing: 'active',
        githubEventIntake: 'routing_websocket',
        githubEventIntakeStatus: 'connected',
        agents: [
          { id: 'codex-1', type: 'codex', alias: 'codex-prod', status: 'connected' },
          { id: 'antigravity-1', type: 'antigravity', alias: 'antigravity-prod', status: 'disconnected' },
        ],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await expect(getSystemStatus()).resolves.toMatchObject({
      daemon: 'Running',
      workers: [{ id: 1, status: 'active' }, { id: 2, status: 'active' }],
      redis: 'Connected',
      githubAuth: 'Authenticated',
      claudeAuth: 'Failed',
      indexing: 'Active',
      githubEventIntake: 'ProPR Connect',
      githubEventIntakeStatus: 'Connected',
      agents: [
        { id: 'codex-1', type: 'codex', alias: 'codex-prod', status: 'Ready' },
        { id: 'antigravity-1', type: 'antigravity', alias: 'antigravity-prod', status: 'Failed' },
      ],
    });
  });

  it('maps each intake mode to a human-readable label and status', async () => {
    const cases: Array<[string, string, string, string]> = [
      ['routing_websocket', 'connected', 'ProPR Connect', 'Connected'],
      ['polling', 'active', 'Polling', 'Active'],
      ['direct_webhook', 'disconnected', 'Direct Webhook', 'Disconnected'],
      ['unknown', 'unknown', 'Unknown', 'Unknown'],
    ];

    for (const [mode, status, expectedLabel, expectedStatus] of cases) {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({
          daemon: 'running',
          redis: 'connected',
          workerCount: 1,
          githubAuth: 'connected',
          claudeAuth: 'connected',
          githubEventIntake: mode,
          githubEventIntakeStatus: status,
          agents: [],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      await expect(getSystemStatus()).resolves.toMatchObject({
        githubEventIntake: expectedLabel,
        githubEventIntakeStatus: expectedStatus,
      });
      vi.restoreAllMocks();
    }
  });

  it('keeps older status responses compatible', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        daemon: 'running',
        redis: 'connected',
        workerCount: 1,
        githubAuth: 'connected',
        claudeAuth: 'connected',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await expect(getSystemStatus()).resolves.toMatchObject({
      indexing: 'Unavailable',
      agents: [],
      claudeAuth: 'Authenticated',
      // Older backends omit the intake fields entirely; they fall back to Unknown.
      githubEventIntake: 'Unknown',
      githubEventIntakeStatus: 'Unknown',
    });
  });

  it('maps a valid connected Connect account and drops malformed or non-Connect data', async () => {
    const account = {
      installationId: 42,
      accountLogin: 'octo-org',
      plan: 'community',
      hasPlusAccess: false,
      activeSeats: 2,
      allowedSeats: 3,
      seatsRemaining: 1,
      billingCycleResetAt: '2026-09-01T00:00:00.000Z',
      sentAt: '2026-08-14T09:31:07.000Z',
    };
    for (const [mode, status, connectAccount, expected] of [
      ['routing_websocket', 'connected', account, account],
      ['routing_websocket', 'connected', { ...account, allowedSeats: 'three' }, undefined],
      ['polling', 'active', account, undefined],
      ['routing_websocket', 'disconnected', account, undefined],
    ] as const) {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
        daemon: 'running', redis: 'connected', workerCount: 1,
        githubAuth: 'connected', claudeAuth: 'connected', agents: [],
        githubEventIntake: mode,
        githubEventIntakeStatus: status,
        connectAccount,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

      expect((await getSystemStatus()).connectAccount).toEqual(expected);
      vi.restoreAllMocks();
    }
  });

  it('maps disconnected indexing explicitly to unavailable', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        daemon: 'running',
        redis: 'connected',
        workerCount: 1,
        githubAuth: 'connected',
        claudeAuth: 'connected',
        indexing: 'disconnected',
        agents: [],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await expect(getSystemStatus()).resolves.toMatchObject({
      indexing: 'Unavailable',
      agents: [],
    });
  });
});
