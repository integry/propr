import { app, BrowserWindow, ipcMain, nativeImage, net, protocol, screen } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBrowserWindowOptions } from '../../../src/window-options';
import { synchronizeLinuxWindowFrame } from '../../../src/linux-window-frame';

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
  await window.loadURL('frame-fixture://app/renderer.html');
  window.show();
});
