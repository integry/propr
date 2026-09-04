import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { configureApplicationMenu } from './application-menu';

describe('desktop application menu', () => {
  it('removes Electron\'s stock menu from packaged Linux builds', () => {
    const configuredMenus: null[] = [];

    configureApplicationMenu({
      setApplicationMenu(menu) {
        configuredMenus.push(menu);
      },
    }, true, 'linux');

    assert.deepEqual(configuredMenus, [null]);
  });

  it('retains the development menu and native menus on other platforms', () => {
    for (const scenario of [
      { isPackaged: false, platform: 'linux' as const },
      { isPackaged: true, platform: 'darwin' as const },
      { isPackaged: true, platform: 'win32' as const },
    ]) {
      let configured = false;
      configureApplicationMenu({
        setApplicationMenu() {
          configured = true;
        },
      }, scenario.isPackaged, scenario.platform);
      assert.equal(configured, false, JSON.stringify(scenario));
    }
  });
});

