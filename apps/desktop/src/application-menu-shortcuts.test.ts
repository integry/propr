import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Menu, MenuItemConstructorOptions } from 'electron';
import { configureApplicationMenu, createApplicationMenuPopup, createApplicationMenuTemplate } from './application-menu';
import {
  APPLICATION_MENU_SHORTCUTS,
  NATIVE_ROLE_DEFAULT_SHORTCUTS,
  NATIVE_ROLE_SHORTCUTS,
  RESERVED_SHORTCUTS,
  normalizeAccelerator,
  resolveShortcut,
  type ApplicationMenuCommand,
  type ApplicationMenuPlatform,
} from './application-menu-shortcuts';
import type { DesktopNativeCommandDispatcher } from './native-commands';

const fixture = (overrides: Partial<ReturnType<DesktopNativeCommandDispatcher['getState']>> = {}) => {
  const dispatched: string[] = [];
  const commands = {
    dispatch: (command: string) => { dispatched.push(command); },
    getState: () => ({
      authenticated: true, canManageInstances: true, canGoBack: true, canGoForward: true,
      nativeNotificationsAvailable: true, nativeNotificationsEnabled: false, ...overrides,
    }),
    subscribe: () => () => undefined,
    rendererReady: () => undefined, rendererUnavailable: () => undefined,
    connectionAvailable: () => undefined, connectionUnavailable: () => undefined,
    refresh: () => undefined, close: () => undefined,
  } satisfies DesktopNativeCommandDispatcher;
  return { commands, dispatched };
};

/** Every actionable leaf, recursing into submenus and skipping separators. */
const leaves = (template: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] => template.flatMap(item => {
  if (item.type === 'separator') return [];
  if (Array.isArray(item.submenu)) return leaves(item.submenu);
  return [item];
});

/** OS-populated: macOS fills Services, so it keeps OS-owned behavior. */
const OS_OWNED_ROLES = new Set(['services']);

/** What the native menu shows for an item: its own accelerator, else Electron's role default. */
const effectiveAccelerator = (platform: ApplicationMenuPlatform, item: MenuItemConstructorOptions): string | null => {
  if (item.accelerator) return String(item.accelerator);
  const fallback = item.role ? NATIVE_ROLE_DEFAULT_SHORTCUTS[item.role] : null;
  return fallback ? resolveShortcut(platform, fallback) : null;
};

/** The visible menu: label (or role) and the shortcut shown beside it, by menu. */
const EXPECTED_SHORTCUTS: Record<ApplicationMenuPlatform, Record<string, Array<[string, string]>>> = {
  linux: {
    ProPR: [['About ProPR', 'ctrl+shift+p'], ['Settings…', 'ctrl+,'], ['Quit ProPR', 'ctrl+q']],
    File: [
      ['New Task', 'ctrl+shift+t'], ['New Plan', 'ctrl+n'], ['New Goal', 'ctrl+shift+g'], ['New Automation', 'ctrl+shift+a'],
      ['New To-do', 'ctrl+shift+d'], ['Connect Instance…', 'ctrl+shift+n'], ['Switch Account / Instance…', 'ctrl+shift+i'],
      ['close', 'ctrl+w'],
    ],
    Edit: [['undo', 'ctrl+z'], ['redo', 'ctrl+shift+z'], ['cut', 'ctrl+x'], ['copy', 'ctrl+c'], ['paste', 'ctrl+v'], ['selectAll', 'ctrl+a']],
    View: [['Toggle Sidebar', 'ctrl+b'], ['resetZoom', 'ctrl+0'], ['zoomIn', 'ctrl+shift+='], ['zoomOut', 'ctrl+-'], ['togglefullscreen', 'f11']],
    Navigate: [
      ['Back', 'ctrl+['], ['Forward', 'ctrl+]'], ['Search / Go To…', 'ctrl+k'], ['Dashboard', 'ctrl+d'], ['Inbox', 'ctrl+i'],
      ['Plans', 'ctrl+p'], ['Goals', 'ctrl+g'], ['Tasks', 'ctrl+t'], ['Repositories', 'ctrl+r'],
    ],
    Window: [['minimize', 'ctrl+m']],
    Help: [
      ['ProPR Website', 'ctrl+shift+o'], ['Documentation', 'ctrl+/'], ['Connection Help', 'ctrl+shift+h'],
      ['Connection Diagnostics…', 'ctrl+shift+l'], ['Report a Problem…', 'ctrl+shift+b'],
    ],
  },
  darwin: {
    ProPR: [
      ['About ProPR', 'cmd+shift+p'], ['Settings…', 'cmd+,'], ['Hide ProPR', 'cmd+h'], ['hideOthers', 'cmd+alt+h'],
      ['unhide', 'cmd+alt+shift+h'], ['Quit ProPR', 'cmd+q'],
    ],
    File: [
      ['New Task', 'cmd+shift+t'], ['New Plan', 'cmd+n'], ['New Goal', 'cmd+shift+g'], ['New Automation', 'cmd+shift+a'],
      ['New To-do', 'cmd+shift+d'], ['Connect Instance…', 'cmd+shift+n'], ['Switch Account / Instance…', 'cmd+shift+i'],
      ['close', 'cmd+w'],
    ],
    Edit: [
      ['undo', 'cmd+z'], ['redo', 'cmd+shift+z'], ['cut', 'cmd+x'], ['copy', 'cmd+c'], ['paste', 'cmd+v'],
      ['pasteAndMatchStyle', 'cmd+alt+shift+v'], ['selectAll', 'cmd+a'],
    ],
    View: [['Toggle Sidebar', 'cmd+ctrl+s'], ['resetZoom', 'cmd+0'], ['zoomIn', 'cmd+shift+='], ['zoomOut', 'cmd+-'], ['togglefullscreen', 'cmd+ctrl+f']],
    Navigate: [
      ['Back', 'cmd+['], ['Forward', 'cmd+]'], ['Search / Go To…', 'cmd+k'], ['Dashboard', 'cmd+d'], ['Inbox', 'cmd+i'],
      ['Plans', 'cmd+p'], ['Goals', 'cmd+g'], ['Tasks', 'cmd+t'], ['Repositories', 'cmd+r'],
    ],
    Window: [['minimize', 'cmd+m'], ['zoom', 'cmd+shift+m'], ['front', 'cmd+alt+shift+m']],
    Help: [
      ['ProPR Website', 'cmd+shift+o'], ['Documentation', 'cmd+/'], ['Connection Help', 'cmd+shift+h'],
      ['Connection Diagnostics…', 'cmd+shift+l'], ['Report a Problem…', 'cmd+shift+b'],
    ],
  },
};

describe('application menu shortcuts', () => {
  it('normalizes equivalent accelerator spellings per platform', () => {
    for (const [platform, spellings, expected] of [
      ['linux', ['CmdOrCtrl+Shift+T', 'CommandOrControl+Shift+T', 'Ctrl+Shift+t', 'Shift+Control+T'], 'ctrl+shift+t'],
      ['darwin', ['CmdOrCtrl+Shift+T', 'Command+Shift+T', 'Cmd+Shift+T', 'Shift+Meta+T', 'Super+Shift+T'], 'cmd+shift+t'],
      ['darwin', ['Cmd+Option+Shift+V', 'Shift+Alt+Command+V'], 'cmd+alt+shift+v'],
      ['linux', ['CmdOrCtrl+Plus', 'CmdOrCtrl++', 'Ctrl+Shift+='], 'ctrl+shift+='],
      ['linux', ['CmdOrCtrl+?', 'Ctrl+Shift+/'], 'ctrl+shift+/'],
      ['linux', ['Ctrl+Return', 'CmdOrCtrl+Enter'], 'ctrl+enter'],
    ] as const) {
      for (const spelling of spellings) assert.equal(normalizeAccelerator(platform, spelling), expected, spelling);
    }
    // Command is Super on Linux, not Control.
    assert.notEqual(normalizeAccelerator('linux', 'Command+T'), normalizeAccelerator('linux', 'Ctrl+T'));
    assert.notEqual(normalizeAccelerator('linux', 'CmdOrCtrl+='), normalizeAccelerator('linux', 'CmdOrCtrl+Plus'));
    assert.throws(() => normalizeAccelerator('linux', 'Hyper+T'), /Unknown accelerator modifier/);
  });

  for (const platform of ['linux', 'darwin'] as const) {
    describe(platform, () => {
      const template = createApplicationMenuTemplate(platform, fixture().commands);
      const all = leaves(template);
      const actionable = all.filter(item => !(item.role && OS_OWNED_ROLES.has(item.role)));

      it('shows a shortcut on every actionable leaf, including native roles without a default', () => {
        const missing = actionable.filter(item => !effectiveAccelerator(platform, item)).map(item => item.label ?? item.role);
        assert.deepEqual(missing, []);
        for (const item of all.filter(item => item.role)) {
          assert.ok(Object.hasOwn(NATIVE_ROLE_DEFAULT_SHORTCUTS, item.role!) || OS_OWNED_ROLES.has(item.role!),
            `Record Electron's default accelerator for the ${item.role} role`);
        }
        const visible = Object.fromEntries(template.map(menu => [menu.label, leaves([menu])
          .filter(item => !(item.role && OS_OWNED_ROLES.has(item.role)))
          .map(item => [item.label ?? item.role, normalizeAccelerator(platform, effectiveAccelerator(platform, item)!)])]));
        assert.deepEqual(visible, EXPECTED_SHORTCUTS[platform]);
      });

      it('never binds one chord twice and keeps clear of reserved chords', () => {
        const seen = new Map<string, string>();
        for (const item of actionable) {
          const chord = normalizeAccelerator(platform, effectiveAccelerator(platform, item)!);
          assert.ok(!seen.has(chord), `${item.label ?? item.role} and ${seen.get(chord)} both use ${chord}`);
          seen.set(chord, String(item.label ?? item.role));
        }
        for (const [reserved, reason] of RESERVED_SHORTCUTS[platform]) {
          const chord = normalizeAccelerator(platform, reserved);
          assert.ok(!seen.has(chord), `${seen.get(chord)} uses ${reserved}, reserved for ${reason}`);
        }
      });

      it('keeps Electron role defaults and gives app-owned commands the platform primary modifier', () => {
        for (const item of all.filter(item => item.role)) {
          const assigned = (NATIVE_ROLE_SHORTCUTS as Record<string, string>)[item.role!];
          // A role's own default is never overridden; only roles without one are assigned.
          assert.equal(item.accelerator, assigned, `${item.role} accelerator`);
          if (assigned) assert.equal(NATIVE_ROLE_DEFAULT_SHORTCUTS[item.role!], null);
        }
        for (const item of all.filter(item => !item.role)) {
          const chord = normalizeAccelerator(platform, String(item.accelerator)).split('+');
          assert.ok(chord.includes(platform === 'darwin' ? 'cmd' : 'ctrl'), `${item.label} uses ${chord.join('+')}`);
          if (platform === 'linux') assert.ok(!chord.includes('alt') && !chord.includes('super'), `${item.label} uses Alt or Super on Linux`);
        }
      });

      it('binds each command once, to the same dispatch as choosing the item', () => {
        const value = fixture();
        const items = leaves(createApplicationMenuTemplate(platform, value.commands)).filter(item => !item.role);
        assert.deepEqual(items.length, Object.keys(APPLICATION_MENU_SHORTCUTS).length);
        for (const [command, binding] of Object.entries(APPLICATION_MENU_SHORTCUTS) as Array<[ApplicationMenuCommand, never]>) {
          const matches = items.filter(item => item.accelerator === resolveShortcut(platform, binding));
          assert.equal(matches.length, 1, command);
          (matches[0].click as () => void)();
          assert.equal(value.dispatched.at(-1), command);
        }
      });

      it('shows shortcuts on disabled items without enabling them', () => {
        const value = fixture({ authenticated: false, canManageInstances: false, canGoBack: false, canGoForward: false });
        const signedOut = leaves(createApplicationMenuTemplate(platform, value.commands)).filter(item => !item.role);
        const disabled = signedOut.filter(item => item.enabled === false).map(item => item.label);
        assert.deepEqual(disabled, [
          'Settings…', 'New Task', 'New Plan', 'New Goal', 'New Automation', 'New To-do', 'Connect Instance…',
          'Switch Account / Instance…', 'Toggle Sidebar', 'Back', 'Forward', 'Search / Go To…',
          'Dashboard', 'Inbox', 'Plans', 'Goals', 'Tasks', 'Repositories',
        ]);
        for (const item of signedOut) assert.ok(item.accelerator, `${item.label} lost its shortcut while disabled`);
        for (const label of ['About ProPR', 'Quit ProPR', 'ProPR Website', 'Documentation', 'Connection Help', 'Connection Diagnostics…', 'Report a Problem…']) {
          assert.equal(signedOut.find(item => item.label === label)?.enabled, true, label);
        }
      });
    });
  }

  it('installs the same shortcut template as the application menu and the Linux popup', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      const value = fixture();
      let installed: MenuItemConstructorOptions[] = [];
      configureApplicationMenu({ buildFromTemplate: template => { installed = template; return {} as Menu; }, setApplicationMenu: () => undefined }, value.commands, platform);
      assert.equal(JSON.stringify(installed), JSON.stringify(createApplicationMenuTemplate(platform, value.commands)));
    }
    const value = fixture();
    let popped: MenuItemConstructorOptions[] = [];
    createApplicationMenuPopup({ buildFromTemplate: template => { popped = template; return { popup: () => undefined }; } }, value.commands, 'linux')
      .show({ isDestroyed: () => false, getContentSize: () => [880, 620], webContents: { getZoomFactor: () => 1 } }, { x: 0, y: 0, source: 'keyboard' });
    assert.deepEqual(leaves(popped).map(item => item.accelerator), leaves(createApplicationMenuTemplate('linux', value.commands)).map(item => item.accelerator));
  });

  it('keeps Mac-only native roles and their shortcuts off Linux', () => {
    const linux = leaves(createApplicationMenuTemplate('linux', fixture().commands));
    const mac = leaves(createApplicationMenuTemplate('darwin', fixture().commands));
    for (const role of ['services', 'hide', 'hideOthers', 'unhide', 'zoom', 'front', 'pasteAndMatchStyle']) {
      assert.ok(!linux.some(item => item.role === role), role);
      assert.ok(mac.some(item => item.role === role), role);
    }
    assert.equal(mac.find(item => item.role === 'services')?.accelerator, undefined);
  });
});
