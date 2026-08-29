import { contextBridge, ipcRenderer } from 'electron';
import { createDesktopBridge, createDesktopRendererBridge } from './preload-bridge';

contextBridge.exposeInMainWorld('proprDesktop', createDesktopBridge(ipcRenderer));
contextBridge.exposeInMainWorld('__PROPR_DESKTOP__', createDesktopRendererBridge(ipcRenderer));
