import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Menu, MenuItemConstructorOptions } from 'electron';
import { configureApplicationMenu, createApplicationMenuPopup, createApplicationMenuTemplate } from './application-menu';
import type { DesktopNativeCommandDispatcher } from './native-commands';

const fixture = (overrides: Partial<ReturnType<DesktopNativeCommandDispatcher['getState']>> = {}) => {
  const dispatched: string[] = [];
  const listeners = new Set<() => void>();
  let template: MenuItemConstructorOptions[] = [];
  const commands = {
    dispatch: (command: string) => { dispatched.push(command); },
    getState: () => ({
      authenticated: true,
      nativeNotificationsAvailable: true,
      nativeNotificationsEnabled: false,
      ...overrides,
    }),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    rendererReady: () => undefined,
    rendererUnavailable: () => undefined,
    connectionAvailable: () => undefined,
    connectionUnavailable: () => undefined,
    refresh: () => undefined,
    close: () => undefined,
  } satisfies DesktopNativeCommandDispatcher;
  const host = {
    buildFromTemplate(value: MenuItemConstructorOptions[]) { template = value; return {} as Menu; },
    setApplicationMenu() { /* captured by buildFromTemplate */ },
  };
  return { commands, dispatched, listeners, host, template: () => template };
};

const items = (template: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] => template.flatMap(item => [
  item,
  ...(Array.isArray(item.submenu) ? item.submenu : []),
]);

describe('desktop application menu', () => {
  for (const platform of ['darwin', 'linux'] as const) {
    it(`${platform} exposes shared real actions, conservative accelerators and native conventions`, () => {
      const value = fixture({ canGoBack: true, canGoForward: false });
      configureApplicationMenu(value.host, value.commands, platform);
      const template = value.template();
      assert.deepEqual(template.map(item => item.label), ['ProPR', 'File', 'Edit', 'View', 'Navigate', 'Window', 'Help']);
      const all = items(template);
      const accelerators = all.flatMap(item => item.accelerator ? [item.accelerator] : []);
      assert.equal(new Set(accelerators).size, accelerators.length);
      assert.ok(!accelerators.some(accelerator => /CmdOrCtrl\+[1-7]/.test(accelerator)));
      for (const [label, command] of [
        ['New Plan', 'new-plan'], ['New Task…', 'new-task'],
        ['Connect Instance…', 'connect-instance'], ['Switch Account / Instance…', 'manage-instances'],
        ['Toggle Sidebar', 'toggle-sidebar'], ['Search / Go To…', 'search'],
        ['Dashboard', 'dashboard'], ['Inbox', 'inbox'], ['Plans', 'plans'],
        ['Goals', 'goals'], ['Tasks', 'tasks'], ['Repositories', 'repositories'],
        ['About ProPR', 'about'], ['ProPR Website', 'website'], ['Documentation', 'documentation'],
        ['Connection Help', 'connection-help'], ['Connection Diagnostics…', 'diagnostics'], ['Report a Problem…', 'report-problem'],
      ]) {
        (all.find(item => item.label === label)?.click as () => void)();
        assert.equal(value.dispatched.at(-1), command);
      }
      assert.equal(all.find(item => item.label === 'Search / Go To…')?.accelerator, 'CmdOrCtrl+K');
      assert.equal(all.find(item => item.label === 'Settings…')?.accelerator, 'CmdOrCtrl+,');
      assert.equal(all.find(item => item.label === 'Back')?.enabled, true);
      assert.equal(all.find(item => item.label === 'Forward')?.enabled, false);
      assert.equal(all.some(item => item.role === 'services'), platform === 'darwin');
      assert.equal(all.find(item => item.role === 'hide')?.label, platform === 'darwin' ? 'Hide ProPR' : undefined);
      assert.ok(all.some(item => item.role === 'copy'));
      assert.ok(all.some(item => item.role === 'zoomIn'));
      assert.ok(!all.some(item => item.label === 'Open ProPR'));
    });
    it(`${platform} disables unavailable actions and unsubscribes on close`, () => {
      const value = fixture({ authenticated: false, canManageInstances: false });
      const controller = configureApplicationMenu(value.host, value.commands, platform);
      const all = items(value.template());
      for (const label of ['New Plan', 'New Task…', 'Settings…', 'Back', 'Forward', 'Toggle Sidebar', 'Search / Go To…', 'Connect Instance…', 'Switch Account / Instance…']) {
        assert.equal(all.find(item => item.label === label)?.enabled, false);
      }
      for (const label of ['About ProPR', 'ProPR Website', 'Connection Diagnostics…']) {
        assert.equal(all.find(item => item.label === label)?.enabled, true);
      }
      assert.equal(value.listeners.size, 1);
      controller.close();
      assert.equal(value.listeners.size, 0);
    });
  }

  it('leaves the deferred Windows application menu untouched', () => {
    const value = fixture();
    configureApplicationMenu(value.host, value.commands, 'win32');
    assert.deepEqual(value.template(), []);
  });

  describe('Linux application menu popup', () => {
    const popupFixture = (overrides: Parameters<typeof fixture>[0] = {}) => {
      const value = fixture(overrides);
      const popups: Array<{ template: MenuItemConstructorOptions[]; options: Record<string, unknown> }> = [];
      const host = {
        buildFromTemplate(template: MenuItemConstructorOptions[]) {
          return { popup: (options: Record<string, unknown>) => { popups.push({ template, options }); } };
        },
      };
      let destroyed = false;
      const window = {
        isDestroyed: () => destroyed,
        getContentSize: () => [880, 620],
        webContents: { getZoomFactor: () => 1.25 },
      };
      return { ...value, popups, host, window, destroy: () => { destroyed = true; } };
    };

    it('pops up the shared native template for the sender window below a clamped, zoom-scaled anchor', () => {
      const value = popupFixture();
      const popup = createApplicationMenuPopup(value.host, value.commands, 'linux');
      popup.show(value.window, { x: 700.4, y: 44, source: 'keyboard' });
      assert.equal(value.popups.length, 1);
      const [{ template, options }] = value.popups;
      assert.equal(options.window, value.window);
      assert.equal(options.x, 876);
      assert.equal(options.y, 55);
      assert.equal(options.sourceType, 'keyboard');
      assert.deepEqual(template.map(item => item.label), ['ProPR', 'File', 'Edit', 'View', 'Navigate', 'Window', 'Help']);
      assert.deepEqual(
        JSON.stringify(template),
        JSON.stringify(createApplicationMenuTemplate('linux', value.commands)),
        'The popup must reuse the application menu template, not a renderer-supplied one',
      );
      const all = items(template);
      for (const role of ['copy', 'paste', 'selectAll', 'resetZoom', 'zoomIn', 'zoomOut', 'minimize', 'close']) {
        assert.ok(all.some(item => item.role === role), `Missing ${role} role`);
      }
      for (const [label, command] of [['Settings…', 'settings'], ['Dashboard', 'dashboard'], ['About ProPR', 'about'], ['Documentation', 'documentation']]) {
        (all.find(item => item.label === label)?.click as () => void)();
        assert.equal(value.dispatched.at(-1), command);
      }

      popup.show(value.window, { x: 99_999, y: 99_999, source: 'mouse' });
      assert.equal(value.popups.length, 1, 'A second request while the menu is open must not stack popups');
      (options.callback as () => void)();
      popup.show(value.window, { x: 99_999, y: 99_999, source: 'mouse' });
      assert.equal(value.popups[1].options.x, 880);
      assert.equal(value.popups[1].options.y, 620);
      assert.equal(value.popups[1].options.sourceType, 'mouse');
    });

    it('reflects current authentication and instance enablement each time it opens', () => {
      let authenticated = false;
      const value = popupFixture();
      const commands = { ...value.commands, getState: () => ({ ...value.commands.getState(), authenticated, canManageInstances: authenticated }) };
      const popup = createApplicationMenuPopup(value.host, commands, 'linux');
      popup.show(value.window, { x: 0, y: 44, source: 'mouse' });
      const signedOut = items(value.popups[0].template);
      for (const label of ['Settings…', 'New Plan', 'Dashboard', 'Switch Account / Instance…']) {
        assert.equal(signedOut.find(item => item.label === label)?.enabled, false, label);
      }
      assert.equal(signedOut.find(item => item.label === 'About ProPR')?.enabled, true);
      (value.popups[0].options.callback as () => void)();
      authenticated = true;
      popup.show(value.window, { x: 0, y: 44, source: 'mouse' });
      const signedIn = items(value.popups[1].template);
      for (const label of ['Settings…', 'New Plan', 'Dashboard', 'Switch Account / Instance…']) {
        assert.equal(signedIn.find(item => item.label === label)?.enabled, true, label);
      }
    });

    it('is unavailable outside Linux and for destroyed windows, and recovers after a failed popup', () => {
      for (const platform of ['darwin', 'win32'] as const) {
        const value = popupFixture();
        assert.throws(() => createApplicationMenuPopup(value.host, value.commands, platform)
          .show(value.window, { x: 0, y: 0, source: 'mouse' }), /Linux-only/);
        assert.equal(value.popups.length, 0);
      }
      const value = popupFixture();
      const popup = createApplicationMenuPopup(value.host, value.commands, 'linux');
      value.destroy();
      assert.throws(() => popup.show(value.window, { x: 0, y: 0, source: 'mouse' }), /unavailable/);
      let fail = true;
      const failing = createApplicationMenuPopup({
        buildFromTemplate: template => ({ popup: options => {
          if (fail) throw new Error('popup failed');
          value.popups.push({ template, options: options as unknown as Record<string, unknown> });
        } }),
      }, value.commands, 'linux');
      const live = { ...value.window, isDestroyed: () => false };
      assert.throws(() => failing.show(live, { x: 0, y: 0, source: 'mouse' }), /popup failed/);
      fail = false;
      failing.show(live, { x: 0, y: 0, source: 'mouse' });
      assert.equal(value.popups.length, 1);
    });
  });
});
