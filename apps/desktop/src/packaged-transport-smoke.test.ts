import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

describe('packaged transport smoke sequencing', () => {
  it('proves same-host cookie cleanup before credentialless reseed, rollback, and all-origin cleanup', () => {
    const smoke = readFileSync(
      fileURLToPath(new URL('./packaged-transport-smoke.ts', import.meta.url)),
      'utf8',
    );
    const perStorageTypeModel = smoke.indexOf(
      "type OriginStorageExpectation = Readonly<Record<StorageType, StoragePresence>>;",
    );
    const perOriginStateSelection = smoke.indexOf(
      'const expectedState = expected[item.name];',
      perStorageTypeModel,
    );
    const cookieExpectation = smoke.indexOf(
      "const cookieExpectedPresent = expectedState.cookie === 'present';",
      perOriginStateSelection,
    );
    const exactSessionCookieInspection = smoke.indexOf(
      "cookie.name === 'packaged-smoke-cookie' && cookie.value === 'present'",
      cookieExpectation,
    );
    const originScopedTypeExpectation = smoke.indexOf(
      "rendererState[storageType] === (expectedState[storageType] === 'present')",
      exactSessionCookieInspection,
    );
    const allStoragePresentDefinition = smoke.indexOf(`  const allStoragePresent: OriginStorageExpectation = {
    cookie: 'present',
    localStorage: 'present',
    indexedDB: 'present',
    cacheStorage: 'present',
    serviceWorker: 'present',
  };`);
    const allStorageAbsentDefinition = smoke.indexOf(`  const allStorageAbsent: OriginStorageExpectation = {
    cookie: 'absent',
    localStorage: 'absent',
    indexedDB: 'absent',
    cacheStorage: 'absent',
    serviceWorker: 'absent',
  };`);
    const activationCleanupSplitDefinition = smoke.indexOf(`  const activationCleanupSplit: StorageExpectation = {
    first: allStorageAbsent,
    second: {
      cookie: 'absent',
      localStorage: 'present',
      indexedDB: 'present',
      cacheStorage: 'present',
      serviceWorker: 'present',
    },
  };`);
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

    assert.notEqual(perStorageTypeModel, -1);
    assert.notEqual(allStoragePresentDefinition, -1);
    assert.notEqual(allStorageAbsentDefinition, -1);
    assert.notEqual(activationCleanupSplitDefinition, -1);
    assert.ok(perStorageTypeModel < perOriginStateSelection);
    assert.ok(perOriginStateSelection < cookieExpectation);
    assert.ok(cookieExpectation < exactSessionCookieInspection);
    assert.ok(exactSessionCookieInspection < originScopedTypeExpectation);
    assert.ok(originScopedTypeExpectation < allStoragePresentDefinition);
    assert.ok(allStoragePresentDefinition < allStorageAbsentDefinition);
    assert.ok(allStorageAbsentDefinition < activationCleanupSplitDefinition);
    assert.ok(activationCleanupSplitDefinition < initialSeed);
    assert.ok(initialSeed < preactivationPresent && preactivationPresent < firstActivation);
    assert.ok(firstActivation < staleSocketEvidence && staleSocketEvidence < activationCleanupSplit);
    assert.ok(activationCleanupSplit < credentiallessReseed && credentiallessReseed < reseededPresent);
    assert.ok(reseededPresent < rollback && rollback < rollbackPresent);
    assert.ok(rollbackPresent < allOriginCleanup);
    assert.ok(allOriginCleanup < absentBeforeCommit && absentBeforeCommit < absentAfterCommit);
  });
});
