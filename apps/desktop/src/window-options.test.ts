import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createBrowserWindowOptions } from './window-options';

describe('desktop BrowserWindow security', () => {
  it('uses the production 1280x820 size with safe minimum dimensions', () => {
    const options = createBrowserWindowOptions('/app/preload.cjs', false, 'win32');
    assert.deepEqual(
      { width: options.width, height: options.height, minWidth: options.minWidth, minHeight: options.minHeight },
      { width: 1280, height: 820, minWidth: 880, minHeight: 620 },
    );
  });

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
});
