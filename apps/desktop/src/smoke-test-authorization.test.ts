import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { authorizePackagedSmokeTest } from './smoke-test-authorization';

const smokeDirectory = '/tmp/propr-desktop-smoke-a1b2c3';
const authorize = (overrides: Partial<Parameters<typeof authorizePackagedSmokeTest>[0]> = {}) => (
  authorizePackagedSmokeTest({
    argv: ['propr-desktop', '--propr-smoke-test', `--user-data-dir=${smokeDirectory}`],
    defaultUserDataDirectory: '/home/user/.config/ProPR Desktop',
    environmentTriggered: false,
    isPackaged: true,
    platform: 'linux',
    ...overrides,
  })
);

describe('packaged smoke profile authorization', () => {
  it('enables argv and environment smoke triggers only with the explicit isolated directory', () => {
    assert.equal(authorize(), smokeDirectory);
    assert.equal(authorize({
      argv: ['propr-desktop', `--user-data-dir=${smokeDirectory}`],
      environmentTriggered: true,
    }), smokeDirectory);
  });

  it('rejects argv and environment smoke flags when the isolated directory is missing', () => {
    assert.throws(
      () => authorize({ argv: ['propr-desktop', '--propr-smoke-test'] }),
      /exactly one explicit --user-data-dir/,
    );
    assert.throws(
      () => authorize({ argv: ['propr-desktop'], environmentTriggered: true }),
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
        argv: ['propr-desktop', '--propr-smoke-test', '--user-data-dir=/home/user/.config/ProPR Desktop'],
      }),
      /cannot use the default profile store/,
    );
    assert.throws(
      () => authorize({
        argv: ['propr-desktop', '--propr-smoke-test', '--user-data-dir=/tmp/not-a-smoke-profile'],
      }),
      /must use propr-desktop-smoke-/,
    );
    assert.throws(
      () => authorize({
        argv: [
          'propr-desktop',
          '--propr-smoke-test',
          `--user-data-dir=${smokeDirectory}`,
          '--user-data-dir=/tmp/propr-desktop-smoke-other',
        ],
      }),
      /exactly one explicit --user-data-dir/,
    );
  });

  it('does not enable mutating smoke behavior in development or without a trigger', () => {
    assert.equal(authorize({ isPackaged: false }), null);
    assert.equal(authorize({ argv: ['propr-desktop', `--user-data-dir=${smokeDirectory}`] }), null);
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
});
