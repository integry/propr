import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Menu, MenuItemConstructorOptions } from 'electron';
import { configureApplicationMenu } from './application-menu';
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
});
