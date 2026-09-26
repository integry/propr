import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { NativeImage } from 'electron';
import {
  createDesktopNotificationOptions,
  DESKTOP_ICON_FILE,
  loadDesktopWindowIcon,
  resolveDesktopTrayIconPath,
  resolveLinuxDesktopIconPath,
  TRAY_ICON_FILE,
} from './desktop-icon';

describe('native desktop window icon', () => {
  it('resolves the copied resource in packaged Linux execution', () => {
    assert.equal(resolveLinuxDesktopIconPath({
      isPackaged: true,
      mainBundleDirectory: '/opt/propr/resources/app.asar/.vite/build',
      resourcesPath: '/opt/propr/resources',
    }), `/opt/propr/resources/${DESKTOP_ICON_FILE}`);
  });

  it('resolves the tracked desktop asset from the Vite development build', () => {
    assert.equal(resolveLinuxDesktopIconPath({
      isPackaged: false,
      mainBundleDirectory: '/checkout/apps/desktop/.vite/build',
      resourcesPath: '/electron/resources',
    }), `/checkout/apps/desktop/assets/icons/${DESKTOP_ICON_FILE}`);
  });

  it('resolves the generated transparent tray asset for packaged and development execution', () => {
    assert.equal(resolveDesktopTrayIconPath({
      isPackaged: true,
      mainBundleDirectory: '/ignored',
      resourcesPath: '/opt/propr/resources',
    }), `/opt/propr/resources/${TRAY_ICON_FILE}`);
    assert.equal(resolveDesktopTrayIconPath({
      isPackaged: false,
      mainBundleDirectory: '/checkout/apps/desktop/.vite/build',
      resourcesPath: '/ignored',
    }), `/checkout/apps/desktop/assets/icons/${TRAY_ICON_FILE}`);
  });

  it('loads and validates the exact Linux NativeImage used by BrowserWindow', () => {
    const image = {
      getSize: () => ({ width: 512, height: 512 }),
      isEmpty: () => false,
    } as NativeImage;
    let loadedPath = '';
    const result = loadDesktopWindowIcon({
      platform: 'linux',
      isPackaged: true,
      mainBundleDirectory: '/ignored',
      resourcesPath: '/app/resources',
      nativeImage: {
        createFromPath: path => {
          loadedPath = path;
          return image;
        },
      },
    });
    assert.equal(loadedPath, `/app/resources/${DESKTOP_ICON_FILE}`);
    assert.equal(result?.image, image);
    assert.deepEqual(result?.size, { width: 512, height: 512 });
  });

  it('fails closed when the packaged Linux icon cannot be decoded at its canonical size', () => {
    assert.throws(() => loadDesktopWindowIcon({
      platform: 'linux',
      isPackaged: true,
      mainBundleDirectory: '/ignored',
      resourcesPath: '/app/resources',
      nativeImage: {
        createFromPath: () => ({
          getSize: () => ({ width: 0, height: 0 }),
          isEmpty: () => true,
        }) as NativeImage,
      },
    }), /must load as 512x512/);
  });

  it('leaves deferred Windows and native macOS window handling unchanged', () => {
    for (const platform of ['darwin', 'win32'] as const) {
      let attempted = false;
      assert.equal(loadDesktopWindowIcon({
        platform,
        isPackaged: true,
        mainBundleDirectory: '/ignored',
        resourcesPath: '/ignored',
        nativeImage: {
          createFromPath: () => {
            attempted = true;
            throw new Error('must not load');
          },
        },
      }), undefined);
      assert.equal(attempted, false);
    }
  });
});

describe('native desktop notification icon', () => {
  it('passes the resolved transparent application artwork as a local Linux icon', () => {
    const iconPath = `/opt/propr/resources/${DESKTOP_ICON_FILE}`;
    assert.deepEqual(createDesktopNotificationOptions({
      platform: 'linux',
      title: 'Task completed',
      body: 'integry/propr · Task #2248',
      iconPath,
    }), {
      title: 'Task completed',
      body: 'integry/propr · Task #2248',
      icon: iconPath,
    });
  });

  it('requires Linux notification artwork to use an absolute local path', () => {
    for (const iconPath of [undefined, DESKTOP_ICON_FILE]) {
      assert.throws(() => createDesktopNotificationOptions({
        platform: 'linux',
        title: 'Task completed',
        body: 'Task',
        iconPath,
      }), /absolute ProPR application icon path/);
    }
  });

  it('uses application identity instead of a custom per-alert icon on macOS', () => {
    assert.deepEqual(createDesktopNotificationOptions({
      platform: 'darwin',
      title: 'Task completed',
      body: 'Task',
      iconPath: `/Applications/ProPR.app/Contents/Resources/${DESKTOP_ICON_FILE}`,
    }), { title: 'Task completed', body: 'Task' });
  });

  it('does not opt deferred Windows notifications into custom icon handling', () => {
    assert.deepEqual(createDesktopNotificationOptions({
      platform: 'win32',
      title: 'Task completed',
      body: 'Task',
      iconPath: `C:\\ProPR\\${DESKTOP_ICON_FILE}`,
    }), { title: 'Task completed', body: 'Task' });
  });
});
