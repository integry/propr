import { app, BrowserWindow, ipcMain, Menu, nativeImage, net, protocol, screen } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBrowserWindowOptions } from '../../../src/window-options';
import { synchronizeLinuxWindowFrame } from '../../../src/linux-window-frame';
import { createApplicationMenuPopup } from '../../../src/application-menu';
import type { DesktopNativeCommandDispatcher } from '../../../src/native-commands';
import { isDesktopApplicationMenuRequest } from '../../../src/shared/contract';

// Isolated fixture: production window options/state and renderer components,
// in-memory profiles, no user session, services, authentication or tray.
app.disableHardwareAcceleration();
app.setPath('userData', join(__dirname, 'user-data'));
protocol.registerSchemesAsPrivileged([{ scheme: 'frame-fixture', privileges: { standard: true, secure: true } }]);
void app.whenReady().then(async () => {
  protocol.handle('frame-fixture', request => {
    const asset = new URL(request.url).pathname.replace(/^\/+/, '');
    return net.fetch(pathToFileURL(asset === 'logo.png'
      ? process.env.PROPR_FRAME_LOGO! : join(__dirname, asset)).href);
  });
  const background = new BrowserWindow({
    ...screen.getPrimaryDisplay().bounds, frame: false,
    backgroundColor: '#ffffff', title: 'White background',
  });
  await background.loadURL('data:text/html,<title>White background</title><body style="background:white">');
  const window = new BrowserWindow(createBrowserWindowOptions(
    join(__dirname, 'preload.cjs'), false, screen.getPrimaryDisplay().workArea,
    'linux', nativeImage.createFromPath(process.env.PROPR_FRAME_ICON!),
  ));
  synchronizeLinuxWindowFrame(window);
  ipcMain.handle('fixture:minimize', () => window.minimize());
  ipcMain.handle('fixture:toggle-maximize', () => window.isMaximized() ? window.unmaximize() : window.maximize());
  ipcMain.handle('fixture:close', () => window.close());
  // Real native popup of the production template; commands are only recorded.
  const menuEvents: string[] = [];
  Object.assign(globalThis, { __applicationMenuEvents: menuEvents });
  const commands: DesktopNativeCommandDispatcher = {
    dispatch: command => { menuEvents.push(`command:${command}`); },
    getState: () => ({ authenticated: true, nativeNotificationsAvailable: false, nativeNotificationsEnabled: false }),
    subscribe: () => () => undefined,
    rendererReady: () => undefined, rendererUnavailable: () => undefined,
    connectionAvailable: () => undefined, connectionUnavailable: () => undefined,
    refresh: () => undefined, close: () => undefined,
  };
  const applicationMenu = createApplicationMenuPopup<BrowserWindow>({
    buildFromTemplate: template => {
      const menu = Menu.buildFromTemplate(template);
      menu.on('menu-will-show', () => menuEvents.push('show'));
      menu.on('menu-will-close', () => menuEvents.push('close'));
      return menu;
    },
  }, commands, 'linux');
  ipcMain.handle('fixture:application-menu', (_event, request) => {
    if (!isDesktopApplicationMenuRequest(request)) throw new Error('Invalid application menu request');
    applicationMenu.show(window, request);
  });
  await window.loadURL('frame-fixture://app/renderer.html');
  window.show();
});
