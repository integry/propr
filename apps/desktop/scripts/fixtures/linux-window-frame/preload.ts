import { contextBridge, ipcRenderer } from 'electron';
import { installWindowFrameStyles } from '../../../src/preload-window-frame';

installWindowFrameStyles(ipcRenderer, document);
contextBridge.exposeInMainWorld('frameFixture', {
  minimize: () => ipcRenderer.invoke('fixture:minimize'),
  toggleMaximize: () => ipcRenderer.invoke('fixture:toggle-maximize'),
  closeWindow: () => ipcRenderer.invoke('fixture:close'),
});
