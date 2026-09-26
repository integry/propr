import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createApplicationMenuTemplate } from './application-menu';
import { applicationAboutDetails, showApplicationAbout } from './application-about';
import { createDesktopNativeCommandDispatcher } from './native-commands';
import type { DesktopNativeCommandDelivery, DesktopNotificationScope } from './shared/contract';

const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(settle => { resolve = settle; });
  return { promise, resolve };
};

describe('desktop native command dispatcher', () => {
  for (const command of ['settings', 'new-task', 'search', 'toggle-sidebar'] as const) {
  it(`drops queued ${command} when another account replaces the same profile and scopes menu history`, () => {
    let scope = { profileId: 'profile-a', transportScope: 'abcdefghijklmnopqrstuv' };
    const oldScope = scope;
    const sent: DesktopNativeCommandDelivery[] = [];
    const dispatcher = createDesktopNativeCommandDispatcher({
      channel: 'desktop:native-command',
      getWindow: () => ({ isDestroyed: () => false, webContents: { send: (_channel, value) => sent.push(value) } }),
      restoreWindow: () => undefined,
      activeConnectionScope: () => scope,
      activeNotificationScope: () => null,
      notificationState: () => ({ available: false, enabled: false }),
      setNativeNotificationsEnabled: async () => undefined,
      quit: () => undefined,
    });
    dispatcher.connectionAvailable();
    dispatcher.dispatch(command);
    scope = { ...scope, transportScope: 'zyxwvutsrqponmlkjihgfe' };
    dispatcher.rendererReady();
    assert.deepEqual(sent, []);
    dispatcher.updateNavigationState?.({ connectionScope: oldScope, canManageInstances: true, canGoBack: true, canGoForward: true });
    assert.equal(dispatcher.getState().canGoBack, false);
    dispatcher.updateNavigationState?.({ connectionScope: scope, canManageInstances: true, canGoBack: true, canGoForward: false });
    assert.equal(dispatcher.getState().canGoBack, true);
    dispatcher.dispatch('back');
    assert.deepEqual(sent, [{ command: 'back', connectionScope: scope }]);
    dispatcher.rendererUnavailable();
    assert.equal(dispatcher.getState().canGoBack, false);
    dispatcher.connectionUnavailable();
    assert.equal(dispatcher.getState().authenticated, false);
  });

  }

  it('restores a hidden window, gates auth actions, and delivers only fixed renderer commands when ready', () => {
    const sent: DesktopNativeCommandDelivery[] = [];
    let restores = 0;
    let scope: { profileId: string; transportScope: string } | null = null;
    const dispatcher = createDesktopNativeCommandDispatcher({
      channel: 'desktop:native-command',
      getWindow: () => ({ isDestroyed: () => false, webContents: { send: (_channel, value) => sent.push(value) } }),
      restoreWindow: () => { restores += 1; },
      activeConnectionScope: () => scope,
      activeNotificationScope: () => null,
      notificationState: () => ({ available: false, enabled: false }),
      setNativeNotificationsEnabled: async () => undefined,
      quit: () => undefined,
    });
    dispatcher.rendererReady();
    dispatcher.dispatch('tasks');
    assert.deepEqual(sent, []);
    assert.equal(restores, 0);

    scope = { profileId: 'profile-a', transportScope: 'abcdefghijklmnopqrstuv' };
    dispatcher.connectionAvailable();
    dispatcher.dispatch('tasks');
    dispatcher.dispatch('manage-instances');
    dispatcher.dispatch('quit');
    assert.deepEqual(sent, [
      { command: 'tasks', connectionScope: scope },
      { command: 'manage-instances', connectionScope: scope },
      { command: 'quit', connectionScope: scope },
    ]);
    assert.equal(restores, 3);
  });

  it('queues startup navigation but drops it after an instance switch', () => {
    const sent: DesktopNativeCommandDelivery[] = [];
    let scope = { profileId: 'profile-a', transportScope: 'abcdefghijklmnopqrstuv' };
    const dispatcher = createDesktopNativeCommandDispatcher({
      channel: 'desktop:native-command',
      getWindow: () => ({ isDestroyed: () => false, webContents: { send: (_channel, value) => sent.push(value) } }),
      restoreWindow: () => undefined,
      activeConnectionScope: () => scope,
      activeNotificationScope: () => null,
      notificationState: () => ({ available: false, enabled: false }),
      setNativeNotificationsEnabled: async () => undefined,
      quit: () => undefined,
    });
    dispatcher.connectionAvailable();
    dispatcher.dispatch('plans');
    scope = { profileId: 'profile-b', transportScope: 'zyxwvutsrqponmlkjihgfe' };
    dispatcher.rendererReady();
    assert.deepEqual(sent, []);
    dispatcher.dispatch('inbox');
    assert.deepEqual(sent, [{ command: 'inbox', connectionScope: scope }]);
  });

  it('flushes to the exact recreated window before its global reference is published', () => {
    const sent: DesktopNativeCommandDelivery[] = [];
    const connectionScope = { profileId: 'profile-a', transportScope: 'abcdefghijklmnopqrstuv' };
    const dispatcher = createDesktopNativeCommandDispatcher({
      channel: 'desktop:native-command',
      getWindow: () => null,
      restoreWindow: () => undefined,
      activeConnectionScope: () => connectionScope,
      activeNotificationScope: () => null,
      notificationState: () => ({ available: false, enabled: false }),
      setNativeNotificationsEnabled: async () => undefined,
      quit: () => undefined,
    });
    dispatcher.connectionAvailable();
    dispatcher.dispatch('new-plan');
    dispatcher.rendererReady({
      isDestroyed: () => false,
      webContents: { send: (_channel, command) => sent.push(command) },
    });
    assert.deepEqual(sent, [{ command: 'new-plan', connectionScope }]);
  });

  it('persists notification pause/resume, publishes state changes, and disposes commands', async () => {
    const notificationScope: DesktopNotificationScope = {
      profileId: 'profile-a', transportScope: 'abcdefghijklmnopqrstuv', userId: 'user-a',
    };
    let enabled = true;
    let updates = 0;
    let quits = 0;
    const dispatcher = createDesktopNativeCommandDispatcher({
      channel: 'desktop:native-command',
      getWindow: () => null,
      restoreWindow: () => undefined,
      activeConnectionScope: () => notificationScope,
      activeNotificationScope: () => notificationScope,
      notificationState: () => ({ available: true, enabled }),
      setNativeNotificationsEnabled: async (_scope, value) => { enabled = value; },
      quit: () => { quits += 1; },
    });
    dispatcher.connectionAvailable();
    const unsubscribe = dispatcher.subscribe(() => { updates += 1; });
    assert.equal(dispatcher.getState().nativeNotificationsEnabled, true);
    dispatcher.dispatch('toggle-native-notifications');
    await tick();
    assert.equal(enabled, false);
    assert.equal(updates, 1);
    dispatcher.dispatch('quit');
    assert.equal(quits, 0);

    dispatcher.close();
    dispatcher.dispatch('quit');
    dispatcher.dispatch('toggle-native-notifications');
    await tick();
    assert.equal(quits, 0);
    assert.equal(updates, 1);
    unsubscribe();
  });

  it('serializes rapid notification toggles against the latest persisted state', async () => {
    const notificationScope: DesktopNotificationScope = {
      profileId: 'profile-a', transportScope: 'abcdefghijklmnopqrstuv', userId: 'user-a',
    };
    let enabled = true;
    const writes: boolean[] = [];
    const first = deferred();
    const second = deferred();
    const gates = [first, second];
    const dispatcher = createDesktopNativeCommandDispatcher({
      channel: 'desktop:native-command',
      getWindow: () => null,
      restoreWindow: () => undefined,
      activeConnectionScope: () => notificationScope,
      activeNotificationScope: () => notificationScope,
      notificationState: () => ({ available: true, enabled }),
      setNativeNotificationsEnabled: async (_scope, value) => {
        const gate = gates[writes.length];
        writes.push(value);
        await gate.promise;
        enabled = value;
      },
      quit: () => undefined,
    });
    dispatcher.connectionAvailable();

    dispatcher.dispatch('toggle-native-notifications');
    dispatcher.dispatch('toggle-native-notifications');
    await tick();
    assert.deepEqual(writes, [false]);

    first.resolve();
    await tick();
    assert.deepEqual(writes, [false, true]);
    second.resolve();
    await tick();
    assert.equal(enabled, true);
  });

  it('drops a queued notification toggle after the initiating connection is replaced', async () => {
    const accountA: DesktopNotificationScope = {
      profileId: 'profile-a', transportScope: 'abcdefghijklmnopqrstuv', userId: 'user-a',
    };
    const accountB: DesktopNotificationScope = {
      profileId: 'profile-b', transportScope: 'zyxwvutsrqponmlkjihgfe', userId: 'user-b',
    };
    let scope = accountA;
    const preferences = new Map([[accountA.profileId, true], [accountB.profileId, true]]);
    const writes: string[] = [];
    const dispatcher = createDesktopNativeCommandDispatcher({
      channel: 'desktop:native-command',
      getWindow: () => null,
      restoreWindow: () => undefined,
      activeConnectionScope: () => scope,
      activeNotificationScope: () => scope,
      notificationState: () => ({ available: true, enabled: preferences.get(scope.profileId) ?? false }),
      setNativeNotificationsEnabled: async (_notificationScope, value) => {
        writes.push(scope.profileId);
        preferences.set(scope.profileId, value);
      },
      quit: () => undefined,
    });
    dispatcher.connectionAvailable();

    dispatcher.dispatch('toggle-native-notifications');
    scope = accountB;
    dispatcher.connectionUnavailable();
    dispatcher.connectionAvailable();
    await tick();

    assert.deepEqual(writes, []);
    assert.equal(preferences.get(accountA.profileId), true);
    assert.equal(preferences.get(accountB.profileId), true);
  });

  it('drops a queued notification toggle when another user becomes active on the same connection', async () => {
    const accountA: DesktopNotificationScope = {
      profileId: 'profile-a', transportScope: 'abcdefghijklmnopqrstuv', userId: 'user-a',
    };
    const accountB: DesktopNotificationScope = { ...accountA, userId: 'user-b' };
    let activeAccount = accountA;
    const preferences = new Map([[accountA.userId, true], [accountB.userId, true]]);
    const writes: string[] = [];
    const dispatcher = createDesktopNativeCommandDispatcher({
      channel: 'desktop:native-command',
      getWindow: () => null,
      restoreWindow: () => undefined,
      activeConnectionScope: () => activeAccount,
      activeNotificationScope: () => activeAccount,
      notificationState: () => ({
        available: true,
        enabled: preferences.get(activeAccount.userId) ?? false,
      }),
      setNativeNotificationsEnabled: async (notificationScope, value) => {
        writes.push(notificationScope.userId);
        preferences.set(notificationScope.userId, value);
      },
      quit: () => undefined,
    });
    dispatcher.connectionAvailable();

    dispatcher.dispatch('toggle-native-notifications');
    activeAccount = accountB;
    await tick();

    assert.deepEqual(writes, []);
    assert.equal(preferences.get(accountA.userId), true);
    assert.equal(preferences.get(accountB.userId), true);
  });

  it('drops a queued notification toggle when the dispatcher closes before its microtask', async () => {
    const notificationScope: DesktopNotificationScope = {
      profileId: 'profile-a', transportScope: 'abcdefghijklmnopqrstuv', userId: 'user-a',
    };
    let enabled = true;
    let writes = 0;
    const dispatcher = createDesktopNativeCommandDispatcher({
      channel: 'desktop:native-command',
      getWindow: () => null,
      restoreWindow: () => undefined,
      activeConnectionScope: () => notificationScope,
      activeNotificationScope: () => notificationScope,
      notificationState: () => ({ available: true, enabled }),
      setNativeNotificationsEnabled: async (_scope, value) => {
        writes += 1;
        enabled = value;
      },
      quit: () => undefined,
    });
    dispatcher.connectionAvailable();

    dispatcher.dispatch('toggle-native-notifications');
    dispatcher.close();
    await tick();

    assert.equal(writes, 0);
    assert.equal(enabled, true);
  });
});

for (const platform of ['darwin', 'linux'] as const) {
  it(`${platform} routes public help to the default browser and About to the native dialog without renderer authority`, async () => {
    const urls: string[] = [];
    let about = 0;
    const dispatcher = createDesktopNativeCommandDispatcher({
      channel: 'test', getWindow: () => null, restoreWindow: () => undefined,
      activeConnectionScope: () => null, activeNotificationScope: () => null,
      notificationState: () => ({ available: false, enabled: false }),
      setNativeNotificationsEnabled: async () => undefined, quit: () => undefined,
      openExternal: async url => { urls.push(url); }, showAbout: () => { about++; },
    });
    const items = createApplicationMenuTemplate(platform, dispatcher).flatMap(item => Array.isArray(item.submenu) ? item.submenu : []);
    for (const label of ['ProPR Website', 'Documentation', 'Connection Help', 'Report a Problem…', 'About ProPR']) {
      (items.find(item => item.label === label)?.click as () => void)();
    }
    await tick();
    assert.deepEqual(urls, ['https://propr.dev', 'https://docs.propr.dev', 'https://docs.propr.dev/docs/operations/desktop-application', 'https://github.com/integry/propr/issues/new']);
    assert.equal(about, 1);
    const details = applicationAboutDetails('0.8.15', platform, 'arm64', { ...process.versions, electron: '44.0.0', chrome: '152.0.0' });
    for (const expected of ['ProPR 0.8.15', `${platform} (arm64)`, 'Electron: 44.0.0', 'Chromium: 152.0.0', 'Node.js:', 'Rinalds Uzkalns']) assert.ok(details.includes(expected));
  });
}

for (const platform of ['darwin', 'linux']) {
  it(`${platform} About formats details and keeps close, copy and website actions independent`, async () => {
    const details = applicationAboutDetails('0.8.15', platform, 'x64', process.versions);
    const copied: string[] = [];
    const opened: string[] = [];
    assert.ok(details.includes(`Node.js: ${process.versions.node}\n\n©`));
    assert.ok(details.endsWith(`Rinalds Uzkalns\nhttps://propr.dev`));
    const invoke = async (response: number): Promise<void> => {
      await showApplicationAbout({
        showMessageBox: async options => {
          assert.equal(options.title, 'About ProPR');
          assert.equal(options.detail, `ProPR is an AI-powered development workspace for planning, running, and reviewing coding tasks across your repositories.\n\n${details}`);
          assert.deepEqual(options.buttons, ['Close', 'Copy Version Details', 'Open ProPR Website']);
          assert.equal(options.defaultId, 0);
          assert.equal(options.cancelId, 0);
          return { response, checkboxChecked: false };
        },
        copy: text => copied.push(text),
        openExternal: async url => { opened.push(url); },
      }, details);
    };

    await invoke(0);
    assert.deepEqual(copied, []);
    assert.deepEqual(opened, []);
    await invoke(1);
    assert.deepEqual(copied, [details]);
    assert.deepEqual(opened, []);
    await invoke(2);
    assert.deepEqual(copied, [details]);
    assert.deepEqual(opened, ['https://propr.dev']);
  });
}
