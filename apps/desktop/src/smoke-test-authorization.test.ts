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
    assert.equal(authorize({ environmentTriggered: false }), null);
    assert.equal(authorize({
      argv: ['propr-desktop', `--user-data-dir=${smokeDirectory}`],
      environmentTriggered: true,
    }), null);
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
    assert.equal(authorize({ argv: ['propr-desktop', `--user-data-dir=${smokeDirectory}`] }), null);
    assert.equal(authorize({ environmentTriggered: false }), null);
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

  it('creates the fixed evidence sink immediately after isolation and emits the real lifecycle in order', () => {
    const main = readFileSync(fileURLToPath(new URL('./main.ts', import.meta.url)), 'utf8');
    const isolation = main.indexOf("app.setPath('userData', packagedSmokeUserDataDirectory)");
    const sink = main.indexOf('createPackagedSmokeEvidenceSink(packagedSmokeUserDataDirectory)');
    const authorized = main.indexOf("packagedSmokeEvidence?.write('desktop.smoke.authorized')");
    const appReady = main.indexOf("log('info', 'desktop.app.ready'");
    const createWindow = main.indexOf('mainWindow = await createMainWindow()');
    const mvpReady = main.indexOf("log('info', 'desktop.renderer.mvp_flows.ready'");
    const layoutReady = main.indexOf("log('info', PACKAGED_LAYOUT_READY_EVENT");
    const rendererReady = main.indexOf("log('info', 'desktop.renderer.ready'");
    const shutdown = main.indexOf("log('info', 'desktop.app.shutdown'");
    assert.ok(isolation < sink && sink < authorized);
    assert.ok(authorized < appReady && appReady < createWindow && createWindow < shutdown);
    assert.ok(mvpReady < layoutReady && layoutReady < rendererReady);
  });
});
