import { contextBridge, ipcRenderer } from 'electron';
import { createDesktopBridge } from './preload-bridge';

contextBridge.exposeInMainWorld('proprDesktop', createDesktopBridge(ipcRenderer));
