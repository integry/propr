import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createBrowserWindowOptions } from './window-options';

describe('desktop BrowserWindow security', () => {
  it('isolates and sandboxes the renderer without Node or webviews', () => {
    const options = createBrowserWindowOptions('/app/preload.js', true, 'linux');
    assert.deepEqual(options.webPreferences, {
      preload: '/app/preload.js',
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
    assert.equal(createBrowserWindowOptions('/preload.js', false, 'darwin').titleBarStyle, 'hiddenInset');
    assert.equal(createBrowserWindowOptions('/preload.js', false, 'win32').titleBarStyle, undefined);
  });
});
