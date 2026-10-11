import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { configureNativeShutdownDiagnostics } from './native-shutdown-diagnostics';
import { createDesktopShutdownCoordinator } from './shutdown';

const fixture = () => {
  const temporary = mkdtempSync(join(tmpdir(), 'propr-crash-test-'));
  const root = join(temporary, 'evidence');
  const profile = join(temporary, 'propr-desktop-smoke-fixture');
  mkdirSync(root, { mode: 0o700 });
  mkdirSync(profile, { mode: 0o700 });
  const calls: unknown[][] = [];
  const options = {
    app: { setPath: (...args: unknown[]) => { calls.push(['setPath', ...args]); } },
    crashReporter: {
      start: (...args: unknown[]) => { calls.push(['start', ...args]); },
      addExtraParameter: (...args: unknown[]) => { calls.push(['phase', ...args]); },
    },
    argv: [`--propr-native-crash-directory=${root}`],
    authorizedSmokeDirectory: profile,
    platform: 'linux' as const,
  };
  return { temporary, root, profile, calls, options, cleanup: () => rmSync(temporary, { recursive: true, force: true }) };
};

test('native capture is absent by default and refuses unauthorized or unsafe destinations', { skip: process.platform !== 'linux' }, () => {
  const f = fixture();
  try {
    assert.equal(configureNativeShutdownDiagnostics({ ...f.options, argv: [] }), null);
    for (const override of [
      { authorizedSmokeDirectory: null },
      { platform: 'darwin' as const },
      { argv: [...f.options.argv, ...f.options.argv] },
      { argv: ['--propr-native-crash-directory'] },
      { argv: ['--propr-native-crash-directory=relative'] },
      { argv: [`--propr-native-crash-directory=${f.profile}`] },
      { argv: [`--propr-native-crash-directory=${f.temporary}`] },
    ]) assert.throws(() => configureNativeShutdownDiagnostics({ ...f.options, ...override }));
    const inside = join(f.profile, 'evidence');
    mkdirSync(inside, { mode: 0o700 });
    assert.throws(() => configureNativeShutdownDiagnostics({ ...f.options, argv: [`--propr-native-crash-directory=${inside}`] }));
    const link = join(f.temporary, 'linked');
    symlinkSync(f.root, link);
    assert.throws(() => configureNativeShutdownDiagnostics({ ...f.options, argv: [`--propr-native-crash-directory=${link}`] }));
    chmodSync(f.root, 0o755);
    assert.throws(() => configureNativeShutdownDiagnostics(f.options));
    assert.deepEqual(f.calls, []);
  } finally { f.cleanup(); }
});

test('capture remains outside profile cleanup, is private, offline, and distinct for each launch', { skip: process.platform !== 'linux' }, () => {
  const f = fixture();
  try {
    const capture = configureNativeShutdownDiagnostics(f.options)!;
    configureNativeShutdownDiagnostics(f.options);
    const launches = readdirSync(f.root);
    assert.equal(launches.length, 2);
    assert.deepEqual(f.calls[1], ['start', {
      uploadToServer: false, ignoreSystemCrashHandler: false,
      extra: { propr_shutdown_phase: 'startup' },
    }]);
    assert.equal(f.calls[0][1], 'crashDumps');
    for (const launch of launches) {
      const directory = join(f.root, launch);
      assert.equal(lstatSync(directory).mode & 0o777, 0o700);
      assert.equal(lstatSync(join(directory, 'dumps')).mode & 0o777, 0o700);
      assert.equal(lstatSync(join(directory, 'runtime.json')).mode & 0o777, 0o600);
      const runtime = JSON.parse(readFileSync(join(directory, 'runtime.json'), 'utf8'));
      assert.deepEqual(Object.keys(runtime).sort(), ['arch', 'chromium', 'electron', 'node', 'pid', 'platform', 'schemaVersion']);
      assert.equal(runtime.node, process.versions.node);
    }
    capture.recordPhase('synthetic-secret-not-an-annotation');
    capture.recordPhase({ step: 'final-quit' });
    assert.equal(f.calls.length, 4);
    rmSync(f.profile, { recursive: true });
    assert.deepEqual(readdirSync(f.root), launches);
  } finally { f.cleanup(); }
});

for (const mode of ['normal', 'in-flight', 'forced-timeout'] as const) {
  test(`capture follows production ${mode} shutdown through final quit without changing drain behavior`, { skip: process.platform !== 'linux' }, async () => {
    const f = fixture();
    try {
      const capture = configureNativeShutdownDiagnostics(f.options)!;
      let settle!: () => void;
      const pending = new Promise<void>(resolve => { settle = resolve; });
      const phases: string[] = [];
      let quitCount = 0;
      let destroyed = false;
      let retries = 0;
      let forced = 0;
      const shutdown = createDesktopShutdownCoordinator({
        credentials: { dispose: () => mode === 'normal' ? Promise.resolve() : pending },
        lifecycle: { shutdown: async () => undefined },
        ipc: { close() {}, awaitIdle: async () => undefined, dispose() {} },
        profiles: { close: async () => undefined },
        sessionSecurity: { close() {}, dispose() {} },
        disposeRendererProtocol() {},
        getWindow: () => ({ isDestroyed: () => destroyed, destroy: () => {
          destroyed = true;
          // Electron's window-all-closed handler can request quit again.
          shutdown.beforeQuit({ preventDefault() { retries++; } });
        } }),
        quit: () => {
          quitCount++;
          assert.equal(destroyed, true);
          assert.equal(phases.at(-1), 'final-quit');
          shutdown.beforeQuit({ preventDefault() { assert.fail('Final quit was prevented'); } });
          capture.recordPhase('will-quit');
        },
        onStarted() {},
        log: (_level, event, fields) => {
          if (event === 'desktop.app.shutdown_forced') forced++;
          if (event === 'desktop.app.shutdown_step') {
            phases.push(fields!.step as string);
            capture.recordPhase(fields!.step);
          }
        },
      }, { drainTimeoutMs: mode === 'forced-timeout' ? 20 : 15_000 });
      shutdown.beforeQuit({ preventDefault() {} });
      if (mode !== 'normal') {
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(destroyed, false);
        assert.equal(quitCount, 0);
        if (mode === 'in-flight') settle();
      }
      await shutdown.awaitFinished();
      assert.equal(quitCount, 1);
      assert.equal(retries, 1);
      assert.equal(forced, mode === 'forced-timeout' ? 1 : 0);
      assert.deepEqual(f.calls.at(-1), ['phase', 'propr_shutdown_phase', 'will-quit']);
      assert.equal(phases.filter(phase => phase === 'final-quit').length, 1);
      settle();
    } finally { f.cleanup(); }
  });
}
