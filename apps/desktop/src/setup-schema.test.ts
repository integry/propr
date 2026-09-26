import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseDesktopSetupRequest } from './setup-schema';

const baseRequest = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  root: { mode: 'default' },
  reinitialize: false,
  agents: ['codex'],
  github: { mode: 'relay' },
  intake: { mode: 'routing_websocket' },
  whitelist: null,
  repository: null,
};

describe('desktop setup request mode policy', () => {
  it('accepts ProPR Connect only with routing WebSocket intake', () => {
    assert.deepEqual(parseDesktopSetupRequest(baseRequest), baseRequest);

    for (const intake of [
      { mode: 'keep' },
      { mode: 'polling' },
      { mode: 'direct_webhook', secretCapability: 'webhook-secret-capability-12345678' },
    ]) {
      assert.throws(
        () => parseDesktopSetupRequest({ ...baseRequest, intake }),
        /ProPR Connect requires WebSocket intake/,
      );
    }
  });

  it('rejects desktop Demo requests at the IPC trust boundary', () => {
    assert.throws(
      () => parseDesktopSetupRequest({ ...baseRequest, github: { mode: 'demo' }, intake: { mode: 'keep' } }),
      /Invalid GitHub configuration/,
    );
  });

  it('preserves supported Custom GitHub App intake modes', () => {
    const github = {
      mode: 'app', appId: '123', installationId: '456',
      privateKeyCapability: 'private-key-capability-123456789012',
    };
    for (const intake of [
      { mode: 'keep' },
      { mode: 'polling' },
      { mode: 'direct_webhook', secretCapability: 'webhook-secret-capability-12345678' },
    ]) {
      assert.doesNotThrow(() => parseDesktopSetupRequest({ ...baseRequest, github, intake }));
    }
    assert.throws(
      () => parseDesktopSetupRequest({ ...baseRequest, github, intake: { mode: 'routing_websocket' } }),
      /Incompatible GitHub intake mode/,
    );
  });
});
