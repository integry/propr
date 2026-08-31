import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createBrowserWindowOptions,
  MINIMUM_BROWSER_WINDOW_SIZE,
  PREFERRED_BROWSER_WINDOW_SIZE,
} from './window-options';

describe('desktop BrowserWindow security', () => {
  it('isolates and sandboxes the renderer without Node or webviews', () => {
    const options = createBrowserWindowOptions('/app/preload.cjs', true, 'linux');
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
    assert.equal(createBrowserWindowOptions('/preload.cjs', false, 'darwin').titleBarStyle, 'hiddenInset');
    assert.equal(createBrowserWindowOptions('/preload.cjs', false, 'win32').titleBarStyle, undefined);
  });

  it('retains the preferred and minimum responsive window sizes', () => {
    const options = createBrowserWindowOptions('/preload.cjs', false, 'win32');
    assert.deepEqual(PREFERRED_BROWSER_WINDOW_SIZE, { width: 1280, height: 820 });
    assert.deepEqual(MINIMUM_BROWSER_WINDOW_SIZE, { width: 880, height: 620 });
    assert.deepEqual(
      { width: options.width, height: options.height, minWidth: options.minWidth, minHeight: options.minHeight },
      { width: 1280, height: 820, minWidth: 880, minHeight: 620 },
    );
  });
});
