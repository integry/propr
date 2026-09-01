import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AcceptanceSetupController } from './acceptance-setup-controller';

const requestFor = (sessionId: string) => ({
  sessionId,
  root: { mode: 'default' as const },
  reinitialize: false,
  agents: ['codex'],
  github: { mode: 'demo' as const },
  intake: { mode: 'keep' as const },
  whitelist: null,
  repository: null,
});

describe('packaged acceptance setup fixture', () => {
  it('publishes deterministic progress through the production setup shape', async () => {
    const published: string[] = [];
    const controller = new AcceptanceSetupController({
      rootDir: '/tmp/private/local-stack',
      emit: snapshot => published.push(snapshot.phase),
    });
    const initial = await controller.status();
    const running = await controller.start(requestFor(initial.sessionId));
    assert.equal(running.phase, 'running');
    assert.equal(running.state?.steps.find(step => step.id === 'pull-images')?.status, 'active');
    assert.deepEqual(published, ['running']);
    await controller.shutdown();
  });

  it('provides fixed recovery and completion cold-start evidence without secrets', async () => {
    const recovery = await new AcceptanceSetupController({
      rootDir: '/tmp/private/local-stack', scenario: 'setup-error', emit: () => undefined,
    }).status();
    const completion = await new AcceptanceSetupController({
      rootDir: '/tmp/private/local-stack', scenario: 'setup-complete', emit: () => undefined,
    }).status();
    assert.equal(recovery.phase, 'failed');
    assert.match(recovery.errors?.[0]?.nextAction ?? '', /Start Docker Engine/);
    assert.equal(completion.phase, 'completed');
    assert.equal(completion.profile?.name, 'This computer');
    assert.doesNotMatch(JSON.stringify({ recovery, completion }), /token|password|secret/i);
  });
});
