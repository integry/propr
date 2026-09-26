import type {
  DesktopConnectionScope,
  DesktopNativeCommand,
  DesktopNativeCommandDelivery,
  DesktopNotificationScope,
  DesktopNativeNavigationState,
} from './shared/contract';

export const DESKTOP_HELP_URLS = {
  website: 'https://propr.dev',
  documentation: 'https://docs.propr.dev',
  'connection-help': 'https://docs.propr.dev/docs/operations/desktop-application',
  'report-problem': 'https://github.com/integry/propr/issues/new',
} as const;
const isHelpCommand = (command: string): command is keyof typeof DESKTOP_HELP_URLS =>
  Object.prototype.hasOwnProperty.call(DESKTOP_HELP_URLS, command);

export type DesktopMainCommand = DesktopNativeCommand | 'open' | 'toggle-native-notifications' | 'about' | keyof typeof DESKTOP_HELP_URLS;

export interface DesktopNativeCommandState {
  authenticated: boolean;
  canManageInstances?: boolean;
  canGoBack?: boolean;
  canGoForward?: boolean;
  nativeNotificationsAvailable: boolean;
  nativeNotificationsEnabled: boolean;
}

interface CommandWindow {
  isDestroyed(): boolean;
  webContents: { send(channel: string, value: DesktopNativeCommandDelivery): void };
}

interface DesktopNativeCommandDispatcherOptions {
  channel: string;
  getWindow(): CommandWindow | null;
  restoreWindow(): void;
  activeConnectionScope(): DesktopConnectionScope | null;
  activeNotificationScope(): DesktopNotificationScope | null;
  notificationState(): { available: boolean; enabled: boolean };
  setNativeNotificationsEnabled(scope: DesktopNotificationScope, enabled: boolean): Promise<void>;
  quit(): void;
  showAbout?(): void;
  openExternal?(url: string): Promise<void>;
  log?(level: 'warn', event: string): void;
}

export interface DesktopNativeCommandDispatcher {
  dispatch(command: DesktopMainCommand): void;
  getState(): DesktopNativeCommandState;
  rendererReady(window?: CommandWindow): void;
  rendererUnavailable(): void;
  connectionAvailable(): void;
  connectionUnavailable(): void;
  updateNavigationState?(state: DesktopNativeNavigationState): void;
  refresh(): void;
  subscribe(listener: () => void): () => void;
  close(): void;
}

const AUTHENTICATED_COMMANDS = new Set<DesktopNativeCommand>([
  'new-task', 'search', 'toggle-sidebar', 'new-plan', 'tasks', 'plans', 'inbox', 'notification-settings',
  'dashboard', 'goals', 'repositories', 'llm-logs', 'settings', 'back', 'forward',
]);

const sameConnectionScope = (
  left: DesktopConnectionScope | null,
  right: DesktopConnectionScope | null,
): boolean => left === null || right === null
  ? left === right
  : left.profileId === right.profileId && left.transportScope === right.transportScope;

const sameNotificationScope = (
  left: DesktopNotificationScope | null,
  right: DesktopNotificationScope | null,
): boolean => sameConnectionScope(left, right)
  && (left === null || right === null || left.userId === right.userId);

/**
 * The single native action boundary. It accepts only a closed command union,
 * binds queued navigation to the active connection, and never evaluates a URL
 * or renderer-provided command.
 */
export const createDesktopNativeCommandDispatcher = (
  options: DesktopNativeCommandDispatcherOptions,
): DesktopNativeCommandDispatcher => {
  const listeners = new Set<() => void>();
  let ready = false;
  let closed = false;
  let connectionAvailable = false;
  let readyWindow: CommandWindow | null = null;
  let pending: DesktopNativeCommandDelivery | null = null;
  let notificationToggleTail: Promise<void> = Promise.resolve();
  let connectionGeneration = 0;
  let navigation: DesktopNativeNavigationState | null = null;

  const state = (): DesktopNativeCommandState => {
    const activeScope = options.activeConnectionScope();
    const authenticated = connectionAvailable && activeScope !== null
      && (!navigation || sameConnectionScope(navigation.connectionScope, activeScope));
    const notifications = options.notificationState();
    return {
      authenticated,
      canManageInstances: navigation?.canManageInstances ?? true,
      canGoBack: authenticated && navigation?.canGoBack === true,
      canGoForward: authenticated && navigation?.canGoForward === true,
      nativeNotificationsAvailable: authenticated && notifications.available,
      nativeNotificationsEnabled: authenticated && notifications.available && notifications.enabled,
    };
  };

  const notify = (): void => listeners.forEach(listener => listener());

  const deliver = (command: DesktopNativeCommand, connectionScope: DesktopConnectionScope | null): void => {
    const window = readyWindow && !readyWindow.isDestroyed() ? readyWindow : options.getWindow();
    if (!ready || !window || window.isDestroyed()) {
      pending = { command, connectionScope };
      return;
    }
    if (AUTHENTICATED_COMMANDS.has(command)
      && (!state().authenticated
        || !sameConnectionScope(connectionScope, options.activeConnectionScope()))) return;
    window.webContents.send(options.channel, {
      command,
      connectionScope: connectionScope ? { ...connectionScope } : null,
    });
  };

  return {
    dispatch(command) {
      if (closed) return;
      if (command === 'about') {
        options.showAbout?.();
        return;
      }
      if (isHelpCommand(command)) {
        void options.openExternal?.(DESKTOP_HELP_URLS[command])
          .catch(() => options.log?.('warn', 'desktop.native_command.external_open_failed'));
        return;
      }
      if (command === 'open') {
        options.restoreWindow();
        return;
      }
      if (command === 'toggle-native-notifications') {
        const current = state();
        if (!current.nativeNotificationsAvailable) return;
        const notificationScope = options.activeNotificationScope();
        if (!notificationScope) return;
        const generation = connectionGeneration;
        notificationToggleTail = notificationToggleTail.then(async () => {
          if (closed || generation !== connectionGeneration
            || !sameNotificationScope(notificationScope, options.activeNotificationScope())) return;
          const latest = state();
          if (!latest.nativeNotificationsAvailable) return;
          await options.setNativeNotificationsEnabled(
            notificationScope,
            !latest.nativeNotificationsEnabled,
          );
        })
          .catch(() => options.log?.('warn', 'desktop.native_command.notifications_update_failed'))
          .finally(() => { if (!closed) notify(); });
        return;
      }

      if ((command === 'manage-instances' || command === 'connect-instance') && !state().canManageInstances) return;
      if (command === 'back' && !state().canGoBack) return;
      if (command === 'forward' && !state().canGoForward) return;
      const activeConnection = options.activeConnectionScope();
      const connection = activeConnection ? { ...activeConnection } : null;
      if (AUTHENTICATED_COMMANDS.has(command) && !state().authenticated) return;
      options.restoreWindow();
      deliver(command, connection);
    },
    getState: state,
    rendererReady(window) {
      if (closed) return;
      ready = true;
      readyWindow = window ?? options.getWindow();
      const queued = pending;
      pending = null;
      if (queued) deliver(queued.command, queued.connectionScope);
    },
    rendererUnavailable() {
      navigation = null;
      notify();
      ready = false;
      readyWindow = null;
    },
    connectionAvailable() {
      if (closed) return;
      connectionAvailable = true;
      notify();
    },
    connectionUnavailable() {
      connectionAvailable = false;
      navigation = null;
      connectionGeneration += 1;
      if (pending && AUTHENTICATED_COMMANDS.has(pending.command)) pending = null;
      notify();
    },
    updateNavigationState(value) {
      if (closed || (value.connectionScope && !sameConnectionScope(value.connectionScope, options.activeConnectionScope()))) return;
      navigation = { ...value, connectionScope: value.connectionScope ? { ...value.connectionScope } : null };
      notify();
    },
    refresh: notify,
    subscribe(listener) {
      if (closed) return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      if (closed) return;
      closed = true;
      connectionGeneration += 1;
      ready = false;
      readyWindow = null;
      pending = null;
      listeners.clear();
    },
  };
};
