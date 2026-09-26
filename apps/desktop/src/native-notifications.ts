import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  isDesktopNotificationScope,
  type DesktopNotificationCapability,
  type DesktopNotificationPreferences,
  type DesktopNotificationScope,
  type DesktopNotificationSettings,
  type DesktopNotificationTestResult,
  type DesktopPlatform,
  type DesktopTaskTransition,
} from './shared/contract';

export { isDesktopNotificationScope } from './shared/contract';

export const DEFAULT_DESKTOP_NOTIFICATION_PREFERENCES: DesktopNotificationPreferences = Object.freeze({
  enabled: false,
  taskStarted: false,
  taskCompleted: false,
  taskFailed: true,
  taskNeedsAttention: true,
});

type NotificationKind = 'started' | 'completed' | 'failed' | 'needs-attention';

interface StoredPreferences {
  version: 1;
  accounts: Record<string, DesktopNotificationPreferences>;
}

export interface NativeNotificationHandle {
  close(): void;
}

export interface NativeNotificationPayload {
  title: string;
  body: string;
}

export interface NativeNotificationEvents {
  click(): void;
  close(): void;
  failed(): void;
  shown(): void;
}

interface PendingNotice {
  scope: DesktopNotificationScope;
  kind: NotificationKind;
  taskId: string;
  repository?: string;
  issueNumber?: number;
}

interface TaskTransitionCursor {
  occurredAt: number;
  version?: number;
}

export interface NativeNotificationServiceOptions {
  statePath: string;
  platform: DesktopPlatform;
  isSupported(): boolean;
  isActiveScope(scope: DesktopNotificationScope): boolean;
  show(payload: NativeNotificationPayload, events: NativeNotificationEvents): NativeNotificationHandle;
  navigate(path: string): void;
  now?: () => number;
  batchDelayMs?: number;
  testDeliveryTimeoutMs?: number;
  beforePersist?(): Promise<void>;
  log?(level: 'warn' | 'error', event: string): void;
  onSettingsChanged?(scope?: DesktopNotificationScope): void;
}

const SAFE_TASK_PATTERN = /^[^\x00-\x1f\x7f]{1,512}$/;
const SAFE_REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const PROCESSING_STATES = new Set(['processing', 'claude_execution', 'post_processing']);
const ATTENTION_STATES = new Set(['action_required', 'action-required', 'needs_attention', 'needs-attention']);
const TERMINAL_KINDS = new Set<NotificationKind>(['completed', 'failed']);
const MAX_EVENT_AGE_MS = 2 * 60_000;
const MAX_FUTURE_SKEW_MS = 60_000;
const MAX_REMEMBERED_EVENTS = 2_048;
const MAX_STORED_ACCOUNTS = 1_000;
const MAX_INDIVIDUAL_BURST = 3;
const DELIVERY_RATE_WINDOW_MS = 30_000;
const MAX_DELIVERIES_PER_WINDOW = 6;
const TEST_DELIVERY_TIMEOUT_MS = 3_000;

type NativeNotificationDeliveryStatus = Exclude<DesktopNotificationTestResult['status'], 'not-attempted'>;

interface NativeNotificationAttempt {
  delivery: Promise<NativeNotificationDeliveryStatus>;
}

interface LiveNotification {
  handle: NativeNotificationHandle;
  scope: DesktopNotificationScope;
  cancel(): void;
}

const copyDefaults = (): DesktopNotificationPreferences => ({
  ...DEFAULT_DESKTOP_NOTIFICATION_PREFERENCES,
});

export const isDesktopTaskTransition = (value: unknown): value is DesktopTaskTransition => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  if (!Object.keys(event).every(key => [
    'taskId', 'state', 'previousState', 'repository', 'issueNumber', 'timestamp', 'version',
  ].includes(key))) return false;
  if (typeof event.taskId !== 'string' || !SAFE_TASK_PATTERN.test(event.taskId)
    || typeof event.state !== 'string' || event.state.length < 1 || event.state.length > 64
    || typeof event.previousState !== 'string' || event.previousState.length < 1
    || event.previousState.length > 64
    || typeof event.timestamp !== 'string' || Number.isNaN(Date.parse(event.timestamp))) return false;
  if (event.repository !== undefined && (
    typeof event.repository !== 'string' || event.repository.length > 256
    || !SAFE_REPOSITORY_PATTERN.test(event.repository)
  )) return false;
  if (event.issueNumber !== undefined && (
    !Number.isSafeInteger(event.issueNumber) || (event.issueNumber as number) < 1
  )) return false;
  return event.version === undefined || (
    Number.isSafeInteger(event.version) && (event.version as number) >= 0
  );
};

const transitionKind = (event: DesktopTaskTransition): NotificationKind | null => {
  if (event.state === event.previousState) return null;
  if (event.state === 'completed') return 'completed';
  if (event.state === 'failed') return 'failed';
  if (ATTENTION_STATES.has(event.state)) return 'needs-attention';
  if (PROCESSING_STATES.has(event.state) && !PROCESSING_STATES.has(event.previousState)) return 'started';
  return null;
};

const preferenceForKind = (
  preferences: DesktopNotificationPreferences,
  kind: NotificationKind,
): boolean => kind === 'started' ? preferences.taskStarted
  : kind === 'completed' ? preferences.taskCompleted
    : kind === 'failed' ? preferences.taskFailed
      : preferences.taskNeedsAttention;

const isPreferences = (value: unknown): value is DesktopNotificationPreferences => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(DEFAULT_DESKTOP_NOTIFICATION_PREFERENCES).every(
    key => typeof record[key] === 'boolean',
  ) && Object.keys(record).every(key => key in DEFAULT_DESKTOP_NOTIFICATION_PREFERENCES);
};

const safeStoredPreferences = (value: unknown): StoredPreferences | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const state = value as Record<string, unknown>;
  if (state.version !== 1 || !state.accounts || typeof state.accounts !== 'object'
    || Array.isArray(state.accounts)) return null;
  const accounts = state.accounts as Record<string, unknown>;
  if (Object.keys(accounts).length > MAX_STORED_ACCOUNTS
    || !Object.values(accounts).every(isPreferences)) return null;
  return { version: 1, accounts: accounts as Record<string, DesktopNotificationPreferences> };
};

const scopeStorageKey = (scope: DesktopNotificationScope): string => createHash('sha256')
  .update(`${scope.profileId}\0${scope.userId}`)
  .digest('base64url');

const sameScope = (left: DesktopNotificationScope, right: DesktopNotificationScope): boolean =>
  left.profileId === right.profileId
  && left.transportScope === right.transportScope
  && left.userId === right.userId;

const isNewerTransition = (
  previous: TaskTransitionCursor | undefined,
  transition: DesktopTaskTransition,
  occurredAt: number,
): boolean => {
  if (!previous) return true;
  if (previous.version !== undefined) {
    return transition.version !== undefined && transition.version > previous.version;
  }
  if (transition.version !== undefined) return true;
  return occurredAt > previous.occurredAt;
};

const taskContext = (notice: PendingNotice): string => {
  const task = notice.issueNumber ? `Task #${notice.issueNumber}` : 'Task';
  return notice.repository ? `${notice.repository} · ${task}` : task;
};

const kindTitle = (kind: NotificationKind): string => kind === 'started' ? 'Task started'
  : kind === 'completed' ? 'Task completed'
    : kind === 'failed' ? 'Task failed'
      : 'Task needs attention';

const groupedBody = (notices: PendingNotice[]): string => {
  const counts = new Map<NotificationKind, number>();
  notices.forEach(notice => counts.set(notice.kind, (counts.get(notice.kind) ?? 0) + 1));
  return ([
    ['failed', 'failed'],
    ['needs-attention', 'need attention'],
    ['completed', 'completed'],
    ['started', 'started'],
  ] as const).flatMap(([kind, label]) => {
    const count = counts.get(kind);
    return count ? [`${count} ${label}`] : [];
  }).join(' · ');
};

export class NativeNotificationService {
  readonly #options: NativeNotificationServiceOptions;
  readonly #now: () => number;
  readonly #batchDelayMs: number;
  readonly #testDeliveryTimeoutMs: number;
  #state: StoredPreferences = { version: 1, accounts: {} };
  #loaded: Promise<void> | null = null;
  #writeTail: Promise<void> = Promise.resolve();
  #pending: PendingNotice[] = [];
  #batchTimer: ReturnType<typeof setTimeout> | null = null;
  #seen = new Map<string, true>();
  #terminal = new Map<string, true>();
  #taskTransitions = new Map<string, TaskTransitionCursor>();
  #live = new Set<LiveNotification>();
  #accountScope: DesktopNotificationScope | null = null;
  #deliveryTimes: number[] = [];
  #closed = false;

  constructor(options: NativeNotificationServiceOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#batchDelayMs = options.batchDelayMs ?? 750;
    this.#testDeliveryTimeoutMs = options.testDeliveryTimeoutMs ?? TEST_DELIVERY_TIMEOUT_MS;
  }

  capability(): DesktopNotificationCapability {
    if (this.#options.platform === 'win32') {
      return { supported: false, platform: 'win32', permission: 'unsupported', reason: 'platform-deferred' };
    }
    const supported = (this.#options.platform === 'linux' || this.#options.platform === 'darwin')
      && this.#options.isSupported();
    return supported
      ? { supported: true, platform: this.#options.platform, permission: 'unknown' }
      : { supported: false, platform: this.#options.platform, permission: 'unsupported', reason: 'native-api-unavailable' };
  }

  async get(scope: DesktopNotificationScope): Promise<DesktopNotificationSettings> {
    this.#requireActiveScope(scope);
    this.#activateScope(scope);
    await this.#load();
    const settings = this.#settings(scope);
    this.#options.onSettingsChanged?.();
    return settings;
  }

  async update(
    scope: DesktopNotificationScope,
    update: Partial<DesktopNotificationPreferences>,
  ): Promise<DesktopNotificationSettings> {
    return this.#update(scope, update, false);
  }

  async #update(
    scope: DesktopNotificationScope,
    update: Partial<DesktopNotificationPreferences>,
    requireCurrentScope: boolean,
  ): Promise<DesktopNotificationSettings> {
    this.#requireActiveScope(scope);
    if (!update || typeof update !== 'object' || Array.isArray(update)
      || Object.keys(update).length === 0
      || !Object.keys(update).every(key => key in DEFAULT_DESKTOP_NOTIFICATION_PREFERENCES)
      || !Object.values(update).every(value => typeof value === 'boolean')) {
      throw new Error('Invalid desktop notification preferences');
    }
    this.#activateScope(scope);
    await this.#load();
    if (requireCurrentScope && !this.#isCurrentScope(scope)) {
      throw new Error('No active notification account');
    }
    const key = scopeStorageKey(scope);
    if (update.enabled === false) this.#clearDeliveries(scope);
    else this.#removeDisabledPending(scope, update);
    const settings = await this.#queueUpdate(scope, key, update, requireCurrentScope);
    this.#options.onSettingsChanged?.(scope);
    return settings;
  }

  activeSettings(): DesktopNotificationSettings | null {
    const scope = this.#accountScope;
    return scope && this.#loaded && this.#isCurrentScope(scope) ? this.#settings(scope) : null;
  }

  activeScope(): DesktopNotificationScope | null {
    const scope = this.#accountScope;
    return scope && this.#isCurrentScope(scope) ? { ...scope } : null;
  }

  async setActiveEnabled(scope: DesktopNotificationScope, enabled: boolean): Promise<void> {
    if (!this.#isCurrentScope(scope)) throw new Error('No active notification account');
    await this.#update(scope, { enabled }, true);
  }

  async test(scope: DesktopNotificationScope): Promise<DesktopNotificationTestResult> {
    this.#requireActiveScope(scope);
    this.#activateScope(scope);
    await this.#load();
    const settings = this.#settings(scope);
    if (!settings.capability.supported || !settings.preferences.enabled) {
      return { status: 'not-attempted' };
    }
    const attempt = this.#display(scope, {
      title: 'Desktop notifications are ready',
      body: 'ProPR can send task status updates on this device.',
    }, '/tasks');
    if (!attempt) return { status: 'not-attempted' };
    return { status: await this.#boundedTestDelivery(attempt.delivery) };
  }

  async publish(
    scope: DesktopNotificationScope,
    transition: DesktopTaskTransition,
  ): Promise<{ accepted: boolean }> {
    if (this.#closed || !isDesktopNotificationScope(scope) || !isDesktopTaskTransition(transition)
      || !this.#isCurrentScope(scope)) return { accepted: false };
    const kind = transitionKind(transition);
    if (!kind) return { accepted: false };
    const occurredAt = Date.parse(transition.timestamp);
    const now = this.#now();
    if (occurredAt < now - MAX_EVENT_AGE_MS || occurredAt > now + MAX_FUTURE_SKEW_MS) {
      return { accepted: false };
    }
    await this.#load();
    const preferences = this.#state.accounts[scopeStorageKey(scope)] ?? copyDefaults();
    if (!preferences.enabled || !this.capability().supported) {
      return { accepted: false };
    }
    const scopeKey = scopeStorageKey(scope);
    const eventKey = `${scopeKey}:${transition.taskId}:${kind}:${transition.version ?? transition.timestamp}`;
    const taskKey = `${scopeKey}:${transition.taskId}`;
    if (this.#seen.has(eventKey)
      || !isNewerTransition(this.#taskTransitions.get(taskKey), transition, occurredAt)) {
      return { accepted: false };
    }
    this.#remember(this.#seen, eventKey);
    this.#rememberTransition(taskKey, { occurredAt, version: transition.version });
    if (kind === 'started') {
      this.#terminal.delete(`${taskKey}:completed`);
      this.#terminal.delete(`${taskKey}:failed`);
    }
    if (!preferenceForKind(preferences, kind)) return { accepted: false };
    const terminalKey = `${scopeKey}:${transition.taskId}:${kind}`;
    if (TERMINAL_KINDS.has(kind) && this.#terminal.has(terminalKey)) {
      return { accepted: false };
    }
    if (TERMINAL_KINDS.has(kind)) this.#remember(this.#terminal, terminalKey);
    this.#pending.push({
      scope: { ...scope }, kind, taskId: transition.taskId,
      repository: transition.repository, issueNumber: transition.issueNumber,
    });
    this.#batchTimer ??= setTimeout(() => this.#flush(), this.#batchDelayMs);
    return { accepted: true };
  }

  clear(scope?: DesktopNotificationScope): void {
    this.#clearDeliveries(scope);
    if (!scope || (this.#accountScope && sameScope(this.#accountScope, scope))) this.#accountScope = null;
    this.#options.onSettingsChanged?.(scope);
  }

  #clearDeliveries(scope?: DesktopNotificationScope): void {
    const matches = (notice: PendingNotice): boolean => !scope || sameScope(notice.scope, scope);
    this.#pending = this.#pending.filter(notice => !matches(notice));
    if (this.#pending.length === 0 && this.#batchTimer) {
      clearTimeout(this.#batchTimer);
      this.#batchTimer = null;
    }
    if (!scope || (this.#accountScope && sameScope(this.#accountScope, scope))) {
      for (const notification of [...this.#live]) {
        if (scope && !sameScope(notification.scope, scope)) continue;
        this.#live.delete(notification);
        notification.cancel();
        notification.handle.close();
      }
    }
  }

  #removeDisabledPending(
    scope: DesktopNotificationScope,
    update: Partial<DesktopNotificationPreferences>,
  ): void {
    const disabledKinds = new Set<NotificationKind>();
    if (update.taskStarted === false) disabledKinds.add('started');
    if (update.taskCompleted === false) disabledKinds.add('completed');
    if (update.taskFailed === false) disabledKinds.add('failed');
    if (update.taskNeedsAttention === false) disabledKinds.add('needs-attention');
    if (disabledKinds.size === 0) return;
    this.#pending = this.#pending.filter(notice => (
      !sameScope(notice.scope, scope) || !disabledKinds.has(notice.kind)
    ));
    if (this.#pending.length === 0 && this.#batchTimer) {
      clearTimeout(this.#batchTimer);
      this.#batchTimer = null;
    }
  }

  close(): void {
    this.#closed = true;
    this.clear();
    this.#seen.clear();
    this.#terminal.clear();
    this.#taskTransitions.clear();
    this.#deliveryTimes = [];
  }

  async idle(): Promise<void> {
    await this.#writeTail;
  }

  #requireActiveScope(scope: DesktopNotificationScope): void {
    if (!isDesktopNotificationScope(scope) || !this.#options.isActiveScope(scope)) {
      throw new Error('Stale desktop notification scope');
    }
  }

  #activateScope(scope: DesktopNotificationScope): void {
    if (this.#accountScope && !sameScope(this.#accountScope, scope)) {
      this.#clearDeliveries();
      this.#seen.clear();
      this.#terminal.clear();
      this.#taskTransitions.clear();
    }
    this.#accountScope = { ...scope };
  }

  #isCurrentScope(scope: DesktopNotificationScope): boolean {
    return Boolean(this.#accountScope && sameScope(this.#accountScope, scope)
      && this.#options.isActiveScope(scope));
  }

  #settings(scope: DesktopNotificationScope): DesktopNotificationSettings {
    return {
      preferences: { ...(this.#state.accounts[scopeStorageKey(scope)] ?? copyDefaults()) },
      capability: this.capability(),
      scope: 'account-instance-device',
    };
  }

  #remember(map: Map<string, true>, key: string): void {
    map.set(key, true);
    if (map.size > MAX_REMEMBERED_EVENTS) {
      const oldest = map.keys().next().value;
      if (oldest) map.delete(oldest);
    }
  }

  #rememberTransition(key: string, cursor: TaskTransitionCursor): void {
    this.#taskTransitions.delete(key);
    this.#taskTransitions.set(key, cursor);
    if (this.#taskTransitions.size > MAX_REMEMBERED_EVENTS) {
      const oldest = this.#taskTransitions.keys().next().value;
      if (oldest) this.#taskTransitions.delete(oldest);
    }
  }

  #flush(): void {
    this.#batchTimer = null;
    const pending = this.#pending.splice(0);
    const active = pending.filter(notice => {
      if (!this.#isCurrentScope(notice.scope)) return false;
      const preferences = this.#state.accounts[scopeStorageKey(notice.scope)] ?? copyDefaults();
      return preferences.enabled && preferenceForKind(preferences, notice.kind);
    });
    const groups = new Map<string, PendingNotice[]>();
    active.forEach(notice => {
      const key = `${notice.scope.profileId}\0${notice.scope.transportScope}\0${notice.scope.userId}`;
      groups.set(key, [...(groups.get(key) ?? []), notice]);
    });
    for (const notices of groups.values()) {
      const scope = notices[0].scope;
      const available = this.#availableDeliveries();
      if (available === 0) continue;
      if (notices.length > MAX_INDIVIDUAL_BURST || notices.length > available) {
        this.#display(scope, {
          title: `${notices.length} task updates`,
          body: groupedBody(notices),
        }, '/tasks');
        continue;
      }
      for (const notice of notices) {
        this.#display(scope, { title: kindTitle(notice.kind), body: taskContext(notice) },
          `/tasks/${encodeURIComponent(notice.taskId)}`);
      }
    }
  }

  #display(
    scope: DesktopNotificationScope,
    payload: NativeNotificationPayload,
    path: string,
  ): NativeNotificationAttempt | null {
    if (this.#closed || !this.#isCurrentScope(scope) || this.#availableDeliveries() === 0) return null;
    this.#deliveryTimes.push(this.#now());
    let settleDelivery!: (status: NativeNotificationDeliveryStatus) => void;
    let deliverySettled = false;
    let terminal = false;
    let live: LiveNotification | null = null;
    const delivery = new Promise<NativeNotificationDeliveryStatus>(resolve => {
      settleDelivery = status => {
        if (deliverySettled) return;
        deliverySettled = true;
        resolve(status);
      };
    });
    const remove = (): void => {
      terminal = true;
      if (live) this.#live.delete(live);
    };
    const fail = (): void => {
      if (terminal) return;
      remove();
      settleDelivery('failed');
      this.#options.log?.('warn', 'desktop.notifications.delivery_failed');
    };
    try {
      const handle = this.#options.show(payload, {
        click: () => {
          remove();
          settleDelivery('accepted');
          if (!this.#closed && this.#isCurrentScope(scope)) this.#options.navigate(path);
        },
        close: () => {
          remove();
          settleDelivery('cancelled');
        },
        failed: fail,
        shown: () => settleDelivery('accepted'),
      });
      live = {
        handle,
        scope: { ...scope },
        cancel: () => settleDelivery('cancelled'),
      };
      if (!terminal) this.#live.add(live);
    } catch {
      fail();
    }
    return { delivery };
  }

  async #boundedTestDelivery(
    delivery: Promise<NativeNotificationDeliveryStatus>,
  ): Promise<NativeNotificationDeliveryStatus> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unconfirmed = new Promise<NativeNotificationDeliveryStatus>(resolve => {
      timer = setTimeout(() => resolve('unconfirmed'), this.#testDeliveryTimeoutMs);
    });
    try {
      return await Promise.race([delivery, unconfirmed]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  #availableDeliveries(): number {
    const cutoff = this.#now() - DELIVERY_RATE_WINDOW_MS;
    this.#deliveryTimes = this.#deliveryTimes.filter(timestamp => timestamp > cutoff);
    return Math.max(0, MAX_DELIVERIES_PER_WINDOW - this.#deliveryTimes.length);
  }

  #load(): Promise<void> {
    if (this.#loaded) return this.#loaded;
    this.#loaded = readFile(this.#options.statePath, 'utf8').then(contents => {
      const parsed = safeStoredPreferences(JSON.parse(contents));
      if (parsed) this.#state = parsed;
      else this.#options.log?.('warn', 'desktop.notifications.preferences_invalid');
    }).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.#options.log?.('warn', 'desktop.notifications.preferences_load_failed');
      }
    });
    return this.#loaded;
  }

  #queueUpdate(
    scope: DesktopNotificationScope,
    key: string,
    update: Partial<DesktopNotificationPreferences>,
    requireCurrentScope: boolean,
  ): Promise<DesktopNotificationSettings> {
    const operation = this.#writeTail.then(async () => {
      if (requireCurrentScope && !this.#isCurrentScope(scope)) {
        throw new Error('No active notification account');
      }
      const current = this.#state.accounts[key];
      if (!current && Object.keys(this.#state.accounts).length >= MAX_STORED_ACCOUNTS) {
        throw new Error('Desktop notification preference account limit reached');
      }
      const nextState: StoredPreferences = {
        version: 1,
        accounts: {
          ...this.#state.accounts,
          [key]: { ...(current ?? copyDefaults()), ...update },
        },
      };
      await this.#persist(nextState);
      this.#state = nextState;
      return this.#settings(scope);
    });
    this.#writeTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #persist(state: StoredPreferences): Promise<void> {
    const contents = `${JSON.stringify(state, null, 2)}\n`;
    const temporary = `${this.#options.statePath}.tmp`;
    try {
      await this.#options.beforePersist?.();
      await mkdir(dirname(this.#options.statePath), { recursive: true, mode: 0o700 });
      await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.#options.statePath);
    } catch {
      this.#options.log?.('error', 'desktop.notifications.preferences_save_failed');
      throw new Error('Desktop notification preferences could not be saved');
    }
  }
}
