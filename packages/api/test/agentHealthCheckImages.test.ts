import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { closeConnection, computeContentHash, generateAgentBundleImageTag, getAgentCliVersionMatrix, shutdownQueue, type AgentConfig, type AnalysisResult } from '@propr/core';
import { createAgentHealthCheck } from '../services/agentHealthCheck.js';

const config: AgentConfig = {
  id: 'codex', type: 'codex', alias: 'codex', enabled: true,
  configPath: '~/.codex', dockerImage: 'propr/agent:test',
  supportedModels: ['gpt-6-astra', 'gpt-6-luna'], defaultModel: 'gpt-6-astra',
};

after(async () => { await shutdownQueue(); await closeConnection(); });

test('absent exact image shares worker preparation and probes only after verified readiness', async () => {
  let ready = false;
  let finish!: () => void;
  let preparations = 0;
  let probes = 0;
  const check = createAgentHealthCheck({
    loadAgents: async () => [config, { ...config, id: 'sibling' }],
    imageExists: async image => { assert.equal(image, bundleImage([config])); return ready; },
    prepareImage: async image => { assert.equal(image, bundleImage([config])); preparations++; await new Promise<void>(resolve => { finish = resolve; }); },
    createAgent: () => ({ analyze: async () => { probes++; return { success: true, response: 'OK' }; } }),
  });
  const results = await Promise.all([check(config.id), check(config.id), check('sibling', true)]);
  assert.ok(results.every(result => result?.status === 'preparing'));
  assert.equal(preparations, 1);
  assert.equal(probes, 0);
  ready = true;
  finish();
  assert.equal((await check(config.id))?.status, 'ready');
  assert.equal(probes, 1);
});

test('failed preparation is safe and sticky until explicit retry, including wrong-image completion', async () => {
  for (const fails of [true, false]) {
    let preparations = 0;
    const check = createAgentHealthCheck({
      loadAgents: async () => [config],
      imageExists: async () => false,
      prepareImage: async () => { preparations++; if (fails) throw new Error('private.registry/secret manifest unknown'); },
      createAgent: () => { throw new Error('Must not probe absent image'); },
    });
    assert.equal((await check(config.id))?.status, 'preparing');
    await new Promise(resolve => setImmediate(resolve));
    const failed = await check(config.id);
    assert.equal(failed?.errorCode, 'preparation_failed');
    assert.ok(!failed?.error?.includes('private.registry'));
    await check(config.id);
    assert.equal(preparations, 1);
    assert.equal((await check(config.id, true))?.status, 'preparing');
    assert.equal(preparations, 2);
  }
});

test('preparation completion cannot mark edited, disabled or deleted configurations ready', async () => {
  for (const change of ['edit', 'disable', 'delete'] as const) {
    let configured = [config];
    let prepared = false;
    const images: string[] = [];
    const check = createAgentHealthCheck({
      loadAgents: async () => configured,
      imageExists: async image => image === bundleImage([config]) && prepared,
      prepareImage: async () => {},
      createAgent: agent => ({ analyze: async () => { images.push(agent.dockerImage); return { success: true, response: 'OK' }; } }),
    });
    assert.equal((await check(config.id))?.status, 'preparing');
    configured = change === 'delete' ? [] : [{ ...config, ...(change === 'disable' ? { enabled: false } : { cliVersionResolved: '9.9.9' }) }];
    prepared = true;
    assert.equal((await check(config.id))?.status, change === 'edit' ? 'preparing' : change === 'disable' ? 'disabled' : undefined);
    assert.deepEqual(images, []);
  }
});

test('all shared probe callers reload configuration before returning readiness', async () => {
  let configured = [config];
  let finish!: (result: AnalysisResult) => void;
  const check = createAgentHealthCheck({
    loadAgents: async () => configured,
    createAgent: () => ({ analyze: async () => new Promise(resolve => { finish = resolve; }) }),
  });
  const initial = check(config.id);
  const sibling = check(config.id);
  await new Promise(resolve => setImmediate(resolve));
  configured = [{ ...config, enabled: false }];
  finish({ success: true, response: 'OK' });
  assert.equal((await initial)?.status, 'disabled');
  assert.equal((await sibling)?.status, 'disabled');
});

function bundleImage(agents: AgentConfig[]): string {
  return generateAgentBundleImageTag(getAgentCliVersionMatrix(agents), computeContentHash());
}

test('stale persisted image A prepares and automatically probes the current bundle B', async () => {
  const currentImage = bundleImage([config]);
  assert.notEqual(currentImage, config.dockerImage);
  const available = new Set<string>();
  const prepared: string[] = [];
  const verified: string[] = [];
  const probed: string[] = [];
  let finish!: () => void;
  const check = createAgentHealthCheck({
    loadAgents: async () => [config],
    imageExists: async image => { verified.push(image); return available.has(image); },
    prepareImage: async image => {
      prepared.push(image);
      await new Promise<void>(resolve => { finish = resolve; });
      available.add(currentImage); // Worker resolves today's bundle, never persisted A.
    },
    createAgent: agent => ({ analyze: async () => {
      probed.push(agent.dockerImage);
      return { success: true, response: 'OK' };
    } }),
  });
  assert.equal((await check(config.id))?.status, 'preparing');
  assert.equal((await check(config.id))?.status, 'preparing');
  assert.deepEqual(prepared, [currentImage]);
  assert.deepEqual(probed, []);
  finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await check(config.id))?.status, 'ready');
  assert.deepEqual(probed, [currentImage]);
  assert.ok(verified.every(image => image === currentImage));
  assert.equal(config.dockerImage, 'propr/agent:test'); // Resolution never mutates saved config.
});

test('an existing stale image cannot bypass preparation of the effective bundle', async () => {
  const currentImage = bundleImage([config]);
  const prepared: string[] = [];
  const check = createAgentHealthCheck({
    loadAgents: async () => [config],
    imageExists: async image => image === config.dockerImage,
    prepareImage: async image => { prepared.push(image); },
    createAgent: () => { throw new Error('Must not probe stale image'); },
  });
  assert.equal((await check(config.id))?.status, 'preparing');
  assert.deepEqual(prepared, [currentImage]);
});

test('sibling CLI edits invalidate effective targets across inspection, preparation and shared probes', async () => {
  for (const boundary of ['inspection-ready', 'inspection-missing', 'preparation', 'probe'] as const) {
    const sibling: AgentConfig = { ...config, id: 'claude', type: 'claude' };
    let configured = [config, sibling];
    const oldImage = bundleImage(configured);
    const edited = [config, { ...sibling, cliVersionType: 'specific' as const, cliVersion: '9.9.9', cliVersionResolved: '9.9.9' }];
    const newImage = bundleImage(edited);
    assert.notEqual(newImage, oldImage);
    const available = new Set(boundary === 'preparation' || boundary === 'inspection-missing' ? [] : [oldImage]);
    const prepared: string[] = [];
    const probed: string[] = [];
    let finish!: () => void;
    let inspecting = true;
    const check = createAgentHealthCheck({
      loadAgents: async () => configured,
      imageExists: async image => {
        const exists = available.has(image);
        if (boundary.startsWith('inspection') && inspecting) {
          inspecting = false;
          configured = edited;
        }
        return exists;
      },
      prepareImage: async image => {
        prepared.push(image);
        if (boundary === 'preparation' && image === oldImage) {
          await new Promise<void>(resolve => { finish = resolve; });
          available.add(newImage); // Worker saw the edit before executing the request.
        } else available.add(image);
      },
      createAgent: agent => ({ analyze: async () => {
        probed.push(agent.dockerImage);
        if (boundary === 'probe' && agent.dockerImage === oldImage) {
          await new Promise<void>(resolve => { finish = resolve; });
        }
        return { success: true, response: 'OK' };
      } }),
    });
    if (boundary === 'probe') {
      const initial = check(config.id);
      const shared = check(config.id);
      await new Promise(resolve => setImmediate(resolve));
      configured = edited;
      finish();
      const results = await Promise.all([initial, shared]);
      assert.ok(results.every(result => result?.status === 'preparing' || result?.status === 'ready'));
    } else {
      assert.equal((await check(config.id))?.status, 'preparing');
      if (boundary === 'preparation') {
        configured = edited;
        finish();
      }
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await check(config.id))?.status, 'ready');
    assert.equal(probed.at(-1), newImage);
    if (boundary !== 'probe') assert.ok(!probed.includes(oldImage));
    assert.deepEqual(prepared, boundary === 'preparation' ? [oldImage] : [newImage]);
  }
});

test('probes run on the registry-resolved image and report an unavailable image without executing', async () => {
  const images: Array<string | undefined> = [];
  let resolved: { image?: string; error?: string } = { image: 'propr/runtime-agent:ready' };
  const check = createAgentHealthCheck({
    loadAgents: async () => [{ ...config, dockerImage: 'propr/agent:bundle-base' }],
    createAgent: agent => ({ analyze: async () => {
      images.push(agent.dockerImage);
      return { response: 'OK', success: true, modelUsed: 'gpt-6-luna', executionTimeMs: 1 } as AnalysisResult;
    } }),
    resolveExecutionImage: async () => resolved,
  });
  assert.equal((await check('codex'))?.status, 'ready');
  assert.deepEqual(images, ['propr/runtime-agent:ready']);

  resolved = { error: 'Agent image is being prepared by the worker. Check again in a few minutes.' };
  const result = await check('codex', true);
  assert.equal(result?.status, 'error');
  assert.match(result?.error ?? '', /being prepared/);
  assert.equal(images.length, 1);
});


test('health resolver verifies retained images through failed recovery, backoff and open circuits', async () => {
  const { resolveHealthCheckImage } = await import('../routes/agentRoutes.js');
  for (const failure of ['failed recovery', 'backoff', 'circuit', 'disk pressure']) {
    let guards = 0;
    let recoveries = 0;
    const registry = {
      isImageRecoveryPending: () => false,
      inspectAgentImageAvailability: async () => {},
      getAgentById: () => ({ config: { ...config, dockerImage: 'runtime:retained' } }),
      getOperationalStatus: () => ({ unifiedAgentImage: {
        status: 'unavailable', error: failure,
        operatorActionRequired: failure === 'disk pressure',
        circuitBreakerOpen: failure === 'circuit' || failure === 'disk pressure',
        nextRetryAt: new Date(Date.now() + 60_000).toISOString(),
      } }),
      ensureInitialized: async () => { guards++; },
      recoverImagesAndRefresh: async () => { recoveries++; },
    } as unknown as import('@propr/core').AgentRegistry;
    let inspected = '';
    const missing = await resolveHealthCheckImage(config, registry, async image => { inspected = image; return false; });
    assert.equal(inspected, 'runtime:retained');
    assert.equal(missing.image, undefined);
    assert.match(missing.error ?? '', failure === 'disk pressure' ? /cannot be prepared/ : /being prepared/);
    assert.equal(guards, 0);
    assert.equal(recoveries, 1);
    assert.deepEqual(await resolveHealthCheckImage(config, registry, async () => true), { image: 'runtime:retained' });
    assert.equal(guards, 1);
  }
});

test('health resolver returns during a pending rebuild and does not refresh unregistered agents per probe', async () => {
  const { resolveHealthCheckImage } = await import('../routes/agentRoutes.js');
  let pending = true;
  let inspections = 0;
  let recoveries = 0;
  const registry = {
    isImageRecoveryPending: () => pending,
    inspectAgentImageAvailability: async () => { inspections++; },
    getAgentById: () => undefined,
    getOperationalStatus: () => ({ unifiedAgentImage: { status: 'ready' } }),
    ensureInitialized: () => { throw new Error('Must not await initialization'); },
    refresh: () => { throw new Error('Must not refresh for an unregistered agent'); },
    recoverImagesAndRefresh: () => { recoveries++; return new Promise<void>(() => {}); },
  } as unknown as import('@propr/core').AgentRegistry;
  assert.match((await resolveHealthCheckImage(config, registry)).error ?? '', /being prepared/);
  assert.equal(inspections, 0);
  assert.equal(recoveries, 1);
  pending = false;
  for (let i = 0; i < 3; i++) {
    assert.match((await resolveHealthCheckImage(config, registry)).error ?? '', /not registered/);
  }
  assert.equal(recoveries, 1);
});


test('missing base prepares once while the merged resolver probes only a locally available retained runtime', async () => {
  const { resolveHealthCheckImage } = await import('../routes/agentRoutes.js');
  for (const runtimePresent of [true, false]) {
    const runtime = 'propr/runtime-agent:retained';
    const base = bundleImage([config]);
    const prepared: string[] = [];
    const probed: string[] = [];
    let finish!: () => void;
    const imageExists = async (image: string) => runtimePresent && image === runtime;
    const registry = {
      isImageRecoveryPending: () => true,
      getAgentById: () => ({ config: { ...config, dockerImage: runtime } }),
      getOperationalStatus: () => ({ unifiedAgentImage: { status: 'preparing' } }),
      ensureInitialized: async () => {},
      recoverImagesAndRefresh: async () => {},
    } as unknown as import('@propr/core').AgentRegistry;
    const check = createAgentHealthCheck({
      loadAgents: async () => [config, { ...config, id: 'sibling' }],
      imageExists,
      prepareImage: async image => {
        prepared.push(image);
        await new Promise<void>(resolve => { finish = resolve; });
        throw new Error('Base rebuild failed');
      },
      resolveExecutionImage: agent => resolveHealthCheckImage(agent, registry, imageExists),
      createAgent: agent => ({ analyze: async () => {
        assert.equal(await imageExists(agent.dockerImage), true);
        probed.push(agent.dockerImage);
        return { success: true, response: 'OK' };
      } }),
    });
    const results = await Promise.all([check(config.id), check(config.id), check('sibling')]);
    assert.ok(results.every(result => result?.status === (runtimePresent ? 'ready' : 'preparing')));
    await check(config.id);
    assert.deepEqual(prepared, [base]);
    assert.deepEqual(probed, runtimePresent ? [runtime, runtime, runtime] : []);
    finish();
    await new Promise(resolve => setImmediate(resolve));
    const afterFailure = await check(config.id);
    assert.equal(afterFailure?.status, runtimePresent ? 'ready' : 'error');
    assert.equal(afterFailure?.errorCode, runtimePresent ? undefined : 'preparation_failed');
    assert.deepEqual(prepared, [base]);
    if (!runtimePresent) assert.deepEqual(probed, []);
  }
});

test('resolved execution images must exist locally even when the base is available', async () => {
  for (const basePresent of [true, false]) {
    const check = createAgentHealthCheck({
      loadAgents: async () => [config],
      imageExists: async image => basePresent && image === bundleImage([config]),
      prepareImage: async () => new Promise<void>(() => {}),
      resolveExecutionImage: async () => ({ image: 'runtime:missing' }),
      createAgent: () => { throw new Error('Must not execute a missing runtime'); },
    });
    const result = await check(config.id);
    assert.equal(result?.status, basePresent ? 'error' : 'preparing');
    if (basePresent) assert.match(result?.error ?? '', /unavailable/);
  }
});

test('missing-base checks discard shared runtime results after configuration changes', async () => {
  for (const boundary of ['resolution', 'probe'] as const) {
    for (const change of ['edit', 'disable', 'delete'] as const) {
      // Missing runtimes have no probe, so exercise their asynchronous resolution.
      for (const runtimePresent of boundary === 'probe' ? [true] : [true, false]) {
        let configured = [config];
        let finish!: () => void;
        const prepared: string[] = [];
        const probedPaths: string[] = [];
        const edited: AgentConfig = { ...config, configPath: '/updated/credentials',
          cliVersionType: 'specific', cliVersion: '9.9.9', cliVersionResolved: '9.9.9' };
        const check = createAgentHealthCheck({
          loadAgents: async () => configured,
          imageExists: async image => image === 'runtime:retained' && runtimePresent,
          prepareImage: async image => { prepared.push(image); await new Promise<void>(() => {}); },
          resolveExecutionImage: async agent => {
            if (boundary === 'resolution' && agent.configPath === config.configPath) {
              await new Promise<void>(resolve => { finish = resolve; });
            }
            return runtimePresent ? { image: 'runtime:retained' } : { error: 'Runtime missing' };
          },
          createAgent: agent => ({ analyze: async () => {
            probedPaths.push(agent.configPath);
            if (boundary === 'probe' && agent.configPath === config.configPath) {
              await new Promise<void>(resolve => { finish = resolve; });
            }
            return { success: true, response: 'OK' };
          } }),
        });
        const initial = check(config.id);
        const shared = check(config.id);
        await new Promise(resolve => setImmediate(resolve));
        configured = change === 'delete' ? [] : [change === 'disable' ? { ...config, enabled: false } : edited];
        finish();
        const results = await Promise.all([initial, shared]);
        const expected = change === 'delete' ? undefined : change === 'disable' ? 'disabled' : runtimePresent ? 'ready' : 'preparing';
        assert.ok(results.every(result => result?.status === expected));
        assert.deepEqual(prepared, change === 'edit' ? [bundleImage([config]), bundleImage([edited])] : [bundleImage([config])]);
        if (change === 'edit' && runtimePresent) assert.equal(probedPaths.at(-1), edited.configPath);
        if (!runtimePresent) assert.deepEqual(probedPaths, []);
      }
    }
  }
});
