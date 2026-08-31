import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { authorizePackagedSmokeTest } from './smoke-test-authorization';

const smokeLeaf = 'propr-desktop-smoke-a1b2c3';
const smokeDirectory = resolve(tmpdir(), smokeLeaf);
const defaultUserDataDirectory = resolve(tmpdir(), 'ProPR Desktop');
const nonSmokeDirectory = resolve(tmpdir(), 'not-a-smoke-profile');
const duplicateSmokeDirectory = resolve(tmpdir(), 'propr-desktop-smoke-other');
const authorize = (overrides: Partial<Parameters<typeof authorizePackagedSmokeTest>[0]> = {}) => (
  authorizePackagedSmokeTest({
    argv: ['propr-desktop', '--propr-smoke-test', `--user-data-dir=${smokeDirectory}`],
    defaultUserDataDirectory,
    environmentTriggered: true,
    isPackaged: true,
    platform: process.platform,
    ...overrides,
  })
);

describe('packaged smoke profile authorization', () => {
  it('requires both argv and environment smoke triggers with the explicit isolated directory', () => {
    assert.equal(authorize(), smokeDirectory);
    assert.throws(
      () => authorize({ environmentTriggered: false }),
      /requires both explicit authorization triggers/,
    );
    assert.throws(
      () => authorize({
        argv: ['propr-desktop', `--user-data-dir=${smokeDirectory}`],
        environmentTriggered: true,
      }),
      /requires both explicit authorization triggers/,
    );
  });

  it('rejects a dual-authorized smoke invocation when the isolated directory is missing', () => {
    assert.throws(
      () => authorize({ argv: ['propr-desktop', '--propr-smoke-test'] }),
      /exactly one explicit --user-data-dir/,
    );
  });

  it('rejects relative, default, non-smoke, and duplicate directories', () => {
    assert.throws(
      () => authorize({
        argv: ['propr-desktop', '--propr-smoke-test', '--user-data-dir=propr-desktop-smoke-relative'],
      }),
      /must be absolute/,
    );
    assert.throws(
      () => authorize({
        argv: ['propr-desktop', '--propr-smoke-test', `--user-data-dir=${defaultUserDataDirectory}`],
      }),
      /cannot use the default profile store/,
    );
    assert.throws(
      () => authorize({
        argv: ['propr-desktop', '--propr-smoke-test', `--user-data-dir=${nonSmokeDirectory}`],
      }),
      /must use propr-desktop-smoke-/,
    );
    assert.throws(
      () => authorize({
        argv: [
          'propr-desktop',
          '--propr-smoke-test',
          `--user-data-dir=${smokeDirectory}`,
          `--user-data-dir=${duplicateSmokeDirectory}`,
        ],
      }),
      /exactly one explicit --user-data-dir/,
    );
  });

  it('does not enable mutating smoke behavior in development or without a trigger', () => {
    assert.equal(authorize({ isPackaged: false }), null);
    assert.equal(authorize({
      argv: ['propr-desktop', `--user-data-dir=${smokeDirectory}`],
      environmentTriggered: false,
    }), null);
  });

  it('terminates a malformed packaged smoke attempt without an interactive failure path', () => {
    const main = readFileSync(fileURLToPath(new URL('./main.ts', import.meta.url)), 'utf8');
    const authorization = main.indexOf('authorizePackagedSmokeTest({');
    const failureGuard = main.indexOf('} catch {', authorization);
    const noninteractiveExit = main.indexOf('process.exit(1);', failureGuard);
    const applicationReady = main.indexOf('void app.whenReady()');

    assert.ok(authorization < failureGuard && failureGuard < noninteractiveExit);
    assert.ok(noninteractiveExit < applicationReady);
    assert.doesNotMatch(main.slice(failureGuard, noninteractiveExit), /dialog|showMessageBox|console\.|\berror\b/i);
  });

  it('authorizes the isolated directory before profile and lifecycle construction', () => {
    const main = readFileSync(fileURLToPath(new URL('./main.ts', import.meta.url)), 'utf8');
    const authorization = main.indexOf('authorizePackagedSmokeTest({');
    const isolation = main.indexOf("app.setPath('userData', packagedSmokeUserDataDirectory)");
    assert.notEqual(authorization, -1);
    assert.ok(authorization < isolation);
    assert.ok(isolation < main.indexOf('new ProfileStore('));
    assert.ok(isolation < main.indexOf('new LocalLifecycleController('));
    assert.ok(authorization < main.indexOf('new ProfileStore('));
    assert.ok(authorization < main.indexOf('new LocalLifecycleController('));
  });

  it('registers one-shot lifecycle shutdown before smoke window creation and preserves required evidence order', () => {
    const main = readFileSync(fileURLToPath(new URL('./main.ts', import.meta.url)), 'utf8');
    const installedWindowsAppTest = readFileSync(
      fileURLToPath(new URL('../scripts/test-installed-windows-app.ps1', import.meta.url)),
      'utf8',
    );
    const isolation = main.indexOf("app.setPath('userData', packagedSmokeUserDataDirectory)");
    const sink = main.indexOf('createPackagedSmokeEvidenceSink(packagedSmokeUserDataDirectory)');
    const authorized = main.indexOf("packagedSmokeEvidence?.write('desktop.smoke.authorized')");
    const appReady = main.indexOf("log('info', 'desktop.app.ready'");
    const beforeQuit = main.indexOf("app.on('before-quit'");
    const createWindow = main.indexOf('mainWindow = await createMainWindow()');
    const mvpReady = main.indexOf("log('info', 'desktop.renderer.mvp_flows.ready'");
    const layoutReady = main.indexOf("log('info', PACKAGED_LAYOUT_READY_EVENT");
    const rendererReady = main.indexOf("log('info', 'desktop.renderer.ready'");
    const shutdownGuard = main.indexOf('if (shutdownStarted) return;', beforeQuit);
    const preventQuit = main.indexOf('event.preventDefault();', beforeQuit);
    const startShutdown = main.indexOf('shutdownStarted = true;', beforeQuit);
    const lifecycleShutdown = main.indexOf('lifecycle.shutdown()', beforeQuit);
    const shutdown = main.indexOf("log('info', 'desktop.app.shutdown'", beforeQuit);
    const finalQuit = main.indexOf('app.quit();', shutdown);
    const willQuit = main.indexOf("app.on('will-quit'");
    const sinkClose = main.indexOf('packagedSmokeEvidence?.close()', willQuit);
    const requiredEvents = installedWindowsAppTest.match(/\$requiredSmokeEvents = @\(([\s\S]*?)\r?\n\)/)?.[1];

    assert.ok(isolation < sink && sink < authorized);
    assert.ok(authorized < appReady && appReady < beforeQuit && beforeQuit < createWindow);
    assert.ok(mvpReady < layoutReady && layoutReady < rendererReady);
    assert.ok(beforeQuit < shutdownGuard && shutdownGuard < preventQuit && preventQuit < startShutdown);
    assert.ok(startShutdown < lifecycleShutdown && lifecycleShutdown < shutdown && shutdown < finalQuit);
    assert.ok(finalQuit < willQuit && willQuit < sinkClose);
    assert.equal(main.match(/lifecycle\.shutdown\(\)/g)?.length, 1);
    assert.deepEqual(Array.from(requiredEvents?.matchAll(/'([^']+)'/g) ?? [], match => match[1]), [
      'desktop.smoke.authorized',
      'desktop.app.ready',
      'desktop.renderer.mvp_flows.ready',
      'desktop.renderer.layout.ready',
      'desktop.renderer.ready',
      'desktop.app.shutdown',
    ]);
  });
});
