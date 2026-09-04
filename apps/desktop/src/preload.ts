import { contextBridge, ipcRenderer, webFrame } from 'electron';
import { createPackagedAcceptanceZoomBridge } from './acceptance-zoom';
import { createDesktopBridge } from './preload-bridge';

const connectJourneyAcceptance = process.env.PROPR_DESKTOP_CONNECT_SMOKE_TEST === '1'
  && (process.env.PROPR_DESKTOP_CONNECT_JOURNEY_PHASE === 'pair'
    || process.env.PROPR_DESKTOP_CONNECT_JOURNEY_PHASE === 'reprobe');

contextBridge.exposeInMainWorld(
  'proprDesktop',
  createDesktopBridge(ipcRenderer, undefined, connectJourneyAcceptance),
);
const acceptanceZoom = createPackagedAcceptanceZoomBridge(ipcRenderer, webFrame);
if (acceptanceZoom) {
  contextBridge.exposeInMainWorld('__PROPR_PACKAGED_ACCEPTANCE__', acceptanceZoom);
  const scenario = process.env.PROPR_DESKTOP_ACCEPTANCE_SCENARIO;
  contextBridge.exposeInMainWorld(
    '__PROPR_PACKAGED_ACCEPTANCE_SCENARIO__',
    scenario === 'setup-error' || scenario === 'setup-complete' ? scenario : 'default',
  );
}
