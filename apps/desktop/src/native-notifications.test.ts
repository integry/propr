import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  DEFAULT_DESKTOP_NOTIFICATION_PREFERENCES,
  NativeNotificationService,
  isDesktopNotificationScope,
  isDesktopTaskTransition,
  type NativeNotificationHandle,
  type NativeNotificationPayload,
} from './native-notifications';
import type {
  DesktopNotificationPreferences,
  DesktopNotificationScope,
  DesktopTaskTransition,
} from './shared/contract';

const scope: DesktopNotificationScope = {
  profileId: 'profile-a',
  transportScope: 'abcdefghijklmnopqrstuv',
  userId: 'user-a',
};
const now = Date.parse('2026-09-07T18:45:00.000Z');
const transition = (
  state: string,
  previousState: string,
  taskId = 'task-a',
  version = 2,
): DesktopTaskTransition => ({
  taskId, state, previousState, repository: 'integry/propr', issueNumber: 2192,
  timestamp: new Date(now).toISOString(), version,
});

interface ShownNotification {
  payload: NativeNotificationPayload;
  click(): void;
  fail(): void;
  accept(): void;
  closed: boolean;
}

const deferred = <T,>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
};

const fixture = async (overrides: {
  platform?: NodeJS.Platform;
  supported?: boolean;
  delivery?: 'accepted' | 'failed' | 'pending';
  beforePersist?: () => Promise<void>;
  onSettingsChanged?: (changedScope?: DesktopNotificationScope) => void;
} = {}) => {
  const directory = await mkdtemp(join(tmpdir(), 'propr-native-notifications-'));
  const shown: ShownNotification[] = [];
  const navigated: string[] = [];
  const logs: Array<{ level: 'warn' | 'error'; event: string }> = [];
  let active = true;
  let currentUser = scope.userId;
  const createService = () => new NativeNotificationService({
    statePath: join(directory, 'preferences.json'),
    platform: overrides.platform ?? 'linux',
    isSupported: () => overrides.supported ?? true,
    isActiveScope: candidate => active
      && candidate.profileId === scope.profileId
      && candidate.transportScope === scope.transportScope
      && candidate.userId === currentUser,
    show: (payload, events) => {
      const item: ShownNotification = {
        payload,
        click: events.click,
        fail: events.failed,
        accept: events.shown,
        closed: false,
      };
      shown.push(item);
      const handle: NativeNotificationHandle = {
        close: () => {
          item.closed = true;
          events.close();
        },
      };
      if (overrides.delivery !== 'pending') {
        queueMicrotask(overrides.delivery === 'failed' ? events.failed : events.shown);
      }
      return handle;
    },
    navigate: path => navigated.push(path),
    now: () => now,
    batchDelayMs: 5,
    testDeliveryTimeoutMs: 20,
    beforePersist: overrides.beforePersist,
    log: (level, event) => logs.push({ level, event }),
    onSettingsChanged: overrides.onSettingsChanged,
  });
  const service = createService();
  return {
    directory, service, shown, navigated, logs,
    restart: createService,
    deactivate: () => { active = false; },
    setUser: (userId: string) => { currentUser = userId; },
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
};

const settleBatch = () => new Promise(resolve => setTimeout(resolve, 15));

test('uses quiet defaults and persists account/instance/device preferences', async () => {
  const item = await fixture();
  try {
    const initial = await item.service.get(scope);
    assert.deepEqual(initial.preferences, DEFAULT_DESKTOP_NOTIFICATION_PREFERENCES);
    assert.equal(initial.scope, 'account-instance-device');
    assert.equal(initial.capability.supported, true);

    const updated = await item.service.update(scope, { enabled: true, taskCompleted: true });
    assert.equal(updated.preferences.enabled, true);
    assert.equal(updated.preferences.taskStarted, false);
    assert.equal(updated.preferences.taskCompleted, true);
    await item.service.idle();
    const stored = JSON.parse(await readFile(join(item.directory, 'preferences.json'), 'utf8')) as {
      accounts: Record<string, { taskCompleted: boolean }>;
    };
    assert.equal(Object.values(stored.accounts)[0].taskCompleted, true);
    item.service.close();
    const restarted = item.restart();
    assert.equal((await restarted.get(scope)).preferences.taskCompleted, true);
    assert.equal((await restarted.get(scope)).preferences.enabled, true);
    restarted.close();
  } finally {
    await item.cleanup();
  }
});

test('keeps the active native toggle synchronized with renderer settings', async () => {
  const changes: Array<DesktopNotificationScope | undefined> = [];
  const item = await fixture({ onSettingsChanged: changedScope => { changes.push(changedScope); } });
  try {
    assert.equal(item.service.activeSettings(), null);
    await item.service.get(scope);
    assert.equal(item.service.activeSettings()?.preferences.enabled, false);
    await item.service.update(scope, { taskCompleted: true });
    assert.equal(item.service.activeSettings()?.preferences.taskCompleted, true);
    await item.service.setActiveEnabled(scope, true);
    assert.equal(item.service.activeSettings()?.preferences.enabled, true);
    assert.equal(item.service.activeSettings()?.preferences.taskCompleted, true);
    await item.service.setActiveEnabled(scope, false);
    assert.equal(item.service.activeSettings()?.preferences.enabled, false);
    assert.equal(item.service.activeSettings()?.preferences.taskCompleted, true);
    item.service.clear(scope);
    assert.equal(item.service.activeSettings(), null);
    assert.deepEqual(changes, [undefined, scope, scope, scope, scope]);
  } finally {
    item.service.close();
    await item.cleanup();
  }
});

test('rejects a native toggle captured for another user on the same connection', async () => {
  const item = await fixture();
  const replacementScope = { ...scope, userId: 'user-b' };
  try {
    await item.service.get(scope);
    item.setUser(replacementScope.userId);
    await item.service.get(replacementScope);

    await assert.rejects(
      item.service.setActiveEnabled(scope, true),
      /No active notification account/,
    );
    assert.equal(item.service.activeSettings()?.preferences.enabled, false);
  } finally {
    item.service.close();
    await item.cleanup();
  }
});

test('failed writes roll back in-memory changes and do not poison later saves', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'propr-native-notification-write-'));
  const blockedParent = join(directory, 'blocked');
  await writeFile(blockedParent, 'not a directory');
  const statePath = join(blockedParent, 'preferences.json');
  const service = new NativeNotificationService({
    statePath,
    platform: 'linux',
    isSupported: () => true,
    isActiveScope: () => true,
    show: () => ({ close: () => undefined }),
    navigate: () => undefined,
  });
  try {
    await service.get(scope);
    await assert.rejects(
      service.update(scope, { enabled: true }),
      /Desktop notification preferences could not be saved/,
    );
    assert.equal((await service.get(scope)).preferences.enabled, false);

    await rm(blockedParent);
    await mkdir(blockedParent);
    const recovered = await service.update(scope, { taskCompleted: true });
    assert.equal(recovered.preferences.enabled, false);
    assert.equal(recovered.preferences.taskCompleted, true);
    const stored = JSON.parse(await readFile(statePath, 'utf8')) as {
      accounts: Record<string, { enabled: boolean; taskCompleted: boolean }>;
    };
    assert.equal(Object.values(stored.accounts)[0].enabled, false);
    assert.equal(Object.values(stored.accounts)[0].taskCompleted, true);
  } finally {
    service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects a new account before exceeding the readable storage limit', async () => {
  const item = await fixture();
  const existingScope = { ...scope, userId: 'existing-user' };
  const existingKey = createHash('sha256')
    .update(`${existingScope.profileId}\0${existingScope.userId}`)
    .digest('base64url');
  const accounts: Record<string, DesktopNotificationPreferences> = Object.fromEntries(
    Array.from({ length: 999 }, (_, index) => [
      `stored-account-${index}`,
      { ...DEFAULT_DESKTOP_NOTIFICATION_PREFERENCES },
    ]),
  );
  accounts[existingKey] = { ...DEFAULT_DESKTOP_NOTIFICATION_PREFERENCES, enabled: true };
  const statePath = join(item.directory, 'preferences.json');
  await writeFile(statePath, JSON.stringify({ version: 1, accounts }));
  let restarted: NativeNotificationService | null = null;
  try {
    await assert.rejects(
      item.service.update(scope, { enabled: true }),
      /preference account limit reached/,
    );
    await item.service.idle();
    const stored = JSON.parse(await readFile(statePath, 'utf8')) as {
      accounts: Record<string, DesktopNotificationPreferences>;
    };
    assert.equal(Object.keys(stored.accounts).length, 1_000);

    item.service.close();
    item.setUser(existingScope.userId);
    restarted = item.restart();
    assert.equal((await restarted.get(existingScope)).preferences.enabled, true);
  } finally {
    item.service.close();
    restarted?.close();
    await item.cleanup();
  }
});

test('reports Windows and missing native APIs without invoking delivery', async () => {
  const windows = await fixture({ platform: 'win32' });
  const unsupported = await fixture({ supported: false });
  try {
    assert.deepEqual((await windows.service.get(scope)).capability, {
      supported: false, platform: 'win32', permission: 'unsupported', reason: 'platform-deferred',
    });
    await windows.service.update(scope, { enabled: true });
    assert.equal((await windows.service.test(scope)).status, 'not-attempted');
    assert.equal((await unsupported.service.get(scope)).capability.reason, 'native-api-unavailable');
    const mac = new NativeNotificationService({
      statePath: join(windows.directory, 'mac.json'), platform: 'darwin',
      isSupported: () => true, isActiveScope: () => true,
      show: () => ({ close: () => undefined }), navigate: () => undefined,
    });
    assert.equal((await mac.get(scope)).capability.supported, true);
  } finally {
    await windows.cleanup();
    await unsupported.cleanup();
  }
});

test('reports asynchronous native delivery failures with a fixed privacy-safe diagnostic', async () => {
  const item = await fixture({ platform: 'darwin', delivery: 'failed' });
  try {
    await item.service.update(scope, { enabled: true });

    assert.deepEqual(await item.service.test(scope), { status: 'failed' });
    assert.deepEqual(item.logs, [{
      level: 'warn', event: 'desktop.notifications.delivery_failed',
    }]);
    item.shown[0].fail();
    assert.equal(item.logs.length, 1);

    item.service.close();
    assert.equal(item.shown[0].closed, false);
  } finally {
    item.service.close();
    await item.cleanup();
  }
});

test('cancels a pending test result when notifications are disabled', async () => {
  const item = await fixture({ delivery: 'pending' });
  try {
    await item.service.update(scope, { enabled: true });
    const pendingTest = item.service.test(scope);
    await new Promise(resolve => setImmediate(resolve));

    await item.service.update(scope, { enabled: false });

    assert.deepEqual(await pendingTest, { status: 'cancelled' });
    assert.equal(item.shown[0].closed, true);
    item.shown[0].fail();
    assert.deepEqual(item.logs, []);
  } finally {
    item.service.close();
    await item.cleanup();
  }
});

test('does not infer delivery when the native adapter emits no outcome', async () => {
  const item = await fixture({ delivery: 'pending' });
  try {
    await item.service.update(scope, { enabled: true });

    assert.deepEqual(await item.service.test(scope), { status: 'unconfirmed' });
    assert.equal(item.shown.length, 1);
    assert.deepEqual(item.logs, []);
  } finally {
    item.service.close();
    await item.cleanup();
  }
});

test('cancels an unresolved test on account switch without affecting the replacement account', async () => {
  const item = await fixture({ delivery: 'pending' });
  const nextScope = { ...scope, userId: 'user-b' };
  try {
    await item.service.update(scope, { enabled: true });
    const oldAccountTest = item.service.test(scope);
    await new Promise(resolve => setImmediate(resolve));

    item.setUser(nextScope.userId);
    const nextSettings = await item.service.get(nextScope);

    assert.deepEqual(await oldAccountTest, { status: 'cancelled' });
    assert.equal(item.shown[0].closed, true);
    assert.equal(nextSettings.preferences.enabled, false);
    assert.deepEqual(await item.service.test(nextScope), { status: 'not-attempted' });
  } finally {
    item.service.close();
    await item.cleanup();
  }
});

test('honors every event toggle and suppresses snapshots, old events, and duplicate terminals', async () => {
  const item = await fixture();
  try {
    await item.service.update(scope, { enabled: true, taskStarted: true, taskCompleted: true });
    assert.equal((await item.service.publish(scope, transition('processing', 'queued'))).accepted, true);
    assert.equal((await item.service.publish(scope, transition('processing', 'queued'))).accepted, false);
    assert.equal((await item.service.publish(scope, transition('completed', 'processing', 'task-b'))).accepted, true);
    assert.equal((await item.service.publish(scope, transition('failed', 'processing', 'task-c'))).accepted, true);
    assert.equal((await item.service.publish(scope, transition('action_required', 'processing', 'task-d'))).accepted, true);
    assert.equal((await item.service.publish(scope, transition('completed', 'processing', 'task-b', 3))).accepted, false);
    assert.equal((await item.service.publish(scope, {
      ...transition('failed', 'processing', 'old-task'),
      timestamp: new Date(now - 180_000).toISOString(),
    })).accepted, false);
    assert.equal(isDesktopTaskTransition({ ...transition('completed', 'processing'), previousState: undefined }), false);
    await settleBatch();
    assert.equal(item.shown.length, 1);
    assert.equal(item.shown[0].payload.title, '4 task updates');
    assert.match(item.shown[0].payload.body, /1 failed/);
    assert.match(item.shown[0].payload.body, /1 need attention/);
  } finally {
    item.service.close();
    await item.cleanup();
  }
});

test('allows failed and completed retries after newer processing cycles when started alerts are disabled', async () => {
  const item = await fixture();
  try {
    await item.service.update(scope, { enabled: true, taskCompleted: true });
    for (const kind of ['failed', 'completed'] as const) {
      const taskId = `${kind}-retry`;
      assert.equal((await item.service.publish(
        scope, transition(kind, 'processing', taskId, 2),
      )).accepted, true);
      assert.equal((await item.service.publish(
        scope, transition(kind, 'processing', taskId, 2),
      )).accepted, false);

      assert.equal((await item.service.publish(
        scope, transition('processing', kind, taskId, 3),
      )).accepted, false);
      assert.equal((await item.service.publish(
        scope, transition(kind, 'processing', taskId, 4),
      )).accepted, true);
      assert.equal((await item.service.publish(
        scope, transition(kind, 'processing', taskId, 4),
      )).accepted, false);

      assert.equal((await item.service.publish(
        scope, transition('processing', kind, taskId, 1),
      )).accepted, false);
      assert.equal((await item.service.publish(
        scope, transition(kind, 'processing', taskId, 5),
      )).accepted, false);
    }
    await settleBatch();
    assert.equal(item.shown.length, 1);
    assert.equal(item.shown[0].payload.title, '4 task updates');
    assert.match(item.shown[0].payload.body, /2 failed/);
    assert.match(item.shown[0].payload.body, /2 completed/);
    assert.doesNotMatch(item.shown[0].payload.body, /started/);
  } finally {
    item.service.close();
    await item.cleanup();
  }
});

test('each event preference independently blocks its matching transition', async () => {
  const item = await fixture();
  try {
    await item.service.update(scope, {
      enabled: true,
      taskStarted: false,
      taskCompleted: false,
      taskFailed: false,
      taskNeedsAttention: false,
    });
    const cases = [
      transition('processing', 'queued', 'off-started'),
      transition('completed', 'processing', 'off-completed'),
      transition('failed', 'processing', 'off-failed'),
      transition('action_required', 'processing', 'off-attention'),
    ];
    for (const event of cases) {
      assert.equal((await item.service.publish(scope, event)).accepted, false);
    }
    await settleBatch();
    assert.equal(item.shown.length, 0);
  } finally {
    item.service.close();
    await item.cleanup();
  }
});

test('disabling a queued event kind suppresses it while the preference write is unresolved', async () => {
  const writeStarted = deferred<void>();
  const releaseWrite = deferred<void>();
  let holdWrite = false;
  const item = await fixture({
    beforePersist: async () => {
      if (!holdWrite) return;
      writeStarted.resolve();
      await releaseWrite.promise;
    },
  });
  try {
    await item.service.update(scope, { enabled: true, taskCompleted: true });
    assert.equal((await item.service.publish(
      scope, transition('failed', 'processing', 'queued-failure'),
    )).accepted, true);
    assert.equal((await item.service.publish(
      scope, transition('completed', 'processing', 'queued-completion'),
    )).accepted, true);

    holdWrite = true;
    const update = item.service.update(scope, { taskFailed: false });
    await writeStarted.promise;
    assert.equal((await item.service.get(scope)).preferences.taskFailed, true);
    await settleBatch();

    assert.equal(item.shown.length, 1);
    assert.equal(item.shown[0].payload.title, 'Task completed');
    releaseWrite.resolve();
    assert.equal((await update).preferences.taskFailed, false);
  } finally {
    releaseWrite.resolve();
    item.service.close();
    await item.cleanup();
  }
});

test('mixed batches group only event kinds still enabled when they flush', async () => {
  const item = await fixture();
  try {
    await item.service.update(scope, { enabled: true, taskCompleted: true });
    assert.equal((await item.service.publish(
      scope, transition('failed', 'processing', 'failed-a'),
    )).accepted, true);
    assert.equal((await item.service.publish(
      scope, transition('failed', 'processing', 'failed-b'),
    )).accepted, true);
    assert.equal((await item.service.publish(
      scope, transition('action_required', 'processing', 'attention-a'),
    )).accepted, true);
    assert.equal((await item.service.publish(
      scope, transition('action_required', 'processing', 'attention-b'),
    )).accepted, true);
    assert.equal((await item.service.publish(
      scope, transition('completed', 'processing', 'completed-a'),
    )).accepted, true);
    assert.equal((await item.service.publish(
      scope, transition('completed', 'processing', 'completed-b'),
    )).accepted, true);

    await item.service.update(scope, { taskFailed: false });
    await settleBatch();

    assert.equal(item.shown.length, 1);
    assert.equal(item.shown[0].payload.title, '4 task updates');
    assert.match(item.shown[0].payload.body, /2 need attention/);
    assert.match(item.shown[0].payload.body, /2 completed/);
    assert.doesNotMatch(item.shown[0].payload.body, /failed/);
  } finally {
    item.service.close();
    await item.cleanup();
  }
});

test('disable, stale scopes, and cleanup clear pending delivery immediately', async () => {
  const item = await fixture();
  try {
    await item.service.update(scope, { enabled: true, taskStarted: true });
    assert.equal((await item.service.publish(scope, transition('processing', 'queued'))).accepted, true);
    await item.service.update(scope, { enabled: false });
    await settleBatch();
    assert.equal(item.shown.length, 0);

    await item.service.update(scope, { enabled: true });
    item.deactivate();
    assert.equal((await item.service.publish(scope, transition('failed', 'processing', 'stale'))).accepted, false);
    assert.rejects(item.service.get(scope), /Stale desktop notification scope/);
    item.service.close();
  } finally {
    await item.cleanup();
  }
});

test('test and task clicks route only while the original scope remains authorized', async () => {
  const item = await fixture();
  try {
    await item.service.update(scope, { enabled: true });
    assert.equal((await item.service.test(scope)).status, 'accepted');
    item.shown[0].click();
    assert.deepEqual(item.navigated, ['/tasks']);

    assert.equal((await item.service.publish(scope, transition('failed', 'processing'))).accepted, true);
    await settleBatch();
    item.deactivate();
    item.shown[1].click();
    assert.deepEqual(item.navigated, ['/tasks']);
  } finally {
    item.service.close();
    await item.cleanup();
  }
});

test('account switches invalidate old pending clicks even when the transport scope is unchanged', async () => {
  const item = await fixture();
  const nextScope = { ...scope, userId: 'user-b' };
  try {
    await item.service.update(scope, { enabled: true });
    await item.service.test(scope);
    item.setUser('user-b');
    await item.service.get(nextScope);
    item.shown[0].click();
    assert.deepEqual(item.navigated, []);
    assert.equal(item.shown[0].closed, true);
  } finally {
    item.service.close();
    await item.cleanup();
  }
});

test('clearing an old scope leaves the active scope notification open', async () => {
  const item = await fixture();
  const nextScope = { ...scope, userId: 'user-b' };
  try {
    await item.service.get(scope);
    item.setUser(nextScope.userId);
    await item.service.update(nextScope, { enabled: true });
    assert.equal((await item.service.test(nextScope)).status, 'accepted');

    item.service.clear(scope);

    assert.equal(item.shown[0].closed, false);
    item.shown[0].click();
    assert.deepEqual(item.navigated, ['/tasks']);
  } finally {
    item.service.close();
    await item.cleanup();
  }
});

test('rate limits repeated small batches across the delivery window', async () => {
  const item = await fixture();
  try {
    await item.service.update(scope, { enabled: true });
    for (let index = 0; index < 7; index += 1) {
      assert.equal((await item.service.publish(
        scope, transition('failed', 'processing', `rate-${index}`, index + 2),
      )).accepted, true);
      await settleBatch();
    }
    assert.equal(item.shown.length, 6);
    assert.equal((await item.service.test(scope)).status, 'not-attempted');
    assert.equal(item.shown.length, 6);
  } finally {
    item.service.close();
    await item.cleanup();
  }
});

test('rejects extra fields and malformed notification scopes at the native boundary', () => {
  assert.equal(isDesktopNotificationScope(scope), true);
  assert.equal(isDesktopNotificationScope({ ...scope, token: 'secret' }), false);
  assert.equal(isDesktopTaskTransition({ ...transition('failed', 'processing'), metadata: { output: 'no' } }), false);
  assert.equal(isDesktopTaskTransition({ ...transition('failed', 'processing'), repository: 'not-a-repo' }), false);
});
