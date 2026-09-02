import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { lstat, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, test } from 'node:test';
import {
  CHILD_CAPTURE_MAX_BYTES,
  CONNECT_READY_EVENT,
  isExactReadyRecord,
  preservePrimaryWithCleanup,
  readPackagedConnectFailureMilestone,
  removeAuthorizedConnectFixture,
  runPackagedConnectLifecycle,
} from './packaged-connect-lifecycle.mjs';

const expected = Object.freeze({
  platform: 'win32',
  arch: 'x64',
  authorityMechanism: 'inherited-standard-handle',
});
const privateWindowsPath = String.raw`C:\Users\private-user\private-path-SENTINEL`;

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
    sensitiveNeedles: ['secret-SENTINEL', '/private/path-SENTINEL', privateWindowsPath],
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

  test('terminates but rejects a ready app that remains alive past the shutdown bound', async () => {
    const { result, invocations } = await run({
      onApp: app => app.write(readyRecord()),
      onKiller: (killer, app) => {
        app.close(null, 'SIGKILL');
        killer.close(0, null);
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.category, 'child-remained-alive');
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

  test('rejects a post-bound close racing a taskkill no-process result', async () => {
    const { result } = await run({
      onApp: app => app.write(readyRecord()),
      onKiller: (killer, app) => {
        app.close(0, null);
        killer.close(128, null);
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.category, 'tree-termination');
    assert.deepEqual(result.secondary, ['tree-termination-failed']);
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

  test('rejects duplicate exact READY records after a clean close', async () => {
    const { result } = await run({
      onApp: app => {
        app.write(readyRecord());
        app.write(readyRecord({ timestamp: '2026-09-01T22:00:01.000Z' }));
        queueMicrotask(() => app.close(0, null));
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.category, 'ready-duplicate');
    assert.deepEqual(result.records, [
      { event: CONNECT_READY_EVENT },
      { event: CONNECT_READY_EVENT },
    ]);
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

  test('rejects a JSON-escaped Windows path in a non-allowlisted record before readiness', async () => {
    const encoded = JSON.stringify({ event: 'untrusted.event', detail: { path: privateWindowsPath } });
    assert.equal(encoded.includes(privateWindowsPath), false);
    const { result } = await run({
      onApp: app => {
        app.write(`${encoded}\n`);
        app.write(readyRecord());
      },
      onKiller: (killer, app) => {
        app.close(null, 'SIGKILL');
        killer.close(0, null);
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.category, 'output-rejected');
    assert.deepEqual(result.records, [{ event: CONNECT_READY_EVENT }]);
    assert.doesNotMatch(JSON.stringify(result), /private-user|private-path-SENTINEL/u);
  });

  test('revokes success for a JSON-escaped Windows path after the exact ready proof', async () => {
    const { result } = await run({
      onApp: app => {
        app.write(readyRecord());
        queueMicrotask(() => {
          app.write({ event: 'untrusted.event', detail: { path: privateWindowsPath } });
          app.close(0, null);
        });
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.category, 'output-rejected');
    assert.deepEqual(result.records, [{ event: CONNECT_READY_EVENT }]);
    assert.doesNotMatch(JSON.stringify(result), /private-user|private-path-SENTINEL/u);
  });

  test('revokes success when a JSON-escaped Windows path follows the record-count cap', async () => {
    const encodedSensitiveRecord = JSON.stringify({
      event: 'untrusted.event', detail: { path: privateWindowsPath },
    });
    assert.equal(encodedSensitiveRecord.includes(privateWindowsPath), false);
    const { result } = await run({
      onApp: app => {
        app.write(readyRecord());
        queueMicrotask(() => {
          for (let index = 1; index < 128; index += 1) {
            app.write({ event: 'untrusted.event', index });
          }
          app.write(`${encodedSensitiveRecord}\n`);
          app.close(0, null);
        });
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.category, 'output-rejected');
    assert.equal(result.capture, 'truncated');
    assert.deepEqual(result.records, [{ event: CONNECT_READY_EVENT }]);
    assert.doesNotMatch(JSON.stringify(result), /private-user|private-path-SENTINEL/u);
  });

  test('revokes success when a JSON-escaped Windows path follows the byte cap', async () => {
    const encodedSensitiveRecord = JSON.stringify({
      event: 'untrusted.event', detail: { path: privateWindowsPath },
    });
    assert.equal(encodedSensitiveRecord.includes(privateWindowsPath), false);
    const benignRecord = `${JSON.stringify({
      event: 'untrusted.event', detail: 'x'.repeat(7 * 1024),
    })}\n`;
    const recordsToExceedBudget = Math.ceil(
      CHILD_CAPTURE_MAX_BYTES / Buffer.byteLength(benignRecord),
    ) + 1;
    const { result } = await run({
      onApp: app => {
        app.write(readyRecord());
        queueMicrotask(() => {
          app.write(benignRecord.repeat(recordsToExceedBudget));
          app.write(`${encodedSensitiveRecord}\n`);
          app.close(0, null);
        });
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.category, 'output-rejected');
    assert.equal(result.capture, 'truncated');
    assert.deepEqual(result.records, [{ event: CONNECT_READY_EVENT }]);
    assert.doesNotMatch(JSON.stringify(result), /private-user|private-path-SENTINEL/u);
  });
});

describe('packaged Connect fixed failure milestone attribution', () => {
  test('reads only the last allowlisted event-only milestone from bounded evidence', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'propr-connect-milestone-'));
    const evidence = join(directory, 'application.smoke-evidence.jsonl');
    try {
      await writeFile(evidence, [
        JSON.stringify({ event: 'desktop.app.ready' }),
        JSON.stringify({ event: 'desktop.renderer.ready' }),
        JSON.stringify({ event: 'desktop.renderer.connect_discovery.proof' }),
        JSON.stringify({ event: CONNECT_READY_EVENT, path: privateWindowsPath }),
        JSON.stringify({ event: 'untrusted.event' }),
        '',
      ].join('\n'));
      assert.equal(await readPackagedConnectFailureMilestone(evidence), 'connect-proof');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('reads diagnostics only after failed lifecycle termination and stream drain', async () => {
    let diagnosticReads = 0;
    const { result } = await run({
      onKiller: (killer, app) => {
        app.close(null, 'SIGKILL');
        killer.close(0, null);
      },
      readFailureMilestone: async () => {
        diagnosticReads += 1;
        return 'connect-proof';
      },
    });
    assert.equal(diagnosticReads, 1);
    assert.equal(result.category, 'timeout-before-ready');
    assert.deepEqual(result.records, [{ event: 'desktop.renderer.connect_discovery.proof' }]);
    assert.equal(Object.hasOwn(result, 'lastMilestone'), false);
  });

  test('does not read evidence after success or unproven tree termination', async () => {
    let diagnosticReads = 0;
    const readFailureMilestone = async () => {
      diagnosticReads += 1;
      return privateWindowsPath;
    };
    const success = await run({
      onApp: app => {
        app.write(readyRecord());
        queueMicrotask(() => app.close(0, null));
      },
      readFailureMilestone,
    });
    assert.equal(success.result.ok, true);
    const failedTermination = await run({
      onKiller: killer => killer.close(1, null),
      readFailureMilestone,
    });
    assert.equal(failedTermination.result.category, 'timeout-before-ready');
    assert.equal(diagnosticReads, 0);
    assert.equal(Object.hasOwn(failedTermination.result, 'lastMilestone'), false);
    assert.doesNotMatch(JSON.stringify(failedTermination.result), /private-user|SENTINEL/u);
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
  const settlesWithin = async (promise, milliseconds = 250) => {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error('cleanup exceeded its test bound')), milliseconds);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
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

  test('bounds a never-settling removal and preserves the primary result', async () => {
    const cleanup = await settlesWithin(removeAuthorizedConnectFixture({
      ...identityOptions,
      retryBoundMs: 10,
      rmImpl: () => new Promise(() => {}),
    }));
    assert.deepEqual(cleanup, { ok: false, category: 'fixture-cleanup-failed' });
    const primary = {
      ok: false,
      category: 'timeout-before-ready',
      capture: 'complete',
      records: [],
    };
    assert.deepEqual(preservePrimaryWithCleanup(primary, cleanup), {
      ...primary,
      secondary: ['fixture-cleanup-failed'],
    });
  });

  test('bounds a never-settling authorization call as a fixed cleanup failure', async () => {
    let removalAttempted = false;
    const cleanup = await settlesWithin(removeAuthorizedConnectFixture({
      ...identityOptions,
      retryBoundMs: 10,
      lstatImpl: () => new Promise(() => {}),
      rmImpl: async () => { removalAttempted = true; },
    }));
    assert.deepEqual(cleanup, { ok: false, category: 'fixture-cleanup-failed' });
    assert.equal(removalAttempted, false);
    const primary = { ok: false, category: 'spawn-error', capture: 'complete', records: [] };
    assert.deepEqual(preservePrimaryWithCleanup(primary, cleanup), {
      ...primary,
      secondary: ['fixture-cleanup-failed'],
    });
  });

  test('isolates default Windows filesystem cleanup from the harness process', async () => {
    const canonicalTemporaryParent = await realpath(tmpdir());
    const isolatedFixture = await mkdtemp(join(
      canonicalTemporaryParent, 'propr-desktop-connect-smoke-',
    ));
    try {
      const cleanup = await removeAuthorizedConnectFixture({
        fixture: isolatedFixture,
        canonicalTemporaryParent,
        platform: 'win32',
        retryBoundMs: 2_000,
      });
      assert.deepEqual(cleanup, { ok: true });
      await assert.rejects(lstat(isolatedFixture), { code: 'ENOENT' });
    } finally {
      await rm(isolatedFixture, { recursive: true, force: true });
    }
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
