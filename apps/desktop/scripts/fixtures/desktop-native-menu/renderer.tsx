import React from 'react';
import { createRoot } from 'react-dom/client';
import { DesktopExperience } from '../../../../../propr-ui/src/desktop/DesktopExperience';
import { HashRouter, Routes, Route } from 'react-router-dom';
import Layout from '../../../../../propr-ui/src/components/Layout';
import PlanStudioPage from '../../../../../propr-ui/src/pages/PlanStudioPage';
import NewTaskPage from '../../../../../propr-ui/src/pages/NewTaskPage';
import GoalsPage from '../../../../../propr-ui/src/pages/GoalsPage';
import AgentsPage from '../../../../../propr-ui/src/pages/AgentsPage';
import { AppViewport } from '../../../../../propr-ui/src/components/AppViewport';
import { DesktopNativeNavigationObserver } from '../../../../../propr-ui/src/desktop/DesktopNativeNavigationObserver';
import type { MenuItemConstructorOptions } from 'electron';
import { createApplicationMenuPopup, createApplicationMenuTemplate } from '../../../src/application-menu';
import { createDesktopNativeCommandDispatcher } from '../../../src/native-commands';
import { createDesktopBridge } from '../../../src/preload-bridge';
import { IPC_CHANNELS, isDesktopApplicationMenuRequest, isDesktopNativeNavigationState } from '../../../src/shared/contract';
import { ToastProvider } from '../../../../../propr-ui/src/components/ui/Toast';
import { AuthProvider } from '../../../../../propr-ui/src/contexts/AuthContext';
import { NotificationCenterProvider } from '../../../../../propr-ui/src/contexts/NotificationCenterContext';
import { SocketContext } from '../../../../../propr-ui/src/contexts/SocketContext';
import { createInertSocketContextValue } from '../../../../../propr-ui/src/test/socketContext';
import type { DesktopAdapters } from '../../../../../propr-ui/src/desktop/types';
import { createElectronDesktopAdapters } from '../../../../../propr-ui/src/desktop/electronAdapters';
import { DesktopDeepLinkInbox } from '../../../../../propr-ui/src/desktop-deep-link';
import { setDesktopConnectionScope } from '../../../../../propr-ui/src/api/apiClient';

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
// Stand-in for main's Menu.popup: records the production template and options
// so the test can choose an item. Chromium does not render native OS menus.
let popup: { template: MenuItemConstructorOptions[]; options: Record<string, unknown> } | null = null;
const popupWindow = {
  isDestroyed: () => false,
  getContentSize: () => [window.innerWidth, window.innerHeight],
  webContents: { getZoomFactor: () => 1 },
};
const applicationMenuPopup = createApplicationMenuPopup<typeof popupWindow>({
  buildFromTemplate: template => ({ popup: options => { popup = { template, options: { ...options, window: undefined } }; } }),
}, dispatcher, process.platform);
const bridge = createDesktopBridge({
  on: (channel, listener) => { listeners.set(channel, listener); },
  removeListener: channel => { listeners.delete(channel); },
  invoke: async (channel, value) => {
    if (channel === IPC_CHANNELS.deepLinkConsumerReady) return { pendingConnect: false };
    if (channel === IPC_CHANNELS.nativeNavigationState && isDesktopNativeNavigationState(value)) dispatcher.updateNavigationState?.(value);
    if (channel === IPC_CHANNELS.applicationMenuPopup) {
      if (!isDesktopApplicationMenuRequest(value)) throw new Error('Invalid application menu request');
      applicationMenuPopup.show(popupWindow, value);
    }
  },
});
dispatcher.rendererReady();
/** Every leaf the template shows, with the accelerator beside it (Electron fills role defaults). */
const shortcutRows = (template: MenuItemConstructorOptions[]) => template.flatMap(menu => (menu.submenu as MenuItemConstructorOptions[])
  .filter(item => item.type !== 'separator')
  .map(item => ({ menu: menu.label, label: item.label ?? null, role: item.role ?? null, accelerator: item.accelerator ?? null, enabled: item.enabled !== false })));
Object.assign(window, { nativeMenu: {
  click(label: string, platform: NodeJS.Platform) {
    const item = createApplicationMenuTemplate(platform, dispatcher).flatMap(item => Array.isArray(item.submenu) ? item.submenu : []).find(item => item.label === label);
    if (!item || item.enabled === false) throw new Error(`Unavailable menu item: ${label}`);
    (item.click as () => void)();
  },
  popup: () => popup && {
    menus: popup.template.map(item => item.label),
    roles: popup.template.flatMap(item => Array.isArray(item.submenu) ? item.submenu : []).flatMap(item => item.role ? [item.role] : []),
    x: popup.options.x, y: popup.options.y, sourceType: popup.options.sourceType,
    file: (popup.template.find(item => item.label === 'File')?.submenu as MenuItemConstructorOptions[])
      .flatMap(item => item.label ? [{ label: item.label, accelerator: item.accelerator ?? null }] : []),
    shortcuts: shortcutRows(popup.template),
  },
  shortcuts: (platform: NodeJS.Platform) => shortcutRows(createApplicationMenuTemplate(platform, dispatcher)),
  choose(label: string) {
    const item = popup?.template.flatMap(item => Array.isArray(item.submenu) ? item.submenu : []).find(item => item.label === label);
    if (!item || item.enabled === false) throw new Error(`Unavailable popup item: ${label}`);
    (popup!.options.callback as () => void)();
    popup = null;
    (item.click as () => void)();
  },
  dismiss() {
    (popup?.options.callback as (() => void) | undefined)?.();
    popup = null;
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
  connection: {
    probe: async () => { dispatcher.connectionAvailable(); return { status: 'ready', version: '0.8.15', ...scope }; },
    // As the production adapter: renderer requests (and so Search) are bound to the active instance.
    publishActivation: (active, result) => setDesktopConnectionScope({ bridge, profileId: active.id, transportScope: result.transportScope! }, active.baseUrl),
  },
  discovery: { supported: false, discover: async () => [] },
  localSetup: { supported: true },
  authentication: { authenticate: async () => undefined },
  externalBrowser: { open: async () => undefined },
};

// Register the presentation consumer so the preload startup handshake completes.
const deepLinks = new DesktopDeepLinkInbox();
adapters.app.onDeepLink(value => deepLinks.receive(value));

// Built from the shared inert value so the fixture cannot drift from the
// context it stands in for: this one is typechecked with propr-ui.
const socket = createInertSocketContextValue({ isConnected: true });

createRoot(document.getElementById('root')!).render(
  <DesktopExperience adapters={adapters} deepLinks={deepLinks}>
    {/* The production app frame: its height decides whether `.desktop-app` overflows. */}
    <AppViewport>
    <HashRouter><DesktopNativeNavigationObserver />
      <SocketContext.Provider value={socket}>
        <ToastProvider>
          <AuthProvider user={{ id: 'frame-user', login: 'frame-user', username: 'frame-user', displayName: 'Frame Test', email: null, avatarUrl: null, role: 'member', permissions: [], authorizationSource: 'local' }}>
            <NotificationCenterProvider>
              <Layout><Routes><Route path="/studio/new" element={<PlanStudioPage isNew />} /><Route path="/tasks/new" element={<NewTaskPage />} /><Route path="/goals" element={<GoalsPage />} /><Route path="/automations/new" element={<AgentsPage isNew />} /><Route path="*" element={<div className="p-6">Desktop menu test workspace</div>} /></Routes></Layout>
            </NotificationCenterProvider>
          </AuthProvider>
        </ToastProvider>
      </SocketContext.Provider>
    </HashRouter>
    </AppViewport>
  </DesktopExperience>,
);
