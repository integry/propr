import { contextBridge, ipcRenderer, webFrame } from 'electron';
import { createPackagedAcceptanceZoomBridge } from './acceptance-zoom';
import { createDesktopBridge, createDesktopRendererBridge } from './preload-bridge';

const desktopBridge = createDesktopBridge(ipcRenderer);
contextBridge.exposeInMainWorld('proprDesktop', desktopBridge);
contextBridge.exposeInMainWorld(
  '__PROPR_DESKTOP__',
  createDesktopRendererBridge(ipcRenderer, process.platform, undefined, desktopBridge.app.onDeepLink),
);
const acceptanceZoom = createPackagedAcceptanceZoomBridge(ipcRenderer, webFrame);
if (acceptanceZoom) contextBridge.exposeInMainWorld('__PROPR_PACKAGED_ACCEPTANCE__', acceptanceZoom);
