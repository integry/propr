import type { Menu, MenuItemConstructorOptions } from 'electron';
import type { DesktopNativeCommandDispatcher } from './native-commands';

interface ApplicationMenuHost {
  buildFromTemplate(template: MenuItemConstructorOptions[]): Menu;
  setApplicationMenu(menu: Menu | null): void;
}

export interface ApplicationMenuController {
  close(): void;
}

const commandItem = (
  commands: DesktopNativeCommandDispatcher,
  command: Parameters<DesktopNativeCommandDispatcher['dispatch']>[0],
  label: string,
  accelerator: string | undefined,
  enabled = true,
): MenuItemConstructorOptions => ({
  label,
  ...(accelerator ? { accelerator } : {}),
  enabled,
  click: () => commands.dispatch(command),
});

export const createApplicationMenuTemplate = (
  platform: NodeJS.Platform,
  commands: DesktopNativeCommandDispatcher,
): MenuItemConstructorOptions[] => {
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
      commandItem(commands, 'toggle-sidebar', 'Toggle Sidebar', undefined, authenticated),
      { type: 'separator' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      { type: 'separator' }, { role: 'togglefullscreen' },
    ],
  };

  const mac = platform === 'darwin';
  return [
    {
      label: 'ProPR',
      submenu: [
        commandItem(commands, 'about', 'About ProPR', undefined),
        { type: 'separator' },
        commandItem(commands, 'settings', 'Settings…', 'CmdOrCtrl+,', authenticated),
        ...(mac ? [
          { type: 'separator' as const }, { role: 'services' as const },
          { type: 'separator' as const }, { role: 'hide' as const, label: 'Hide ProPR' },
          { role: 'hideOthers' as const }, { role: 'unhide' as const },
        ] : []),
        { type: 'separator' }, commandItem(commands, 'quit', 'Quit ProPR', 'CmdOrCtrl+Q'),
      ],
    },
    {
      label: 'File',
      submenu: [
        commandItem(commands, 'new-plan', 'New Plan', 'CmdOrCtrl+N', authenticated),
        commandItem(commands, 'new-task', 'New Task…', undefined, authenticated),
        { type: 'separator' },
        commandItem(commands, 'connect-instance', 'Connect Instance…', undefined, state.canManageInstances !== false),
        commandItem(commands, 'manage-instances', 'Switch Account / Instance…', 'CmdOrCtrl+Shift+I', state.canManageInstances !== false),
        { type: 'separator' }, { role: 'close' },
      ],
    },
    editMenu,
    viewMenu,
    {
      label: 'Navigate',
      submenu: [
        commandItem(commands, 'back', 'Back', 'CmdOrCtrl+[', state.canGoBack === true),
        commandItem(commands, 'forward', 'Forward', 'CmdOrCtrl+]', state.canGoForward === true),
        commandItem(commands, 'search', 'Search / Go To…', 'CmdOrCtrl+K', authenticated),
        { type: 'separator' },
        commandItem(commands, 'dashboard', 'Dashboard', undefined, authenticated),
        commandItem(commands, 'inbox', 'Inbox', undefined, authenticated),
        commandItem(commands, 'plans', 'Plans', undefined, authenticated),
        commandItem(commands, 'goals', 'Goals', undefined, authenticated),
        commandItem(commands, 'tasks', 'Tasks', undefined, authenticated),
        commandItem(commands, 'repositories', 'Repositories', undefined, authenticated),
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        ...(mac ? [{ role: 'zoom' as const }, { type: 'separator' as const }, { role: 'front' as const }] : []),
      ],
    },
    {
      label: 'Help',
      submenu: [
        commandItem(commands, 'website', 'ProPR Website', undefined),
        commandItem(commands, 'documentation', 'Documentation', undefined),
        commandItem(commands, 'connection-help', 'Connection Help', undefined),
        commandItem(commands, 'diagnostics', 'Connection Diagnostics…', undefined),
        { type: 'separator' },
        commandItem(commands, 'report-problem', 'Report a Problem…', undefined),
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
