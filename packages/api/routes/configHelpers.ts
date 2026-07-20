import { RedisClientType } from 'redis';
import { db } from '@propr/core';
import * as configManager from '@propr/core';
import type { Knex } from 'knex';
export { validateAgentsConfig, normalizeAgentsConfig } from './configAgentValidation.js';
export { extractSettingSaves, type LabeledSaveDescriptor, type SettingSaveName } from './configSettings.js';

export const SETTINGS_CONFIG_LOCK_KEY = 'config:settings:lock';
export const SPECIALIZED_SETTING_NAMES = [
  'auto_followup_score_threshold',
  'auto_resolve_merge_conflicts',
  'model_reasoning_level',
  'pr_review_model',
  'ultrafix_rating_goal',
  'ultrafix_max_cycles',
  'ultrafix_pause_seconds'
] as const;
const DEFAULT_LOCK_TIMEOUT_SECONDS = 30;
const DEFAULT_LOCK_RENEWAL_INTERVAL_MS = 10_000;
interface ConfigLockOptions { timeoutSeconds?: number; renewalIntervalMs?: number; }
interface RedisScriptClient { eval?: (script: string, options: { keys: string[]; arguments: string[] }) => Promise<unknown>; }
interface RedisTransaction { expire: (key: string, seconds: number) => RedisTransaction; del: (key: string) => RedisTransaction; exec: () => Promise<unknown[] | null>; }
interface RedisWatchClient { watch?: (...keys: string[]) => Promise<void>; unwatch?: () => Promise<void>; multi?: () => RedisTransaction; }
interface LostConfigLockDetails { detected: boolean; reason: 'ownership_lost' | 'renewal_error' | null; }
export interface ConfigLockContext {
  assertLockHeld: () => Promise<void>;
  hasLockBeenLost: () => boolean;
  markCommitted: () => void;
}
export class ConfigRouteError extends Error {
  status: number;
  body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>, message?: string) {
    super(message ?? (typeof body.error === 'string' ? body.error : 'Configuration update failed'));
    this.name = 'ConfigRouteError';
    this.status = status;
    this.body = body;
  }
}
const EXTEND_LOCK_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("expire", KEYS[1], tonumber(ARGV[2]))
end
return 0`;
const RELEASE_LOCK_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0`;
function buildLockLossResponse(reason: LostConfigLockDetails['reason']): { status: number; body: Record<string, unknown> } {
  const error = reason === 'ownership_lost'
    ? 'Configuration update lock was lost before the operation completed. Verify the current configuration before retrying.'
    : 'Configuration update lock renewal failed before the operation completed. Verify the current configuration before retrying.';
  return { status: 409, body: { error, lock_lost: true } };
}
function buildCommittedLockLossResponse(
  result: { status: number; body: Record<string, unknown> } | null,
  reason: LostConfigLockDetails['reason']
): { status: number; body: Record<string, unknown> } {
  const warning = reason === 'ownership_lost'
    ? 'Configuration changes were committed, but the update lock was lost afterward. Verify the current configuration before retrying.'
    : 'Configuration changes were committed, but lock renewal failed afterward. Verify the current configuration before retrying.';
  return {
    status: result && result.status >= 400 ? result.status : 409,
    body: {
      ...(result?.body ?? {}),
      warning,
      committed: true,
      lock_lost_after_commit: true
    }
  };
}
function supportsAtomicLockScripting(redisClient: RedisClientType): boolean {
  return typeof (redisClient as RedisClientType & RedisScriptClient).eval === 'function';
}
async function runWatchedLockOperation(redisClient: RedisClientType, lockKey: string, lockValue: string, apply: (transaction: RedisTransaction) => RedisTransaction): Promise<boolean | null> {
  const watchClient = redisClient as RedisClientType & RedisWatchClient;
  if (typeof watchClient.watch !== 'function' || typeof watchClient.multi !== 'function') {
    return null;
  }
  let watchActive = false;
  try {
    await watchClient.watch(lockKey);
    watchActive = true;
    const currentLockValue = await redisClient.get(lockKey);
    if (currentLockValue !== lockValue) {
      if (typeof watchClient.unwatch === 'function') {
        await watchClient.unwatch();
      }
      return false;
    }
    const result = await apply(watchClient.multi()).exec();
    watchActive = false;
    return result !== null;
  } catch (error) {
    if (watchActive && typeof watchClient.unwatch === 'function') {
      try {
        await watchClient.unwatch();
      } catch (unwatchError) {
        console.error(`Failed to clear Redis watch for config lock ${lockKey}:`, unwatchError);
      }
    }
    throw error;
  }
}
async function renewLock(redisClient: RedisClientType, lockKey: string, lockValue: string, timeoutSeconds: number): Promise<boolean> {
  const scriptClient = redisClient as RedisClientType & RedisScriptClient;
  if (supportsAtomicLockScripting(redisClient)) {
    const result = await scriptClient.eval(EXTEND_LOCK_SCRIPT, { keys: [lockKey], arguments: [lockValue, String(timeoutSeconds)] });
    return result === 1;
  }
  const watchedResult = await runWatchedLockOperation(redisClient, lockKey, lockValue, transaction => transaction.expire(lockKey, timeoutSeconds));
  if (watchedResult !== null) {
    return watchedResult;
  }
  throw new Error(`Atomic config lock renewal is unavailable for ${lockKey}; Redis client must support eval or watch/multi`);
}
async function releaseLock(redisClient: RedisClientType, lockKey: string, lockValue: string): Promise<void> {
  const scriptClient = redisClient as RedisClientType & RedisScriptClient;
  if (typeof scriptClient.eval === 'function') {
    await scriptClient.eval(RELEASE_LOCK_SCRIPT, { keys: [lockKey], arguments: [lockValue] });
    return;
  }
  const watchedResult = await runWatchedLockOperation(redisClient, lockKey, lockValue, transaction => transaction.del(lockKey));
  if (watchedResult !== null) {
    return;
  }
  console.warn(`Atomic config lock release is unavailable for ${lockKey}; Redis client should support eval or watch/multi, otherwise the TTL will expire naturally`);
}
export async function upsertConfigValue(trx: Knex.Transaction, key: string, value: unknown): Promise<void> {
  const jsonValue = JSON.stringify(value);
  await trx('system_configs')
    .insert({
      key,
      value: jsonValue,
      updated_at: db.fn.now(),
      created_at: db.fn.now()
    })
    .onConflict('key')
    .merge({
      value: jsonValue,
      updated_at: db.fn.now()
    });
}
export function buildMergedSettings(previousSettings: Record<string, unknown>, settingsPatch: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!settingsPatch) {
    return null;
  }
  const mergedSettings = { ...previousSettings, ...settingsPatch };
  for (const [key, value] of Object.entries(mergedSettings)) {
    if (value === undefined) {
      delete mergedSettings[key];
    }
  }
  return mergedSettings;
}
export function stripSpecializedSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const sanitized = { ...settings };
  for (const key of SPECIALIZED_SETTING_NAMES) {
    delete sanitized[key];
  }
  return sanitized;
}
export async function loadPersistedSettingsRecord(configStore: {
  loadSettings: typeof configManager.loadSettings;
  loadSettingsRecord?: () => Promise<Record<string, unknown>>;
}): Promise<Record<string, unknown>> {
  if (typeof configStore.loadSettingsRecord === 'function') {
    return configStore.loadSettingsRecord();
  }
  if (configStore === configManager) {
    return configManager.getConfig<Record<string, unknown>>('settings', {});
  }
  const settings = await configStore.loadSettings();
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return {};
  }
  return { ...(settings as Record<string, unknown>) };
}
export async function withConfigLock(redisClient: RedisClientType, lockKey: string, operation: (context: ConfigLockContext) => Promise<{ status: number; body: Record<string, unknown> }>, options: ConfigLockOptions = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const lockValue = `${Date.now()}-${Math.random()}`;
  const lockTimeout = options.timeoutSeconds ?? DEFAULT_LOCK_TIMEOUT_SECONDS;
  const renewalIntervalMs = options.renewalIntervalMs ?? DEFAULT_LOCK_RENEWAL_INTERVAL_MS;
  let renewalTimer: NodeJS.Timeout | null = null;
  let renewalStopped = false;
  const lostLock: LostConfigLockDetails = { detected: false, reason: null };
  let committed = false;
  const markLockLost = (reason: LostConfigLockDetails['reason'], error?: unknown): void => {
    if (renewalStopped || lostLock.detected) return;
    lostLock.detected = true;
    lostLock.reason = reason;
    if (renewalTimer) { clearTimeout(renewalTimer); renewalTimer = null; }
    if (reason === 'ownership_lost') {
      console.error(`Lost ownership of config lock ${lockKey} before the protected operation completed`);
      return;
    }
    console.error(`Failed to renew config lock ${lockKey}:`, error);
  };
  const throwLockLossError = (): never => {
    if (lostLock.reason === 'renewal_error') throw new Error(`Config lock ${lockKey} renewal failed before protected operation completed`);
    throw new Error(`Config lock ${lockKey} ownership lost before protected operation completed`);
  };
  const scheduleRenewal = (): void => {
    if (renewalStopped || renewalIntervalMs <= 0) return;
    renewalTimer = setTimeout(() => {
      void renewLock(redisClient, lockKey, lockValue, lockTimeout)
        .then(renewed => {
          if (!renewed) return markLockLost('ownership_lost');
          scheduleRenewal();
        })
        .catch(error => {
          markLockLost('renewal_error', error);
        });
    }, renewalIntervalMs);
  };
  const context: ConfigLockContext = {
    assertLockHeld: async () => {
      if (lostLock.detected) throwLockLossError();
      const renewed = await renewLock(redisClient, lockKey, lockValue, lockTimeout);
      if (!renewed) { markLockLost('ownership_lost'); throwLockLossError(); }
    },
    hasLockBeenLost: () => lostLock.detected,
    markCommitted: () => { committed = true; }
  };
  let result: { status: number; body: Record<string, unknown> } | null = null;
  let lockAcquired = false;
  try {
    const acquired = await redisClient.set(lockKey, lockValue, { NX: true, EX: lockTimeout });
    if (!acquired) {
      return { status: 409, body: { error: 'Configuration is being updated. Please try again.' } };
    }
    lockAcquired = true;
    scheduleRenewal();
    result = await operation(context);
    if (lostLock.detected) {
      if (committed) {
        return buildCommittedLockLossResponse(result, lostLock.reason);
      }
      return buildLockLossResponse(lostLock.reason);
    }
    return result;
  } catch (error) {
    if (lostLock.detected) {
      if (committed) {
        return buildCommittedLockLossResponse(result, lostLock.reason);
      }
      return buildLockLossResponse(lostLock.reason);
    }
    if (error instanceof ConfigRouteError) {
      return { status: error.status, body: error.body };
    }
    console.error(`Error in config operation with lock ${lockKey}:`, error);
    return { status: 500, body: { error: 'Failed to update configuration' } };
  } finally {
    renewalStopped = true;
    if (renewalTimer) clearTimeout(renewalTimer);
    if (lockAcquired) {
      try {
        await releaseLock(redisClient, lockKey, lockValue);
      } catch (unlockError) {
        console.error(`Error releasing config lock ${lockKey}:`, unlockError);
      }
    }
  }
}
