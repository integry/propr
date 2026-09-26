import React from 'react';
import { createRoot } from 'react-dom/client';
import { DesktopExperience } from '../../../../../propr-ui/src/desktop/DesktopExperience';
import { MemoryRouter } from 'react-router-dom';
import Layout from '../../../../../propr-ui/src/components/Layout';
import Dashboard from '../../../../../propr-ui/src/components/Dashboard';
import { ToastProvider } from '../../../../../propr-ui/src/components/ui/Toast';
import { AuthProvider } from '../../../../../propr-ui/src/contexts/AuthContext';
import { NotificationCenterProvider } from '../../../../../propr-ui/src/contexts/NotificationCenterContext';
import { SocketContext, type SocketContextValue } from '../../../../../propr-ui/src/contexts/SocketContext';
import type { DesktopAdapters } from '../../../../../propr-ui/src/desktop/types';
import { createElectronDesktopAdapters } from '../../../../../propr-ui/src/desktop/electronAdapters';
import { DesktopDeepLinkInbox } from '../../../../../propr-ui/src/desktop-deep-link';
import { createDesktopBridge } from '../../../src/preload-bridge';
import { IPC_CHANNELS } from '../../../src/shared/contract';

const profile = { id: 'local', name: 'This computer', kind: 'local' as const, baseUrl: 'http://127.0.0.1:3000' };
const bridge = createDesktopBridge({
  on: () => undefined,
  removeListener: () => undefined,
  invoke: async channel => {
    if (channel === IPC_CHANNELS.deepLinkConsumerReady) return { pendingConnect: false };
  },
}, false);
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
  connection: { probe: async () => ({ status: 'ready' }) },
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
    <MemoryRouter>
      <SocketContext.Provider value={socket}>
        <ToastProvider>
          <AuthProvider user={{ id: 'frame-user', login: 'frame-user', username: 'frame-user', displayName: 'Frame Test', email: null, avatarUrl: null, role: 'member', permissions: [], authorizationSource: 'local' }}>
            <NotificationCenterProvider>
              <Layout><Dashboard /></Layout>
            </NotificationCenterProvider>
          </AuthProvider>
        </ToastProvider>
      </SocketContext.Provider>
    </MemoryRouter>
  </DesktopExperience>,
);
