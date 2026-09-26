import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { before, describe, it } from 'node:test';
import { linuxProbeArguments, runElectronFixture } from './electron-fixture-runner.mjs';
import { prepareNativeElectronTest } from './electron-native-test-setup.mjs';

const fixture = resolve(dirname(fileURLToPath(import.meta.url)), 'electron-frame-semantics-probe.cjs');

describe('Electron BrowserWindow lifecycle semantics', () => {
  let setup;
  // A cold Electron download belongs to setup, not the fixture's own budget.
  before(() => {
    setup = prepareNativeElectronTest();
  }, { timeout: 120_000 });

  // The budget covers the runner's bounded relaunch of a worker that killed the
  // fixture before it reported anything, which costs one 20s launch each.
  it('keeps initial frame identity stable and invalidates the window getter after destruction', {
    timeout: 50_000,
  }, async context => {
    if ('skipReason' in setup) {
      context.skip(setup.skipReason);
      return;
    }
    const report = await runElectronFixture({
      diagnostic: message => context.diagnostic(message),
      electronArguments: [
        ...(process.platform === 'linux' ? linuxProbeArguments : []),
        fixture,
      ],
      name: 'Electron frame fixture',
      setup,
      timeout: 20_000,
    });

    assert.deepEqual(report, {
      navigationStarted: {
        detailsIsFirst: true,
        deprecatedUrlIsSecond: true,
        isMainFrame: true,
        isSameDocument: false,
        detailsFrameMatchesGetter: true,
        initialFrameMatchesGetter: true,
        initialDocumentIdMatches: true,
      },
      navigationCommitted: {
        firstGetterMatchesSecondGetter: true,
        initialFrameMatchesGetter: true,
        initialDocumentIdMatches: true,
      },
      readiness: {
        senderFrameMatchesFirstGetter: true,
        firstGetterMatchesSecondGetter: true,
        initialFrameMatchesGetter: true,
        initialDocumentIdMatches: true,
      },
      teardown: {
        initialNavigationCompleted: true,
        windowDestroyed: true,
        cachedWebContentsAccessible: true,
        getterError: {
          name: 'TypeError',
          message: 'Object has been destroyed',
        },
      },
    });
  });
});
