import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LocalLifecycleController } from './lifecycle';

describe('desktop local lifecycle presentation boundary', () => {
  it('keeps raw host diagnostics in main and returns only a fixed bounded status', async () => {
    const diagnostics: unknown[] = [];
    const controller = new LocalLifecycleController({
      async running() { throw new Error('docker /home/alice/stack/.env TOKEN=sentinel'); },
      async start() { throw new Error('HostConfig.Binds=/home/alice/stack'); },
      async stop() {},
    }, (_event, fields) => diagnostics.push(fields));
    const status = await controller.status();
    assert.equal(status.state, 'error');
    assert.ok((status.detail?.length ?? 0) < 160);
    assert.doesNotMatch(status.detail ?? '', /alice|HostConfig|TOKEN|sentinel/);
    await assert.rejects(controller.start(), error => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /alice|HostConfig|TOKEN|sentinel/);
      return true;
    });
    assert.equal(diagnostics.length, 2);
    assert.match(((diagnostics[0] as { error: Error }).error).message, /alice/);
    assert.match(((diagnostics[1] as { error: Error }).error).message, /HostConfig/);
  });
});
