import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPackagedAcceptanceSetup } from './acceptance-setup';
import type { DesktopSetupRequest } from './shared/contract';

test('setup fixture requires main-attested acceptance authorization, including for named scenarios', () => {
  for (const scenario of [undefined, 'default', 'setup-error', 'setup-complete']) {
    assert.equal(createPackagedAcceptanceSetup(false, scenario), null);
  }
});
test('setup fixture returns detached safe snapshots and deterministic action responses', async () => {
  const fixture = createPackagedAcceptanceSetup(true, 'setup-error')!;
  const snapshot = await fixture.localSetup.status();
  assert.equal(snapshot.phase, 'failed');
  assert.equal(snapshot.state?.steps[0].recoveryAction, 'replace-running-stack');
  snapshot.phase = 'completed';
  assert.equal((await fixture.localSetup.status()).phase, 'failed');
  assert.equal((await fixture.localSetup.retry()).phase, 'running');
  assert.equal((await fixture.localSetup.cancel()).phase, 'cancelled');
  await fixture.localSetup.retry({ sessionId: snapshot.sessionId, recoveryAction: 'replace-running-stack' });
  assert.deepEqual(fixture.evidence().calls, ['retry', 'cancel', 'replace-running-stack']);
  await assert.rejects(fixture.localSetup.selectPrivateKey(), /unavailable/);
  await assert.rejects(fixture.localSetup.acquireWebhookSecret(), /unavailable/);
  await assert.rejects(fixture.localSetup.resolveGithubInstallation({ action: 'install' }), /unavailable/);
});
test('idle can start without provisioning; completion only points to owned loopback fixture', async () => {
  const idle = createPackagedAcceptanceSetup(true, 'default')!;
  assert.equal((await idle.localSetup.status()).phase, 'idle');
  assert.equal((await idle.localSetup.start({} as DesktopSetupRequest)).phase, 'running');
  const complete = await createPackagedAcceptanceSetup(true, 'setup-complete')!.localSetup.status();
  assert.equal(complete.phase, 'completed');
  assert.equal(complete.profile?.baseUrl, 'http://127.0.0.2:41731');
});
