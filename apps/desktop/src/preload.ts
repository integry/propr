import { contextBridge, ipcRenderer } from 'electron';
import { createDesktopBridge } from './preload-bridge';

const connectJourneyAcceptance = process.env.PROPR_DESKTOP_CONNECT_SMOKE_TEST === '1'
  && (process.env.PROPR_DESKTOP_CONNECT_JOURNEY_PHASE === 'pair'
    || process.env.PROPR_DESKTOP_CONNECT_JOURNEY_PHASE === 'reprobe');

contextBridge.exposeInMainWorld(
  'proprDesktop',
  createDesktopBridge(ipcRenderer, undefined, connectJourneyAcceptance),
);
