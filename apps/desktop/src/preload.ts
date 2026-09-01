import { contextBridge, ipcRenderer } from 'electron';
import { createDesktopBridge, createDesktopRendererBridge } from './preload-bridge';

const desktopBridge = createDesktopBridge(ipcRenderer);
contextBridge.exposeInMainWorld('proprDesktop', desktopBridge);
contextBridge.exposeInMainWorld(
  '__PROPR_DESKTOP__',
  createDesktopRendererBridge(ipcRenderer, process.platform, undefined, desktopBridge.app.onDeepLink),
);
