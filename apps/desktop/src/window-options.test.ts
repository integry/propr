import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  clampBrowserWindowSizing,
  createBrowserWindowOptions,
  MINIMUM_BROWSER_WINDOW_SIZE,
  PREFERRED_BROWSER_WINDOW_SIZE,
  selectInitialWindowWorkArea,
} from './window-options';

const normalWorkArea = { x: 0, y: 0, width: 1920, height: 1040 };

describe('desktop BrowserWindow security', () => {
  it('uses the production 1280x820 size with safe minimum dimensions', () => {
    const options = createBrowserWindowOptions('/app/preload.cjs', false, normalWorkArea, 'win32');
    assert.deepEqual(
      { width: options.width, height: options.height, minWidth: options.minWidth, minHeight: options.minHeight },
      { width: 1280, height: 820, minWidth: 880, minHeight: 620 },
    );
  });

  it('isolates and sandboxes the renderer without Node or webviews', () => {
    const options = createBrowserWindowOptions('/app/preload.cjs', true, normalWorkArea, 'linux');
    assert.deepEqual(options.webPreferences, {
      preload: '/app/preload.cjs',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      devTools: true,
    });
    assert.equal('enableRemoteModule' in (options.webPreferences ?? {}), false);
  });

  it('uses the native inset title bar only on macOS', () => {
    assert.equal(createBrowserWindowOptions('/preload.cjs', false, normalWorkArea, 'darwin').titleBarStyle, 'hiddenInset');
    assert.equal(createBrowserWindowOptions('/preload.cjs', false, normalWorkArea, 'win32').titleBarStyle, undefined);
  });

  it('retains the preferred and minimum responsive window sizes', () => {
    const options = createBrowserWindowOptions('/preload.cjs', false, normalWorkArea, 'win32');
    assert.deepEqual(PREFERRED_BROWSER_WINDOW_SIZE, { width: 1280, height: 820 });
    assert.deepEqual(MINIMUM_BROWSER_WINDOW_SIZE, { width: 880, height: 620 });
    assert.deepEqual(
      { width: options.width, height: options.height, minWidth: options.minWidth, minHeight: options.minHeight },
      { width: 1280, height: 820, minWidth: 880, minHeight: 620 },
    );
  });

  it('centers the initial window within the selected display work area', () => {
    const options = createBrowserWindowOptions(
      '/preload.cjs',
      false,
      { x: -1600, y: 40, width: 1600, height: 900 },
      'linux',
    );
    assert.deepEqual(
      { x: options.x, y: options.y, width: options.width, height: options.height },
      { x: -1440, y: 80, width: 1280, height: 820 },
    );
  });
});

describe('desktop BrowserWindow display sizing', () => {
  for (const scenario of [
    {
      name: 'normal work area',
      workArea: { width: 1920, height: 1040 },
      expected: { width: 1280, height: 820, minWidth: 880, minHeight: 620 },
    },
    {
      name: 'exactly bounded work area',
      workArea: { width: 1280, height: 820 },
      expected: { width: 1280, height: 820, minWidth: 880, minHeight: 620 },
    },
    {
      name: 'narrow work area',
      workArea: { width: 800, height: 1040 },
      expected: { width: 800, height: 820, minWidth: 800, minHeight: 620 },
    },
    {
      name: 'short work area',
      workArea: { width: 1920, height: 560 },
      expected: { width: 1280, height: 560, minWidth: 880, minHeight: 560 },
    },
    {
      name: 'work area smaller in both dimensions',
      workArea: { width: 800, height: 560 },
      expected: { width: 800, height: 560, minWidth: 800, minHeight: 560 },
    },
  ]) {
    it(`clamps preferred and minimum sizing for a ${scenario.name}`, () => {
      assert.deepEqual(clampBrowserWindowSizing(scenario.workArea), scenario.expected);
    });
  }

  it('selects the display nearest the cursor for multi-display window placement', () => {
    const primary = { workArea: normalWorkArea };
    const active = { workArea: { x: -1600, y: 0, width: 1600, height: 900 } };
    assert.deepEqual(selectInitialWindowWorkArea({
      getPrimaryDisplay: () => primary as never,
      getCursorScreenPoint: () => ({ x: -400, y: 300 }),
      getDisplayNearestPoint: point => {
        assert.deepEqual(point, { x: -400, y: 300 });
        return active as never;
      },
    }), active.workArea);
  });

  it('falls back deterministically to the primary display', () => {
    const primary = { workArea: normalWorkArea };
    assert.deepEqual(selectInitialWindowWorkArea({
      getPrimaryDisplay: () => primary as never,
      getCursorScreenPoint: () => {
        throw new Error('cursor unavailable');
      },
      getDisplayNearestPoint: () => {
        throw new Error('must not be reached');
      },
    }), primary.workArea);
  });
});
