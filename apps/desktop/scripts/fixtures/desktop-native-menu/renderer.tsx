import React from 'react';
import { createRoot } from 'react-dom/client';
import { DesktopExperience } from '../../../../../propr-ui/src/desktop/DesktopExperience';
import { HashRouter, Routes, Route } from 'react-router-dom';
import Layout from '../../../../../propr-ui/src/components/Layout';
import PlanStudioPage from '../../../../../propr-ui/src/pages/PlanStudioPage';
import NewTaskPage from '../../../../../propr-ui/src/pages/NewTaskPage';
import { DesktopNativeNavigationObserver } from '../../../../../propr-ui/src/desktop/DesktopNativeNavigationObserver';
import { createApplicationMenuTemplate } from '../../../src/application-menu';
import { createDesktopNativeCommandDispatcher } from '../../../src/native-commands';
import { createDesktopBridge } from '../../../src/preload-bridge';
import { IPC_CHANNELS, isDesktopNativeNavigationState } from '../../../src/shared/contract';
import { ToastProvider } from '../../../../../propr-ui/src/components/ui/Toast';
import { AuthProvider } from '../../../../../propr-ui/src/contexts/AuthContext';
import { NotificationCenterProvider } from '../../../../../propr-ui/src/contexts/NotificationCenterContext';
import { SocketContext, type SocketContextValue } from '../../../../../propr-ui/src/contexts/SocketContext';
import type { DesktopAdapters } from '../../../../../propr-ui/src/desktop/types';
import { createElectronDesktopAdapters } from '../../../../../propr-ui/src/desktop/electronAdapters';
import { DesktopDeepLinkInbox } from '../../../../../propr-ui/src/desktop-deep-link';

const profile = { id: 'local', name: 'This computer', kind: 'local' as const, baseUrl: 'http://127.0.0.1:3000' };
const scope = { profileId: 'local', transportScope: 'abcdefghijklmnopqrstuv' };
const listeners = new Map<string, (event: unknown, value: unknown) => void>();
const dispatcher = createDesktopNativeCommandDispatcher({
  channel: IPC_CHANNELS.nativeCommand,
  getWindow: () => ({ isDestroyed: () => false, webContents: { send: (channel, value) => listeners.get(channel)?.({}, value) } }),
  restoreWindow: () => undefined, activeConnectionScope: () => scope,
  activeNotificationScope: () => null, notificationState: () => ({ available: false, enabled: false }),
  setNativeNotificationsEnabled: async () => undefined, quit: () => undefined,
});
const bridge = createDesktopBridge({
  on: (channel, listener) => { listeners.set(channel, listener); },
  removeListener: channel => { listeners.delete(channel); },
  invoke: async (channel, value) => {
    if (channel === IPC_CHANNELS.deepLinkConsumerReady) return { pendingConnect: false };
    if (channel === IPC_CHANNELS.nativeNavigationState && isDesktopNativeNavigationState(value)) dispatcher.updateNavigationState?.(value);
  },
});
dispatcher.rendererReady();
Object.assign(window, { nativeMenu: {
  click(label: string, platform: NodeJS.Platform) {
    const item = createApplicationMenuTemplate(platform, dispatcher).flatMap(item => Array.isArray(item.submenu) ? item.submenu : []).find(item => item.label === label);
    if (!item || item.enabled === false) throw new Error(`Unavailable menu item: ${label}`);
    (item.click as () => void)();
  },
} });
const adapters: DesktopAdapters = {
  // Exercise production platform detection, rather than inventing a CSS class.
  platform: createElectronDesktopAdapters(bridge).platform,
  app: bridge.app,
  profiles: {
    list: async () => [profile], getActiveId: async () => sessionStorage.getItem('frame-active-profile'),
    save: async () => undefined, remove: async () => undefined,
    setActiveId: async id => {
      if (id === null) sessionStorage.removeItem('frame-active-profile');
      else sessionStorage.setItem('frame-active-profile', id);
    },
  },
  connection: { probe: async () => { dispatcher.connectionAvailable(); return { status: 'ready', version: '0.8.15', ...scope }; } },
  discovery: { supported: false, discover: async () => [] },
  localSetup: { supported: true },
  authentication: { authenticate: async () => undefined },
  externalBrowser: { open: async () => undefined },
};

// Register the presentation consumer so the preload startup handshake completes.
const deepLinks = new DesktopDeepLinkInbox();
adapters.app.onDeepLink(value => deepLinks.receive(value));

const noop = () => undefined;
const subscribe = () => noop;
const socket: SocketContextValue = {
  socket: null, isConnected: true,
  subscribeToTask: noop, unsubscribeFromTask: noop,
  subscribeToDraft: noop, unsubscribeFromDraft: noop,
  subscribeToIndexing: noop, unsubscribeFromIndexing: noop,
  subscribeToIndexingUpdates: noop, unsubscribeFromIndexingUpdates: noop,
  subscribeToQueueStats: noop, unsubscribeFromQueueStats: noop,
  subscribeToTaskLive: noop, unsubscribeFromTaskLive: noop,
  onTaskUpdate: subscribe, onDraftUpdate: subscribe, onIndexingUpdate: subscribe,
  onQueueStatsUpdate: subscribe, onTaskLiveUpdate: subscribe,
};

createRoot(document.getElementById('root')!).render(
  <DesktopExperience adapters={adapters} deepLinks={deepLinks}>
    <HashRouter><DesktopNativeNavigationObserver />
      <SocketContext.Provider value={socket}>
        <ToastProvider>
          <AuthProvider user={{ id: 'frame-user', login: 'frame-user', username: 'frame-user', displayName: 'Frame Test', email: null, avatarUrl: null, role: 'member', permissions: [], authorizationSource: 'local' }}>
            <NotificationCenterProvider>
              <Layout><Routes><Route path="/studio/new" element={<PlanStudioPage isNew />} /><Route path="/tasks/new" element={<NewTaskPage />} /><Route path="*" element={<div className="p-6">Desktop menu test workspace</div>} /></Routes></Layout>
            </NotificationCenterProvider>
          </AuthProvider>
        </ToastProvider>
      </SocketContext.Provider>
    </HashRouter>
  </DesktopExperience>,
);
