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
      githubEventIntake: 'Routing WebSocket',
      githubEventIntakeStatus: 'Connected',
      agents: [
        { id: 'codex-1', type: 'codex', alias: 'codex-prod', status: 'Ready' },
        { id: 'antigravity-1', type: 'antigravity', alias: 'antigravity-prod', status: 'Failed' },
      ],
    });
  });

  it('maps each intake mode to a human-readable label and status', async () => {
    const cases: Array<[string, string, string, string]> = [
      ['routing_websocket', 'connected', 'Routing WebSocket', 'Connected'],
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
