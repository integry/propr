import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { handleDeepLinkDeliveryFailure } from './deep-link-failure-policy';

describe('desktop deep-link failure policy', () => {
  const exercise = (nativeArtifactSmoke: boolean) => {
    const exits: number[] = [];
    const logs: Array<{ event: string; fields: Readonly<Record<string, string>> }> = [];
    handleDeepLinkDeliveryFailure(nativeArtifactSmoke, {
      exit: code => { exits.push(code); },
      log: (_level, event, fields) => { logs.push({ event, fields }); },
    });
    return { exits, logs };
  };

  it('is fatal when native artifact smoke loses renderer acknowledgement', () => {
    const result = exercise(true);
    assert.deepEqual(result.exits, [1]);
    assert.deepEqual(result.logs, [
      {
        event: 'desktop.deeplink.delivery_failed',
        fields: { failure: 'renderer_acknowledgement' },
      },
      {
        event: 'desktop.app.start_failed',
        fields: { failure: 'renderer_acknowledgement' },
      },
    ]);
  });

  it('logs a fixed non-secret diagnostic without exiting normal production', () => {
    const result = exercise(false);
    assert.deepEqual(result.exits, []);
    assert.deepEqual(result.logs, [{
      event: 'desktop.deeplink.delivery_failed',
      fields: { failure: 'renderer_acknowledgement' },
    }]);
    assert.equal(JSON.stringify(result), JSON.stringify(result).slice(0, 512));
  });

  it('does not crash or exit production when the diagnostic sink fails', () => {
    const exits: number[] = [];
    assert.doesNotThrow(() => handleDeepLinkDeliveryFailure(false, {
      exit: code => { exits.push(code); },
      log: () => { throw new Error('secret-bearing logger failure'); },
    }));
    assert.deepEqual(exits, []);
  });
});
