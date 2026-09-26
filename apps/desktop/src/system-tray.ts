import type { Menu, MenuItemConstructorOptions, NativeImage, Tray } from 'electron';
import type { DesktopActiveWorkFetchResult } from './credential-service';
import type { DesktopNativeCommandDispatcher } from './native-commands';

const MAX_RESPONSE_BYTES = 4_096;
const MAX_ACTIVE_WORK_COUNT = 1_000_000;
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_MINIMUM_REFRESH_INTERVAL_MS = 2_000;

export interface ActiveWorkCounts {
  tasks: number;
  plans: number;
  goals: number | null;
  openGoals: number;
  total: number;
}

interface DesktopTrayOptions {
  platform: NodeJS.Platform;
  icon: NativeImage;
  createTray(icon: NativeImage): Tray;
  buildMenu(template: MenuItemConstructorOptions[]): Menu;
  setBadgeCount(count: number): boolean;
  fetchActiveWork(signal: AbortSignal): Promise<DesktopActiveWorkFetchResult>;
  commands: Pick<DesktopNativeCommandDispatcher, 'dispatch' | 'getState' | 'subscribe'>;
  log(level: 'info' | 'warn', event: string, fields?: Record<string, unknown>): void;
  pollIntervalMs?: number;
  debounceMs?: number;
  minimumRefreshIntervalMs?: number;
}

export interface DesktopTrayController {
  start(): void;
  connectionAvailable(): void;
  connectionUnavailable(reason?: 'disconnected' | 'logged-out' | 'revoked' | 'profile-changed'): void;
  refresh(): void;
  close(): void;
}

type TrayState =
  | { status: 'unavailable'; detail: string }
  | { status: 'checking' }
  | { status: 'ready'; counts: ActiveWorkCounts };

const isCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_ACTIVE_WORK_COUNT;

export const parseActiveWorkSnapshot = (value: unknown): ActiveWorkCounts | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const snapshot = value as Record<string, unknown>;
  if ((snapshot.schemaVersion !== 2 && snapshot.schemaVersion !== 3) || snapshot.label !== 'Active work'
    || typeof snapshot.definition !== 'string' || !snapshot.counts
    || typeof snapshot.counts !== 'object' || Array.isArray(snapshot.counts)) return null;
  if (!snapshot.availability || typeof snapshot.availability !== 'object'
    || Array.isArray(snapshot.availability)) return null;
  const availability = snapshot.availability as Record<string, unknown>;
  if (availability.tasks !== 'available' || availability.plans !== 'available'
    || availability.openGoals !== 'available') return null;
  const counts = snapshot.counts as Record<string, unknown>;
  if (!isCount(counts.tasks) || !isCount(counts.plans) || !isCount(counts.openGoals)
    || !isCount(counts.total)) return null;
  let goals: number | null;
  if (snapshot.schemaVersion === 2) {
    if (availability.goals !== 'unsupported' || counts.goals !== null) return null;
    goals = null;
  } else {
    if (availability.goals !== 'available' || !isCount(counts.goals)) return null;
    goals = counts.goals;
  }
  if (counts.total !== counts.tasks + counts.plans + (goals ?? 0)) return null;
  return {
    tasks: counts.tasks,
    plans: counts.plans,
    goals,
    openGoals: counts.openGoals,
    total: counts.total,
  };
};

export const formatTrayCount = (count: number): string => count > 99 ? '99+' : String(count);

const readBoundedJson = async (response: Response): Promise<unknown> => {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') throw new Error('Active work response is not JSON');
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null
    && (!/^(?:0|[1-9]\d*)$/.test(declaredLength) || Number(declaredLength) > MAX_RESPONSE_BYTES)) {
    throw new Error('Active work response is oversized');
  }
  if (!response.body) throw new Error('Active work response has no body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('Active work response is oversized');
      }
      chunks.push(part.value);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* An invalid stream may retain its lock. */ }
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
};

const unavailableDetail = (reason: Parameters<DesktopTrayController['connectionUnavailable']>[0]): string => {
  if (reason === 'logged-out') return 'Signed out';
  if (reason === 'revoked') return 'Access revoked';
  if (reason === 'profile-changed') return 'Instance changed';
  return 'Offline or not connected';
};

const linuxAboutAndHelpItems = (
  commands: Pick<DesktopNativeCommandDispatcher, 'dispatch'>,
): MenuItemConstructorOptions[] => [
  { type: 'separator' },
  { label: 'About ProPR', click: () => commands.dispatch('about') },
  {
    label: 'Help',
    submenu: [
      { label: 'ProPR Website', click: () => commands.dispatch('website') },
      { label: 'Documentation', click: () => commands.dispatch('documentation') },
      { label: 'Connection Help', click: () => commands.dispatch('connection-help') },
    ],
  },
];

export const createDesktopTrayController = (options: DesktopTrayOptions): DesktopTrayController => {
  const supported = options.platform === 'darwin' || options.platform === 'linux';
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const debounceMs = options.debounceMs ?? 250;
  const minimumRefreshIntervalMs = options.minimumRefreshIntervalMs ?? DEFAULT_MINIMUM_REFRESH_INTERVAL_MS;
  let tray: Tray | null = null;
  let state: TrayState = { status: 'unavailable', detail: 'Offline or not connected' };
  let connected = false;
  let closed = false;
  let generation = 0;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let requestController: AbortController | undefined;
  let requestInFlight = false;
  let refreshAfterFlight = false;
  let lastRefreshStartedAt = 0;
  let unsubscribeCommands: (() => void) | undefined;
  let contextMenu: Menu | null = null;

  const render = (): void => {
    if (!tray || tray.isDestroyed()) return;
    let template: MenuItemConstructorOptions[];
    if (state.status === 'ready') {
      const { counts } = state;
      const exact = (count: number): string => count.toLocaleString('en-US');
      const goalsDetail = counts.goals === null ? 'Goals unsupported' : `Goals ${exact(counts.goals)}`;
      tray.setToolTip(`ProPR — Active work: ${exact(counts.total)} — Tasks ${exact(counts.tasks)}, Plans ${exact(counts.plans)}, ${goalsDetail}; Goal backlog ${exact(counts.openGoals)} (not executing)`);
      if (options.platform === 'darwin') tray.setTitle(formatTrayCount(counts.total));
      options.setBadgeCount(counts.total);
      const commandState = options.commands.getState();
      template = [
        { label: 'Open ProPR', click: () => options.commands.dispatch('open') },
        { label: 'New Plan', enabled: commandState.authenticated, click: () => options.commands.dispatch('new-plan') },
        { type: 'separator' },
        { label: `Tasks: ${exact(counts.tasks)}`, enabled: commandState.authenticated, click: () => options.commands.dispatch('tasks') },
        { label: `Plans: ${exact(counts.plans)}`, enabled: commandState.authenticated, click: () => options.commands.dispatch('plans') },
        { label: 'Inbox', enabled: commandState.authenticated, click: () => options.commands.dispatch('inbox') },
        counts.goals === null
          ? { label: 'Goals: Unsupported (server upgrade required)', enabled: false }
          : { label: `Goals: ${exact(counts.goals)}`, enabled: commandState.authenticated, click: () => options.commands.dispatch('goals') },
        { label: `Goal backlog (not executing): ${exact(counts.openGoals)}`, enabled: false },
        { type: 'separator' },
        { label: 'Switch / Manage Instances…', click: () => options.commands.dispatch('manage-instances') },
        { label: 'Notification Settings…', enabled: commandState.authenticated, click: () => options.commands.dispatch('notification-settings') },
        {
          label: commandState.nativeNotificationsEnabled
            ? 'Pause Native Notifications' : 'Resume Native Notifications',
          type: 'checkbox',
          checked: commandState.nativeNotificationsEnabled,
          enabled: commandState.nativeNotificationsAvailable,
          click: () => options.commands.dispatch('toggle-native-notifications'),
        },
        ...(options.platform === 'linux' ? linuxAboutAndHelpItems(options.commands) : []),
        { type: 'separator' },
        { label: 'Quit ProPR', click: () => options.commands.dispatch('quit') },
      ];
    } else {
      const detail = state.status === 'checking' ? 'Checking active work…' : state.detail;
      tray.setToolTip(`ProPR — Active work unavailable — ${detail}`);
      if (options.platform === 'darwin') tray.setTitle('');
      options.setBadgeCount(0);
      const commandState = options.commands.getState();
      template = [
        { label: 'Open ProPR', click: () => options.commands.dispatch('open') },
        { label: 'New Plan', enabled: commandState.authenticated, click: () => options.commands.dispatch('new-plan') },
        { label: 'Tasks', enabled: commandState.authenticated, click: () => options.commands.dispatch('tasks') },
        { label: 'Plans', enabled: commandState.authenticated, click: () => options.commands.dispatch('plans') },
        { label: 'Inbox', enabled: commandState.authenticated, click: () => options.commands.dispatch('inbox') },
        { type: 'separator' },
        { label: 'Active work: Unavailable', enabled: false },
        { label: detail, enabled: false },
        { type: 'separator' },
        { label: 'Switch / Manage Instances…', click: () => options.commands.dispatch('manage-instances') },
        { label: 'Notification Settings…', enabled: commandState.authenticated, click: () => options.commands.dispatch('notification-settings') },
        {
          label: commandState.nativeNotificationsEnabled
            ? 'Pause Native Notifications' : 'Resume Native Notifications',
          type: 'checkbox',
          checked: commandState.nativeNotificationsEnabled,
          enabled: commandState.nativeNotificationsAvailable,
          click: () => options.commands.dispatch('toggle-native-notifications'),
        },
        ...(options.platform === 'linux' ? linuxAboutAndHelpItems(options.commands) : []),
        { type: 'separator' },
        { label: 'Quit ProPR', click: () => options.commands.dispatch('quit') },
      ];
    }
    contextMenu = options.buildMenu(template);
    tray.setContextMenu(contextMenu);
  };

  const updateUnavailable = (detail: string): void => {
    state = { status: 'unavailable', detail };
    render();
  };

  const runRefresh = async (): Promise<void> => {
    if (!connected || closed || requestInFlight) {
      if (requestInFlight && connected && !closed) refreshAfterFlight = true;
      return;
    }
    const requestGeneration = generation;
    requestInFlight = true;
    lastRefreshStartedAt = Date.now();
    requestController = new AbortController();
    try {
      const result = await options.fetchActiveWork(requestController.signal);
      if (closed || !connected || requestGeneration !== generation) return;
      if (result.status !== 'response') {
        updateUnavailable(result.status === 'stale' ? 'Instance changed' : 'Offline or not connected');
        return;
      }
      if (!result.response.ok) {
        updateUnavailable(result.response.status === 401 || result.response.status === 403
          ? 'Access unavailable' : 'Instance unavailable');
        return;
      }
      const counts = parseActiveWorkSnapshot(await readBoundedJson(result.response));
      if (!counts) throw new Error('Active work response is invalid');
      if (closed || !connected || requestGeneration !== generation) return;
      state = { status: 'ready', counts };
      render();
    } catch {
      if (!closed && connected && requestGeneration === generation) updateUnavailable('Instance unavailable');
    } finally {
      requestInFlight = false;
      requestController = undefined;
      if (refreshAfterFlight && !closed && connected) {
        refreshAfterFlight = false;
        void runRefresh();
      }
    }
  };

  const scheduleRefresh = (delay = debounceMs): void => {
    if (!connected || closed) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    const cooldown = Math.max(0, lastRefreshStartedAt + minimumRefreshIntervalMs - Date.now());
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      void runRefresh();
    }, Math.max(delay, cooldown));
  };

  return {
    start() {
      if (!supported || closed || tray) return;
      try {
        tray = options.createTray(options.icon);
        tray.on('click', () => {
          if (!tray || tray.isDestroyed()) return;
          if (options.platform === 'linux') {
            options.commands.dispatch('open');
          } else if (contextMenu) {
            tray.popUpContextMenu(contextMenu);
          }
        });
        unsubscribeCommands = options.commands.subscribe(render);
        render();
        pollTimer = setInterval(() => scheduleRefresh(0), pollIntervalMs);
        pollTimer.unref();
        options.log('info', 'desktop.tray.ready', { platform: options.platform });
      } catch {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = undefined;
        if (tray) {
          try { tray.destroy(); } catch { /* Initialization already failed; allow a clean retry. */ }
        }
        tray = null;
        unsubscribeCommands?.();
        unsubscribeCommands = undefined;
        options.log('warn', 'desktop.tray.unavailable', { platform: options.platform });
      }
    },
    connectionAvailable() {
      if (closed) return;
      connected = true;
      generation += 1;
      requestController?.abort();
      state = { status: 'checking' };
      render();
      scheduleRefresh(0);
    },
    connectionUnavailable(reason = 'disconnected') {
      connected = false;
      generation += 1;
      requestController?.abort();
      refreshAfterFlight = false;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = undefined;
      updateUnavailable(unavailableDetail(reason));
    },
    refresh() {
      scheduleRefresh();
    },
    close() {
      if (closed) return;
      closed = true;
      connected = false;
      generation += 1;
      requestController?.abort();
      if (pollTimer) clearInterval(pollTimer);
      if (debounceTimer) clearTimeout(debounceTimer);
      pollTimer = undefined;
      debounceTimer = undefined;
      options.setBadgeCount(0);
      if (tray && !tray.isDestroyed()) tray.destroy();
      tray = null;
      contextMenu = null;
      unsubscribeCommands?.();
      unsubscribeCommands = undefined;
      options.log('info', 'desktop.tray.closed');
    },
  };
};
