import type { DesktopMainCommand } from './native-commands';

export type ApplicationMenuPlatform = 'darwin' | 'linux';
type Binding = string | Readonly<Record<ApplicationMenuPlatform, string>>;

/**
 * Every app-owned application-menu command. `commandItem` accepts only these,
 * and the record below must cover each one, so a new menu command cannot be
 * added without a binding.
 */
export type ApplicationMenuCommand = Extract<DesktopMainCommand,
  | 'about' | 'settings' | 'quit'
  | 'new-task' | 'new-plan' | 'new-goal' | 'new-automation' | 'new-todo' | 'connect-instance' | 'manage-instances'
  | 'toggle-sidebar' | 'back' | 'forward' | 'search'
  | 'dashboard' | 'inbox' | 'plans' | 'goals' | 'tasks' | 'repositories'
  | 'website' | 'documentation' | 'connection-help' | 'diagnostics' | 'report-problem'>;

/**
 * App-owned bindings. CmdOrCtrl is Command on macOS and Control on Linux.
 * Plain CmdOrCtrl+letter opens a destination and CmdOrCtrl+Shift+letter runs
 * an action, so Tasks/New Task share T and Goals/New Goal share G. New Plan
 * keeps CmdOrCtrl+N, and the bindings from #3168 (Shift+T/G/A/D), search (K),
 * instances (Shift+I), settings (,), quit (Q) and navigation ([ ]) are kept.
 * Linux bindings never use Alt (see RESERVED_SHORTCUTS); Toggle Sidebar follows
 * the macOS Show Sidebar convention there.
 */
export const APPLICATION_MENU_SHORTCUTS: Readonly<Record<ApplicationMenuCommand, Binding>> = Object.freeze({
  about: 'CmdOrCtrl+Shift+P',
  settings: 'CmdOrCtrl+,',
  quit: 'CmdOrCtrl+Q',
  'new-task': 'CmdOrCtrl+Shift+T',
  'new-plan': 'CmdOrCtrl+N',
  'new-goal': 'CmdOrCtrl+Shift+G',
  'new-automation': 'CmdOrCtrl+Shift+A',
  'new-todo': 'CmdOrCtrl+Shift+D',
  'connect-instance': 'CmdOrCtrl+Shift+N',
  'manage-instances': 'CmdOrCtrl+Shift+I',
  'toggle-sidebar': { darwin: 'Control+Command+S', linux: 'CmdOrCtrl+B' },
  back: 'CmdOrCtrl+[',
  forward: 'CmdOrCtrl+]',
  search: 'CmdOrCtrl+K',
  dashboard: 'CmdOrCtrl+D',
  inbox: 'CmdOrCtrl+I',
  plans: 'CmdOrCtrl+P',
  goals: 'CmdOrCtrl+G',
  tasks: 'CmdOrCtrl+T',
  repositories: 'CmdOrCtrl+R',
  website: 'CmdOrCtrl+Shift+O',
  documentation: 'CmdOrCtrl+/',
  'connection-help': 'CmdOrCtrl+Shift+H',
  diagnostics: 'CmdOrCtrl+Shift+L',
  'report-problem': 'CmdOrCtrl+Shift+B',
});

/**
 * Electron's default accelerators for the native roles the menu uses (from
 * Electron's menu-item roles), so checks can see what a role item will show.
 * `null` means Electron assigns none; those roles get one from
 * NATIVE_ROLE_SHORTCUTS instead. Services is an OS-populated submenu.
 */
export const NATIVE_ROLE_DEFAULT_SHORTCUTS: Readonly<Record<string, Binding | null>> = Object.freeze({
  undo: 'CommandOrControl+Z',
  redo: 'Shift+CommandOrControl+Z',
  cut: 'CommandOrControl+X',
  copy: 'CommandOrControl+C',
  paste: 'CommandOrControl+V',
  pasteAndMatchStyle: { darwin: 'Cmd+Option+Shift+V', linux: 'Shift+CommandOrControl+V' },
  selectAll: 'CommandOrControl+A',
  resetZoom: 'CommandOrControl+0',
  zoomIn: 'CommandOrControl+Plus',
  zoomOut: 'CommandOrControl+-',
  togglefullscreen: { darwin: 'Control+Command+F', linux: 'F11' },
  minimize: 'CommandOrControl+M',
  close: 'CommandOrControl+W',
  hide: 'Command+H',
  hideOthers: 'Command+Alt+H',
  unhide: null,
  zoom: null,
  front: null,
});

/**
 * macOS-only native roles that have no Electron default. They keep their
 * native role behavior; only the key equivalent is added. Option is safe here
 * because these items exist only on macOS.
 */
export const NATIVE_ROLE_SHORTCUTS = Object.freeze({
  unhide: 'Command+Alt+Shift+H', // Show All, beside Hide (Cmd+H) and Hide Others (Cmd+Option+H)
  zoom: 'Command+Shift+M', // Window → Zoom, beside Minimize (Cmd+M)
  front: 'Command+Alt+Shift+M', // Bring All to Front; Cmd+Option+M stays AppKit's Minimize All
} as const);

/**
 * Chords app-owned bindings must not take. Some of them are claimed by the
 * renderer, the input method or a native role, and some are commonly
 * reserved by the desktop. Desktops and input methods can be reconfigured,
 * so no binding is guaranteed free on every system.
 */
export const RESERVED_SHORTCUTS: Readonly<Record<ApplicationMenuPlatform, ReadonlyArray<readonly [string, string]>>> = Object.freeze({
  linux: [
    ['CmdOrCtrl+Shift+R', 'renderer reconnect'], ['Alt+T', 'renderer quick add'], ['CmdOrCtrl+Enter', 'renderer submit'],
    ['F10', 'application menu'], ['Alt+F', 'application menu'], ['Shift+F10', 'context menu'],
    ['CmdOrCtrl+Shift+U', 'IBus Unicode entry'], ['CmdOrCtrl+Shift+E', 'IBus emoji'],
    ['CmdOrCtrl+.', 'IBus emoji'], ['CmdOrCtrl+;', 'IBus emoji'],
    ['CmdOrCtrl+Shift+C', 'terminal-style copy'], ['CmdOrCtrl+Shift+V', 'paste as plain text'], ['CmdOrCtrl+Y', 'redo convention'],
    ['CmdOrCtrl+=', 'zoom in without Shift'],
    ['Ctrl+Alt+T', 'GNOME/Ubuntu terminal'], ['Ctrl+Alt+Delete', 'log out'], ['Ctrl+Alt+L', 'lock screen'],
    ['Ctrl+Alt+Left', 'switch workspace'], ['Ctrl+Alt+Right', 'switch workspace'],
    ['Ctrl+Alt+Up', 'switch workspace'], ['Ctrl+Alt+Down', 'switch workspace'],
    ['Ctrl+F1', 'KDE desktop 1'], ['Ctrl+F2', 'KDE desktop 2'], ['Ctrl+F3', 'KDE desktop 3'], ['Ctrl+F4', 'KDE desktop 4'],
    ['Alt+F1', 'desktop launcher'], ['Alt+F2', 'run command'], ['Alt+F4', 'close window'], ['Alt+Tab', 'switch windows'],
  ],
  darwin: [
    ['CmdOrCtrl+Shift+R', 'renderer reconnect'], ['Alt+T', 'renderer quick add'], ['CmdOrCtrl+Enter', 'renderer submit'],
    ['CmdOrCtrl+=', 'zoom in without Shift'],
    ['Command+Space', 'Spotlight'], ['Control+Space', 'input source'], ['Command+Tab', 'app switcher'],
    ['Command+`', 'cycle windows'], ['Command+Shift+`', 'cycle windows'],
    ['Command+Shift+3', 'screenshot'], ['Command+Shift+4', 'screenshot'], ['Command+Shift+5', 'screenshot'],
    ['Command+Shift+6', 'Touch Bar screenshot'], ['Command+Shift+Q', 'log out'], ['Control+Command+Q', 'lock screen'],
    ['Command+Alt+Escape', 'force quit'], ['Command+Shift+/', 'Help menu search'], ['Command+.', 'cancel'],
    ['Command+Alt+D', 'toggle Dock'], ['Control+Command+Space', 'emoji & symbols'], ['Control+Command+D', 'look up'],
    ['Command+Alt+M', 'Minimize All'], ['Command+Alt+W', 'Close All'],
  ],
});

/** Resolves a binding for one platform. */
export const resolveShortcut = (platform: ApplicationMenuPlatform, binding: Binding): string =>
  typeof binding === 'string' ? binding : binding[platform];

export const applicationMenuShortcut = (platform: ApplicationMenuPlatform, command: ApplicationMenuCommand): string =>
  resolveShortcut(platform, APPLICATION_MENU_SHORTCUTS[command]);

/** US-layout characters that Electron reaches with Shift, mapped to the unshifted key. */
const SHIFTED_KEYS: Readonly<Record<string, string>> = {
  plus: '=', '+': '=', '?': '/', '<': ',', '>': '.', ':': ';', '"': "'", '{': '[', '}': ']', _: '-', '|': '\\', '~': '`',
  '!': '1', '@': '2', '#': '3', $: '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0',
};
const KEY_ALIASES: Readonly<Record<string, string>> = { return: 'enter', esc: 'escape', space: 'space' };
const MODIFIER_ORDER = ['cmd', 'ctrl', 'alt', 'shift', 'super'];

/**
 * Canonical form of an accelerator on one platform, so equivalent spellings
 * (CmdOrCtrl/CommandOrControl/Command, Control/Ctrl, Alt/Option, Plus and
 * Shift+=, ? and Shift+/) compare equal: e.g. `ctrl+shift+t` on Linux.
 */
export const normalizeAccelerator = (platform: ApplicationMenuPlatform, accelerator: string): string => {
  const tokens = accelerator.replace(/\+\+$/, '+Plus').split('+').map(token => token.trim().toLowerCase());
  const key = tokens.pop() ?? '';
  const modifiers = new Set<string>();
  for (const token of tokens) {
    if (token === 'cmdorctrl' || token === 'commandorcontrol') modifiers.add(platform === 'darwin' ? 'cmd' : 'ctrl');
    else if (token === 'cmd' || token === 'command' || token === 'super' || token === 'meta') modifiers.add(platform === 'darwin' ? 'cmd' : 'super');
    else if (token === 'ctrl' || token === 'control') modifiers.add('ctrl');
    else if (token === 'alt' || token === 'option') modifiers.add('alt');
    else if (token === 'shift') modifiers.add('shift');
    else throw new Error(`Unknown accelerator modifier: ${token}`);
  }
  let normalizedKey = KEY_ALIASES[key] ?? key;
  if (SHIFTED_KEYS[normalizedKey]) {
    normalizedKey = SHIFTED_KEYS[normalizedKey];
    modifiers.add('shift');
  }
  return [...MODIFIER_ORDER.filter(modifier => modifiers.has(modifier)), normalizedKey].join('+');
};
