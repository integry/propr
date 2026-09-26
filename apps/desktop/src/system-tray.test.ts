import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Menu, MenuItemConstructorOptions, NativeImage, Tray } from 'electron';
import { createDesktopNativeCommandDispatcher } from './native-commands';
import { createDesktopTrayController, formatTrayCount, parseActiveWorkSnapshot } from './system-tray';

const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 10));

const snapshot = (tasks: number, plans: number, openGoals: number, goals = 0): Response => Response.json({
  schemaVersion: 3,
  label: 'Active work',
  definition: 'Running non-goal tasks + generating or refining plans + executing native goals; open goals are reported separately',
  availability: {
    tasks: 'available',
    plans: 'available',
    goals: 'available',
    openGoals: 'available',
  },
  counts: { tasks, plans, goals, openGoals, total: tasks + plans + goals },
});

class FakeTray {
  destroyed = false;
  tooltip = '';
  title = '';
  menu: Menu | null = null;
  listeners = new Map<string, (...args: unknown[]) => void>();
  popups = 0;

  on(event: string, listener: (...args: unknown[]) => void): this {
    this.listeners.set(event, listener);
    return this;
  }

  setToolTip(value: string): void { this.tooltip = value; }
  setTitle(value: string): void { this.title = value; }
  setContextMenu(value: Menu | null): void { this.menu = value; }
  isDestroyed(): boolean { return this.destroyed; }
  destroy(): void { this.destroyed = true; }
  popUpContextMenu(): void { this.popups += 1; }
}

const commandFixture = (dispatch: (command: string) => void = () => undefined) => ({
  dispatch,
  getState: () => ({
    authenticated: true,
    nativeNotificationsAvailable: true,
    nativeNotificationsEnabled: false,
  }),
  subscribe: () => () => undefined,
});

describe('desktop system tray', () => {
  it('validates active-only totals and formats bounded badge overflow', () => {
    assert.deepEqual(parseActiveWorkSnapshot({
      schemaVersion: 2,
      label: 'Active work',
      definition: 'definition',
      availability: { tasks: 'available', plans: 'available', goals: 'unsupported', openGoals: 'available' },
      counts: { tasks: 2, plans: 3, goals: null, openGoals: 40, total: 5 },
    }), { tasks: 2, plans: 3, goals: null, openGoals: 40, total: 5 });
    assert.deepEqual(parseActiveWorkSnapshot({
      schemaVersion: 3,
      label: 'Active work',
      definition: 'definition',
      availability: { tasks: 'available', plans: 'available', goals: 'available', openGoals: 'available' },
      counts: { tasks: 2, plans: 3, goals: 4, openGoals: 40, total: 9 },
    }), { tasks: 2, plans: 3, goals: 4, openGoals: 40, total: 9 });
    assert.equal(parseActiveWorkSnapshot({
      schemaVersion: 2,
      label: 'Active work',
      definition: 'definition',
      availability: { tasks: 'available', plans: 'available', goals: 'unsupported', openGoals: 'available' },
      counts: { tasks: 2, plans: 3, goals: null, openGoals: 40, total: 45 },
    }), null);
    for (const goals of [-1, 1_000_001, '1']) {
      assert.equal(parseActiveWorkSnapshot({
        schemaVersion: 3,
        label: 'Active work',
        definition: 'definition',
        availability: { tasks: 'available', plans: 'available', goals: 'available', openGoals: 'available' },
        counts: { tasks: 2, plans: 3, goals, openGoals: 0, total: 5 + Number(goals) },
      }), null);
    }
    assert.equal(formatTrayCount(0), '0');
    assert.equal(formatTrayCount(99), '99');
    assert.equal(formatTrayCount(100), '99+');
  });

  it('shows zero and nonzero counts, restores the window, quits explicitly, and cleans up once', async () => {
    const fakeTray = new FakeTray();
    let creates = 0;
    let opens = 0;
    let quits = 0;
    let next = snapshot(0, 0, 0);
    const badges: number[] = [];
    let menuTemplate: MenuItemConstructorOptions[] = [];
    const controller = createDesktopTrayController({
      platform: 'darwin',
      icon: {} as NativeImage,
      createTray: () => { creates += 1; return fakeTray as unknown as Tray; },
      buildMenu: template => { menuTemplate = template; return {} as Menu; },
      setBadgeCount: count => { badges.push(count); return true; },
      fetchActiveWork: async () => ({ status: 'response', response: next }),
      commands: commandFixture(command => {
        if (command === 'open') opens += 1;
        if (command === 'quit') quits += 1;
      }),
      log: () => undefined,
      debounceMs: 0,
      minimumRefreshIntervalMs: 0,
      pollIntervalMs: 60_000,
    });

    controller.start();
    controller.start();
    assert.equal(creates, 1, 'only one native tray is created');
    assert.match(fakeTray.tooltip, /unavailable/i);

    controller.connectionAvailable();
    await tick();
    assert.equal(fakeTray.title, '0');
    assert.match(fakeTray.tooltip, /Active work: 0/);
    assert.ok(menuTemplate.some(item => item.label === 'Tasks: 0'));

    next = snapshot(73, 25, 5, 1);
    controller.refresh();
    await tick();
    assert.equal(fakeTray.title, '99');
    assert.match(fakeTray.tooltip, /Active work: 99/);
    assert.match(fakeTray.tooltip, /Goals 1/);
    assert.match(fakeTray.tooltip, /Goal backlog 5 \(not executing\)/);
    assert.ok(menuTemplate.some(item => item.label === 'Plans: 25'));
    assert.ok(menuTemplate.some(item => item.label === 'Goals: 1'));
    assert.ok(menuTemplate.some(item => item.label === 'Goal backlog (not executing): 5'));
    assert.equal(badges.at(-1), 99);

    fakeTray.listeners.get('click')?.();
    assert.equal(fakeTray.popups, 1, 'primary activation opens the actionable menu');
    assert.ok(fakeTray.menu, 'the installed context menu supplies right-click activation');
    assert.equal(fakeTray.listeners.has('double-click'), false, 'macOS leaves double activation to native menu behavior');
    const openItem = menuTemplate.find(item => item.label === 'Open ProPR');
    (openItem?.click as (() => void) | undefined)?.();
    assert.equal(opens, 1, 'Open ProPR remains an explicit action');
    const quitItem = menuTemplate.find(item => item.label === 'Quit ProPR');
    (quitItem?.click as (() => void) | undefined)?.();
    assert.equal(quits, 1);

    controller.connectionUnavailable('revoked');
    assert.equal(fakeTray.title, '');
    assert.match(fakeTray.tooltip, /Access revoked/);
    assert.equal(badges.at(-1), 0);

    controller.close();
    controller.close();
    assert.equal(fakeTray.destroyed, true);
    assert.equal(badges.at(-1), 0);
  });

  it('cleans up a partially initialized tray and its poller before retrying safely', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    const trays: FakeTray[] = [];
    let fetches = 0;
    let failInitialization = true;
    const controller = createDesktopTrayController({
      platform: 'linux',
      icon: {} as NativeImage,
      createTray: () => {
        const created = new FakeTray();
        trays.push(created);
        return created as unknown as Tray;
      },
      buildMenu: () => ({} as Menu),
      setBadgeCount: () => false,
      fetchActiveWork: async () => {
        fetches += 1;
        return { status: 'disconnected' };
      },
      commands: commandFixture(),
      log: (level) => {
        if (level === 'info' && failInitialization) {
          failInitialization = false;
          throw new Error('late initialization failure');
        }
      },
      debounceMs: 0,
      minimumRefreshIntervalMs: 0,
      pollIntervalMs: 100,
    });

    controller.start();
    assert.equal(trays.length, 1);
    assert.equal(trays[0]?.destroyed, true);

    t.mock.timers.tick(50);
    controller.start();
    assert.equal(trays.length, 2, 'a failed initialization can be retried');
    assert.equal(trays[1]?.destroyed, false);

    controller.connectionAvailable();
    t.mock.timers.tick(0);
    await Promise.resolve();
    assert.equal(fetches, 1);

    t.mock.timers.tick(50);
    t.mock.timers.tick(0);
    await Promise.resolve();
    assert.equal(fetches, 1, 'the failed initialization did not retain its polling timer');

    t.mock.timers.tick(50);
    t.mock.timers.tick(0);
    await Promise.resolve();
    assert.equal(fetches, 2, 'only the retried tray retains a polling timer');

    controller.close();
    assert.equal(trays[1]?.destroyed, true);
    t.mock.timers.tick(100);
    await Promise.resolve();
    assert.equal(fetches, 2);
  });

  it('opens ProPR on repeated Linux primary activation without invoking a popup', () => {
    const fakeTray = new FakeTray();
    const dispatched: string[] = [];
    const menu = {} as Menu;
    const controller = createDesktopTrayController({
      platform: 'linux',
      icon: {} as NativeImage,
      createTray: () => fakeTray as unknown as Tray,
      buildMenu: () => menu,
      setBadgeCount: () => false,
      fetchActiveWork: async () => ({ status: 'disconnected' }),
      commands: commandFixture(command => dispatched.push(command)),
      log: () => undefined,
    });
    controller.start();
    fakeTray.listeners.get('click')?.();
    fakeTray.listeners.get('click')?.();
    assert.deepEqual(dispatched, ['open', 'open'], 'every primary activation reuses the Open ProPR action');
    assert.equal(fakeTray.popups, 0, 'primary activation does not invoke a popup');
    assert.equal(fakeTray.menu, menu, 'setContextMenu remains installed for native right activation');
    assert.equal(fakeTray.listeners.has('double-click'), false, 'Linux does not expose a Tray double-click event');
    controller.close();
    fakeTray.listeners.get('click')?.();
    assert.deepEqual(dispatched, ['open', 'open'], 'activation after tray cleanup is ignored safely');
  });

  it('routes Linux About and Help tray actions while unavailable and with active work', async () => {
    const fakeTray = new FakeTray();
    const urls: string[] = [];
    let about = 0;
    let connectionScope: { profileId: string; transportScope: string } | null = null;
    let menuTemplate: MenuItemConstructorOptions[] = [];
    const commands = createDesktopNativeCommandDispatcher({
      channel: 'test',
      getWindow: () => null,
      restoreWindow: () => undefined,
      activeConnectionScope: () => connectionScope,
      activeNotificationScope: () => null,
      notificationState: () => ({ available: false, enabled: false }),
      setNativeNotificationsEnabled: async () => undefined,
      quit: () => undefined,
      showAbout: () => { about += 1; },
      openExternal: async url => { urls.push(url); },
    });
    const controller = createDesktopTrayController({
      platform: 'linux',
      icon: {} as NativeImage,
      createTray: () => fakeTray as unknown as Tray,
      buildMenu: template => { menuTemplate = template; return {} as Menu; },
      setBadgeCount: () => false,
      fetchActiveWork: async () => ({ status: 'response', response: snapshot(2, 3, 1) }),
      commands,
      log: () => undefined,
      debounceMs: 0,
      minimumRefreshIntervalMs: 0,
      pollIntervalMs: 60_000,
    });

    const invokeAboutAndHelp = (): void => {
      const aboutItem = menuTemplate.find(item => item.label === 'About ProPR');
      const helpItem = menuTemplate.find(item => item.label === 'Help');
      assert.notEqual(aboutItem?.enabled, false, 'About is available without credentials');
      assert.ok(Array.isArray(helpItem?.submenu), 'Help is a native submenu');
      (aboutItem?.click as (() => void) | undefined)?.();
      for (const label of ['ProPR Website', 'Documentation', 'Connection Help']) {
        const item = helpItem.submenu.find(candidate => candidate.label === label);
        assert.notEqual(item?.enabled, false, `${label} is available without credentials`);
        (item?.click as (() => void) | undefined)?.();
      }
    };

    controller.start();
    assert.match(fakeTray.tooltip, /Active work unavailable/);
    invokeAboutAndHelp();

    connectionScope = { profileId: 'profile-a', transportScope: 'abcdefghijklmnopqrstuv' };
    commands.connectionAvailable();
    controller.connectionAvailable();
    await tick();
    assert.match(fakeTray.tooltip, /Active work: 5/);
    invokeAboutAndHelp();
    await tick();

    assert.equal(about, 2);
    assert.deepEqual(urls, [
      'https://propr.dev',
      'https://docs.propr.dev',
      'https://docs.propr.dev/docs/operations/desktop-application',
      'https://propr.dev',
      'https://docs.propr.dev',
      'https://docs.propr.dev/docs/operations/desktop-application',
    ]);
    controller.close();
    commands.close();
  });

  it('drops scoped stale responses and marks network failures unavailable instead of zero', async () => {
    const fakeTray = new FakeTray();
    const badges: number[] = [];
    let resolveFetch!: (value: { status: 'response'; response: Response }) => void;
    const pending = new Promise<{ status: 'response'; response: Response }>(resolve => { resolveFetch = resolve; });
    let request = 0;
    const controller = createDesktopTrayController({
      platform: 'linux',
      icon: {} as NativeImage,
      createTray: () => fakeTray as unknown as Tray,
      buildMenu: () => ({} as Menu),
      setBadgeCount: count => { badges.push(count); return true; },
      fetchActiveWork: async () => {
        request += 1;
        if (request === 1) return pending;
        throw new Error('offline');
      },
      commands: commandFixture(),
      log: () => undefined,
      debounceMs: 0,
      minimumRefreshIntervalMs: 0,
      pollIntervalMs: 60_000,
    });
    controller.start();
    controller.connectionAvailable();
    await tick();
    controller.connectionUnavailable('profile-changed');
    resolveFetch({ status: 'response', response: snapshot(9, 9, 9) });
    await tick();
    assert.match(fakeTray.tooltip, /Instance changed/);
    assert.doesNotMatch(fakeTray.tooltip, /Active work: 18/);
    assert.equal(badges.at(-1), 0, 'an instance switch clears the previous account badge');

    controller.connectionAvailable();
    await tick();
    assert.match(fakeTray.tooltip, /Active work unavailable — Instance unavailable/);
    assert.doesNotMatch(fakeTray.tooltip, /Active work: 0/);
    assert.equal(badges.at(-1), 0, 'a failed reconnect cannot restore stale counts');
    controller.close();
  });

  it('uses no native tray on deferred platforms', () => {
    let created = false;
    const controller = createDesktopTrayController({
      platform: 'win32',
      icon: {} as NativeImage,
      createTray: () => { created = true; return {} as Tray; },
      buildMenu: () => ({} as Menu),
      setBadgeCount: () => false,
      fetchActiveWork: async () => ({ status: 'disconnected' }),
      commands: commandFixture(),
      log: () => undefined,
    });
    controller.start();
    assert.equal(created, false);
    controller.close();
  });
});
