import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

describe('packaged transport smoke sequencing', () => {
  it('seeds adversarial origin storage before the first renderer credential binding', () => {
    const smoke = readFileSync(
      fileURLToPath(new URL('./packaged-transport-smoke.ts', import.meta.url)),
      'utf8',
    );
    const seedStorage = smoke.indexOf('    await seedStorage();');
    const seededState = smoke.indexOf("if (!await storageState('present'))", seedStorage);
    const firstActivation = smoke.indexOf('const first = await smoke.activate(', seededState);
    const staleSocketEvidence = smoke.indexOf(
      "log('desktop.transport_smoke.stale_socket_boundary'",
      firstActivation,
    );
    const retainedState = smoke.indexOf("if (!await storageState('present'))", staleSocketEvidence);
    const allOriginCleanup = smoke.indexOf('await clearDesktopInstanceCookies(', retainedState);

    assert.notEqual(seedStorage, -1);
    assert.equal(smoke.match(/^    await seedStorage\(\);$/gm)?.length, 1);
    assert.ok(seedStorage < seededState && seededState < firstActivation);
    assert.ok(firstActivation < staleSocketEvidence && staleSocketEvidence < retainedState);
    assert.ok(retainedState < allOriginCleanup);
  });
});
