import { contextBridge, ipcRenderer, webFrame } from 'electron';
import { createPackagedAcceptanceZoomBridge } from './acceptance-zoom';
import { createPackagedAcceptanceSetup } from './acceptance-setup';
import { createDesktopBridge } from './preload-bridge';
import { installWindowFrameStyles } from './preload-window-frame';

if (process.platform === 'linux') installWindowFrameStyles(ipcRenderer, document);

const connectJourneyAcceptance = process.env.PROPR_DESKTOP_CONNECT_SMOKE_TEST === '1'
  && (process.env.PROPR_DESKTOP_CONNECT_JOURNEY_PHASE === 'pair'
    || process.env.PROPR_DESKTOP_CONNECT_JOURNEY_PHASE === 'reprobe');

const acceptanceZoom = createPackagedAcceptanceZoomBridge(ipcRenderer, webFrame);
const setupFixture = createPackagedAcceptanceSetup(Boolean(acceptanceZoom), process.env.PROPR_DESKTOP_ACCEPTANCE_SCENARIO);
const bridge = createDesktopBridge(ipcRenderer, undefined, connectJourneyAcceptance);
contextBridge.exposeInMainWorld('proprDesktop', setupFixture ? { ...bridge, localSetup: setupFixture.localSetup } : bridge);
if (acceptanceZoom) {
  contextBridge.exposeInMainWorld('__PROPR_PACKAGED_ACCEPTANCE__', {
    ...acceptanceZoom,
    setupEvidence: setupFixture!.evidence,
  });
}
