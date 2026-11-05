import type { Menu, MenuItemConstructorOptions, PopupOptions } from 'electron';
import type { DesktopNativeCommandDispatcher } from './native-commands';
import type { DesktopApplicationMenuRequest } from './shared/contract';
import { applicationMenuShortcut, NATIVE_ROLE_SHORTCUTS, type ApplicationMenuCommand, type ApplicationMenuPlatform } from './application-menu-shortcuts';

interface ApplicationMenuHost {
  buildFromTemplate(template: MenuItemConstructorOptions[]): Menu;
  setApplicationMenu(menu: Menu | null): void;
}

export interface ApplicationMenuController {
  close(): void;
}

/**
 * File-menu creation entries, in toolbar order, with the bindings from #3168.
 * The full binding table and its conflict notes are in application-menu-shortcuts.
 */
export const CREATION_MENU_ITEMS = Object.freeze(([
  ['new-task', 'New Task'], ['new-plan', 'New Plan'], ['new-goal', 'New Goal'],
  ['new-automation', 'New Automation'], ['new-todo', 'New To-do'],
] as const).map(([command, label]) => ({ command, label, accelerator: applicationMenuShortcut('linux', command) })));

export const createApplicationMenuTemplate = (
  platform: NodeJS.Platform,
  commands: DesktopNativeCommandDispatcher,
): MenuItemConstructorOptions[] => {
  const mac = platform === 'darwin';
  const shortcutPlatform: ApplicationMenuPlatform = mac ? 'darwin' : 'linux';
  // Every command item shows and executes its binding; disabled items keep
  // showing it but Electron does not run their click.
  const commandItem = (command: ApplicationMenuCommand, label: string, enabled = true): MenuItemConstructorOptions => ({
    label,
    accelerator: applicationMenuShortcut(shortcutPlatform, command),
    enabled,
    click: () => commands.dispatch(command),
  });
  const state = commands.getState();
  const authenticated = state.authenticated;
  const editMenu: MenuItemConstructorOptions = {
    label: 'Edit',
    submenu: [
      { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
      ...(platform === 'darwin' ? [{ role: 'pasteAndMatchStyle' as const }] : []),
      { role: 'selectAll' },
    ],
  };
  const viewMenu: MenuItemConstructorOptions = {
    label: 'View',
    submenu: [
      commandItem('toggle-sidebar', 'Toggle Sidebar', authenticated),
      { type: 'separator' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      { type: 'separator' }, { role: 'togglefullscreen' },
    ],
  };

  return [
    {
      label: 'ProPR',
      submenu: [
        commandItem('about', 'About ProPR'),
        { type: 'separator' },
        commandItem('settings', 'Settings…', authenticated),
        ...(mac ? [
          { type: 'separator' as const }, { role: 'services' as const },
          { type: 'separator' as const }, { role: 'hide' as const, label: 'Hide ProPR' },
          { role: 'hideOthers' as const }, { role: 'unhide' as const, accelerator: NATIVE_ROLE_SHORTCUTS.unhide },
        ] : []),
        { type: 'separator' }, commandItem('quit', 'Quit ProPR'),
      ],
    },
    {
      label: 'File',
      submenu: [
        ...CREATION_MENU_ITEMS.map(item => commandItem(item.command, item.label, authenticated)),
        { type: 'separator' },
        commandItem('connect-instance', 'Connect Instance…', state.canManageInstances !== false),
        commandItem('manage-instances', 'Switch Account / Instance…', state.canManageInstances !== false),
        { type: 'separator' }, { role: 'close' },
      ],
    },
    editMenu,
    viewMenu,
    {
      label: 'Navigate',
      submenu: [
        commandItem('back', 'Back', state.canGoBack === true),
        commandItem('forward', 'Forward', state.canGoForward === true),
        commandItem('search', 'Search / Go To…', authenticated),
        { type: 'separator' },
        commandItem('dashboard', 'Dashboard', authenticated),
        commandItem('inbox', 'Inbox', authenticated),
        commandItem('plans', 'Plans', authenticated),
        commandItem('goals', 'Goals', authenticated),
        commandItem('tasks', 'Tasks', authenticated),
        commandItem('repositories', 'Repositories', authenticated),
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        ...(mac ? [
          { role: 'zoom' as const, accelerator: NATIVE_ROLE_SHORTCUTS.zoom },
          { type: 'separator' as const }, { role: 'front' as const, accelerator: NATIVE_ROLE_SHORTCUTS.front },
        ] : []),
      ],
    },
    {
      label: 'Help',
      submenu: [
        commandItem('website', 'ProPR Website'),
        commandItem('documentation', 'Documentation'),
        commandItem('connection-help', 'Connection Help'),
        commandItem('diagnostics', 'Connection Diagnostics…'),
        { type: 'separator' },
        commandItem('report-problem', 'Report a Problem…'),
      ],
    },
  ];
};

export const configureApplicationMenu = (
  host: ApplicationMenuHost,
  commands: DesktopNativeCommandDispatcher,
  platform: NodeJS.Platform = process.platform,
): ApplicationMenuController => {
  if (platform !== 'darwin' && platform !== 'linux') {
    return { close: () => undefined };
  }
  let closed = false;
  const render = (): void => {
    if (!closed) host.setApplicationMenu(host.buildFromTemplate(createApplicationMenuTemplate(platform, commands)));
  };
  const unsubscribe = commands.subscribe(render);
  render();
  return {
    close() {
      if (closed) return;
      closed = true;
      unsubscribe();
    },
  };
};

export interface ApplicationMenuPopupWindow {
  isDestroyed(): boolean;
  getContentSize(): number[];
  webContents: { getZoomFactor(): number };
}

interface ApplicationMenuPopupHost<W extends ApplicationMenuPopupWindow> {
  buildFromTemplate(template: MenuItemConstructorOptions[]): {
    popup(options: Omit<PopupOptions, 'window'> & { window: W }): void;
  };
}

export interface ApplicationMenuPopup<W extends ApplicationMenuPopupWindow> {
  /** Returns once the popup is requested; it never waits for the user. */
  show(window: W, request: DesktopApplicationMenuRequest): void;
}

const clamp = (value: number, maximum: number): number => Math.min(Math.max(0, Math.round(value)), Math.max(0, maximum));

/**
 * Linux frameless windows hide the native menubar, so a visible renderer
 * control pops up the same template and dispatcher. The renderer supplies only
 * a bounded anchor; commands, enablement and roles remain main-owned.
 */
export const createApplicationMenuPopup = <W extends ApplicationMenuPopupWindow>(
  host: ApplicationMenuPopupHost<W>,
  commands: DesktopNativeCommandDispatcher,
  platform: NodeJS.Platform = process.platform,
): ApplicationMenuPopup<W> => {
  let open = false;
  return {
    show(window, request) {
      if (platform !== 'linux') throw new Error('The application menu control is Linux-only');
      if (window.isDestroyed()) throw new Error('Application menu window is unavailable');
      if (open) return;
      const zoom = window.webContents.getZoomFactor();
      const [width, height] = window.getContentSize();
      if (!Number.isFinite(zoom) || zoom <= 0 || !Number.isInteger(width) || !Number.isInteger(height)) {
        throw new Error('Application menu window geometry is unavailable');
      }
      open = true;
      try {
        host.buildFromTemplate(createApplicationMenuTemplate(platform, commands)).popup({
          window,
          x: clamp(request.x * zoom, width),
          y: clamp(request.y * zoom, height),
          sourceType: request.source,
          callback: () => { open = false; },
        });
      } catch (error) {
        open = false;
        throw error;
      }
    },
  };
};
