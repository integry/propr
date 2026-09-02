import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

describe('packaged transport smoke sequencing', () => {
  it('proves activation cleanup before credentialless reseed, rollback, and all-origin cleanup', () => {
    const smoke = readFileSync(
      fileURLToPath(new URL('./packaged-transport-smoke.ts', import.meta.url)),
      'utf8',
    );
    const initialSeed = smoke.indexOf('    await seedStorage();');
    const preactivationPresent = smoke.indexOf(
      'if (!await storageState(bothOriginsPresent))',
      initialSeed,
    );
    const firstActivation = smoke.indexOf('const first = await smoke.activate(', preactivationPresent);
    const staleSocketEvidence = smoke.indexOf(
      "log('desktop.transport_smoke.stale_socket_boundary'",
      firstActivation,
    );
    const activationCleanupSplit = smoke.indexOf(
      'if (!await storageState(activationCleanupSplit))',
      staleSocketEvidence,
    );
    const credentiallessReseed = smoke.indexOf('    await seedStorage();', activationCleanupSplit);
    const reseededPresent = smoke.indexOf(
      'if (!await storageState(bothOriginsPresent))',
      credentiallessReseed,
    );
    const rollback = smoke.indexOf(
      'const rollback = await profiles.readProfileCredential(profileId);',
      reseededPresent,
    );
    const rollbackPresent = smoke.indexOf(
      '|| !await storageState(bothOriginsPresent)',
      rollback,
    );
    const allOriginCleanup = smoke.indexOf('await clearDesktopInstanceCookies(', rollbackPresent);
    const absentBeforeCommit = smoke.indexOf(
      'precommitStorageCleared = await storageState(bothOriginsAbsent);',
      allOriginCleanup,
    );
    const absentAfterCommit = smoke.indexOf(
      '!await storageState(bothOriginsAbsent)',
      absentBeforeCommit,
    );

    assert.notEqual(initialSeed, -1);
    assert.ok(initialSeed < preactivationPresent && preactivationPresent < firstActivation);
    assert.ok(firstActivation < staleSocketEvidence && staleSocketEvidence < activationCleanupSplit);
    assert.ok(activationCleanupSplit < credentiallessReseed && credentiallessReseed < reseededPresent);
    assert.ok(reseededPresent < rollback && rollback < rollbackPresent);
    assert.ok(rollbackPresent < allOriginCleanup);
    assert.ok(allOriginCleanup < absentBeforeCommit && absentBeforeCommit < absentAfterCommit);
  });
});
