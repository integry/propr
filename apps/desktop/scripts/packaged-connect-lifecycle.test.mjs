import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, test } from 'node:test';
import {
  CONNECT_READY_EVENT,
  isExactReadyRecord,
  preservePrimaryWithCleanup,
  removeAuthorizedConnectFixture,
  runPackagedConnectLifecycle,
} from './packaged-connect-lifecycle.mjs';

const expected = Object.freeze({
  platform: 'win32',
  arch: 'x64',
  authorityMechanism: 'inherited-standard-handle',
});

const readyRecord = (overrides = {}) => ({
  timestamp: '2026-09-01T22:00:00.000Z',
  level: 'info',
  event: CONNECT_READY_EVENT,
  selectedPlatform: expected.platform,
  selectedArch: expected.arch,
  authorityMechanism: expected.authorityMechanism,
  rendererSchemaValid: true,
  ...overrides,
});

class FakeChild extends EventEmitter {
  constructor(pid = 4242) {
    super();
    this.pid = pid;
    this.exitCode = null;
    this.signalCode = null;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
  }

  write(record, stream = this.stdout) {
    stream.write(typeof record === 'string' ? record : `${JSON.stringify(record)}\n`);
  }

  close(code = 0, signal = null) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.stdout.end();
    this.stderr.end();
    queueMicrotask(() => this.emit('close', code, signal));
  }

  kill() {
    this.close(null, 'SIGKILL');
    return true;
  }
}

const run = ({ app = new FakeChild(), onApp, onKiller, ...options } = {}) => {
  const invocations = [];
  const spawn = (file, args, spawnOptions) => {
    invocations.push({ file, args, options: spawnOptions });
    if (file === '/system/taskkill.exe') {
      const killer = new FakeChild(4343);
      queueMicrotask(() => onKiller?.(killer, app));
      return killer;
    }
    queueMicrotask(() => onApp?.(app));
    return app;
  };
  return runPackagedConnectLifecycle({
    binaryPath: '/package/propr-desktop.exe',
    args: ['--disable-gpu'],
    env: {},
    ...expected,
    sensitiveNeedles: ['secret-SENTINEL', '/private/path-SENTINEL'],
    treeKillerPath: '/system/taskkill.exe',
    spawn,
    readyTimeoutMs: 15,
    shutdownGraceMs: 5,
    terminationTimeoutMs: 5,
    streamDrainTimeoutMs: 5,
    ...options,
  }).then(result => ({ result, invocations }));
};

describe('packaged Connect bounded child lifecycle', () => {
  test('accepts an exact ready proof followed by a clean exit', async () => {
    const { result, invocations } = await run({
      onApp: app => {
        app.write(readyRecord());
        queueMicrotask(() => app.close(0, null));
      },
    });
    assert.deepEqual(result, {
      ok: true,
      category: 'ready-clean-exit',
      capture: 'complete',
      records: [{ event: CONNECT_READY_EVENT }],
    });
    assert.equal(invocations.length, 1);
  });

  test('forces a ready app with a hung descendant through an exact bounded taskkill invocation', async () => {
    const { result, invocations } = await run({
      onApp: app => app.write(readyRecord()),
      onKiller: (killer, app) => {
        app.close(null, 'SIGKILL');
        killer.close(0, null);
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.category, 'ready-forced-exit');
    assert.equal(invocations.length, 2);
    assert.deepEqual(invocations[1].args, ['/PID', '4242', '/T', '/F']);
    assert.equal(invocations[1].options.shell, false);
  });

  test('keeps timeout-before-ready primary while terminating and draining the tree', async () => {
    const { result } = await run({
      onKiller: (killer, app) => {
        app.close(null, 'SIGKILL');
        killer.close(0, null);
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.category, 'timeout-before-ready');
    assert.equal(result.secondary, undefined);
  });

  test('classifies asynchronous spawn errors without exposing their message', async () => {
    const app = new FakeChild(undefined);
    const { result } = await run({
      app,
      onApp: child => {
        child.emit('error', new Error('/private/path-SENTINEL secret-SENTINEL'));
        child.close(null, null);
      },
    });
    assert.equal(result.category, 'spawn-error');
    assert.doesNotMatch(JSON.stringify(result), /private|SENTINEL/u);
  });

  test('settles close/timeout races once and never upgrades an early exit to success', async () => {
    const { result } = await run({
      readyTimeoutMs: 0,
      onApp: app => app.close(0, null),
      onKiller: (killer, app) => {
        app.close(null, 'SIGKILL');
        killer.close(0, null);
      },
    });
    assert.ok(['timeout-before-ready', 'child-exit-before-ready'].includes(result.category));
    assert.equal(result.ok, false);
  });

  test('accepts a clean post-proof close racing a taskkill no-process result', async () => {
    const { result } = await run({
      onApp: app => app.write(readyRecord()),
      onKiller: (killer, app) => {
        app.close(0, null);
        killer.close(128, null);
      },
    });
    assert.deepEqual(result, {
      ok: true,
      category: 'ready-clean-exit',
      capture: 'complete',
      records: [{ event: CONNECT_READY_EVENT }],
    });
  });

  test('rejects malformed, partial, truncated, and extra-field ready records', async () => {
    assert.equal(isExactReadyRecord(readyRecord(), expected), true);
    for (const invalid of [
      readyRecord({ selectedArch: 'arm64' }),
      readyRecord({ rendererSchemaValid: 'true' }),
      readyRecord({ secret: 'secret-SENTINEL' }),
    ]) assert.equal(isExactReadyRecord(invalid, expected), false);

    const { result } = await run({
      onApp: app => {
        app.write(`${JSON.stringify(readyRecord()).slice(0, -2)}\n`);
        app.write(`${'x'.repeat(70 * 1024)}\n`);
        app.close(0, null);
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.category, 'child-exit-before-ready');
    assert.equal(result.capture, 'truncated');
  });

  test('terminates an exact-event record whose platform proof is invalid', async () => {
    const { result } = await run({
      onApp: app => app.write(readyRecord({ selectedPlatform: 'linux' })),
      onKiller: (killer, app) => {
        app.close(null, 'SIGKILL');
        killer.close(0, null);
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.category, 'ready-validation');
    assert.deepEqual(result.records, [{ event: CONNECT_READY_EVENT }]);
  });

  test('fails after proof when Windows tree termination cannot be proven', async () => {
    const { result } = await run({
      onApp: app => app.write(readyRecord()),
      onKiller: killer => killer.close(1, null),
    });
    assert.equal(result.ok, false);
    assert.equal(result.category, 'tree-termination');
    assert.deepEqual(result.secondary, ['tree-termination-failed']);
  });

  test('never returns secret-bearing raw output or non-allowlisted record fields', async () => {
    const { result } = await run({
      onApp: app => app.write(JSON.stringify({
        event: 'desktop.app.start_failed',
        error: { code: 'OPERATION_FAILED', message: '/private/path-SENTINEL secret-SENTINEL' },
      }) + '\n'),
      onKiller: (killer, app) => {
        app.close(null, 'SIGKILL');
        killer.close(0, null);
      },
    });
    assert.equal(result.category, 'output-rejected');
    assert.deepEqual(result.records, [{ event: 'desktop.app.start_failed', code: 'OPERATION_FAILED' }]);
    assert.doesNotMatch(JSON.stringify(result), /private|SENTINEL|message/u);
  });

  test('revokes success when sensitive output arrives after the exact ready proof', async () => {
    const { result } = await run({
      onApp: app => {
        app.write(readyRecord());
        queueMicrotask(() => {
          app.write('late secret-SENTINEL\n');
          app.close(0, null);
        });
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.category, 'output-rejected');
    assert.doesNotMatch(JSON.stringify(result), /SENTINEL/u);
  });
});

describe('packaged Connect fixture cleanup', () => {
  const fixture = '/canonical-temp/propr-desktop-connect-smoke-AbC123';
  const stats = { isDirectory: () => true, isSymbolicLink: () => false };
  const identityOptions = {
    fixture,
    canonicalTemporaryParent: '/canonical-temp',
    generatedLeaf: 'propr-desktop-connect-smoke-AbC123',
    platform: 'win32',
    retryBoundMs: 20,
    retryDelayMs: 1,
    lstatImpl: async () => stats,
    realpathImpl: async value => value,
  };

  test('retries a transient Windows EBUSY only inside the authorized fixture', async () => {
    let attempts = 0;
    const result = await removeAuthorizedConnectFixture({
      ...identityOptions,
      rmImpl: async removed => {
        assert.equal(removed, fixture);
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error('busy private path'), { code: 'EBUSY' });
      },
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(attempts, 2);
  });

  test('redacts cleanup failure and preserves the primary lifecycle outcome', async () => {
    const cleanup = await removeAuthorizedConnectFixture({
      ...identityOptions,
      retryBoundMs: 0,
      rmImpl: async () => { throw Object.assign(new Error('/private/path-SENTINEL'), { code: 'EBUSY' }); },
    });
    const combined = preservePrimaryWithCleanup({
      ok: false,
      category: 'timeout-before-ready',
      capture: 'complete',
      records: [],
    }, cleanup);
    assert.equal(combined.category, 'timeout-before-ready');
    assert.deepEqual(combined.secondary, ['fixture-cleanup-failed']);
    assert.doesNotMatch(JSON.stringify(combined), /private|SENTINEL/u);
  });

  test('refuses a link, renamed leaf, or fixture outside the canonical temporary parent', async () => {
    for (const options of [
      { fixture: '/elsewhere/propr-desktop-connect-smoke-AbC123' },
      { generatedLeaf: 'propr-desktop-connect-smoke-Different' },
      { lstatImpl: async () => ({ isDirectory: () => true, isSymbolicLink: () => true }) },
    ]) {
      let removed = false;
      const result = await removeAuthorizedConnectFixture({
        ...identityOptions,
        ...options,
        rmImpl: async () => { removed = true; },
      });
      assert.deepEqual(result, { ok: false, category: 'fixture-cleanup-authorization-failed' });
      assert.equal(removed, false);
    }
  });
});
