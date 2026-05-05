import { RedisClientType } from 'redis';
import { db } from '@propr/core';
import * as configManager from '@propr/core';
import type { Knex } from 'knex';
import {
  getIndexingQueue, generateCorrelationId, ensureRepoCloned, getRepoUrl, getAuthenticatedOctokit,
  updateRepositoryStatus, requestIndexingCancellation, fetchLatestChanges, validatePrReviewModelValue
} from '@propr/core';
import type { IndexingJobData } from '@propr/core';
interface AgentConfig { id: string; type: string; alias: string; enabled: boolean; dockerImage: string; configPath: string; supportedModels: string[]; }
export const SETTINGS_CONFIG_LOCK_KEY = 'config:settings:lock';
const DEFAULT_LOCK_TIMEOUT_SECONDS = 30, DEFAULT_LOCK_RENEWAL_INTERVAL_MS = 10_000;
interface ConfigLockOptions { timeoutSeconds?: number; renewalIntervalMs?: number; }
interface RedisScriptClient { eval?: (script: string, options: { keys: string[]; arguments: string[] }) => Promise<unknown>; }
interface RedisTransaction { expire: (key: string, seconds: number) => RedisTransaction; del: (key: string) => RedisTransaction; exec: () => Promise<unknown[] | null>; }
interface RedisWatchClient { watch?: (...keys: string[]) => Promise<void>; unwatch?: () => Promise<void>; multi?: () => RedisTransaction; }
interface LostConfigLockDetails { detected: boolean; reason: 'ownership_lost' | 'renewal_error' | null; }
export interface ConfigLockContext { assertLockHeld: () => Promise<void>; hasLockBeenLost: () => boolean; }
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
function supportsAtomicLockScripting(redisClient: RedisClientType): boolean { return typeof (redisClient as RedisClientType & RedisScriptClient).eval === 'function'; }
async function runWatchedLockOperation(redisClient: RedisClientType, lockKey: string, lockValue: string, apply: (transaction: RedisTransaction) => RedisTransaction): Promise<boolean | null> {
  const watchClient = redisClient as RedisClientType & RedisWatchClient;
  if (typeof watchClient.watch !== 'function' || typeof watchClient.multi !== 'function') return null;
  let watchActive = false;
  try {
    await watchClient.watch(lockKey);
    watchActive = true;
    const currentLockValue = await redisClient.get(lockKey);
    if (currentLockValue !== lockValue) {
      if (typeof watchClient.unwatch === 'function') await watchClient.unwatch();
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
  const watchedResult = await runWatchedLockOperation(
    redisClient,
    lockKey,
    lockValue,
    transaction => transaction.expire(lockKey, timeoutSeconds)
  );
  if (watchedResult !== null) return watchedResult;
  throw new Error(`Atomic config lock renewal is unavailable for ${lockKey}`);
}
async function releaseLock(redisClient: RedisClientType, lockKey: string, lockValue: string): Promise<void> {
  const scriptClient = redisClient as RedisClientType & RedisScriptClient;
  if (typeof scriptClient.eval === 'function') {
    await scriptClient.eval(RELEASE_LOCK_SCRIPT, { keys: [lockKey], arguments: [lockValue] });
    return;
  }
  const watchedResult = await runWatchedLockOperation(
    redisClient,
    lockKey,
    lockValue,
    transaction => transaction.del(lockKey)
  );
  if (watchedResult !== null) return;
  console.warn(`Atomic config lock release is unavailable for ${lockKey}; allowing the TTL to expire naturally`);
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
export async function withConfigLock(redisClient: RedisClientType, lockKey: string, operation: (context: ConfigLockContext) => Promise<{ status: number; body: Record<string, unknown> }>, options: ConfigLockOptions = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const lockValue = `${Date.now()}-${Math.random()}`;
  const lockTimeout = options.timeoutSeconds ?? DEFAULT_LOCK_TIMEOUT_SECONDS;
  const renewalIntervalMs = options.renewalIntervalMs ?? DEFAULT_LOCK_RENEWAL_INTERVAL_MS;
  let renewalTimer: NodeJS.Timeout | null = null;
  let renewalStopped = false;
  const lostLock: LostConfigLockDetails = { detected: false, reason: null };
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
      if (!renewed) {
        markLockLost('ownership_lost');
        throwLockLossError();
      }
    },
    hasLockBeenLost: () => lostLock.detected
  };
  let lockAcquired = false;
  try {
    const acquired = await redisClient.set(lockKey, lockValue, { NX: true, EX: lockTimeout });
    if (!acquired) return { status: 409, body: { error: 'Configuration is being updated. Please try again.' } };
    lockAcquired = true;
    scheduleRenewal();
    const result = await operation(context);
    if (lostLock.detected) return buildLockLossResponse(lostLock.reason);
    return result;
  } catch (error) {
    if (lostLock.detected) return buildLockLossResponse(lostLock.reason);
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
export async function queueResummarizationForAllRepos(): Promise<number> {
  const monitoredRepos = await configManager.loadMonitoredRepos();
  const octokit = await getAuthenticatedOctokit();
  const { token } = await octokit.auth({ type: "installation" }) as { token: string };
  let repositoriesQueued = 0;
  for (const repoFullName of monitoredRepos) {
    const queued = await queueResummarizationForRepo(repoFullName, token);
    if (queued) repositoriesQueued++;
  }
  return repositoriesQueued;
}
async function queueResummarizationForRepo(repoFullName: string, token: string): Promise<boolean> {
  const queue = await getIndexingQueue();
  const [owner, name] = repoFullName.split('/');
  const existingJobs = await queue.getJobs(['waiting', 'active', 'delayed']);
  if (existingJobs.some((j: { data: IndexingJobData }) => j.data.repository === repoFullName)) return false;
  const repoUrl = getRepoUrl({ repoOwner: owner, repoName: name });
  let repoPath: string;
  try {
    repoPath = await ensureRepoCloned({ repoUrl, owner, repoName: name, authToken: token });
  } catch {
    console.error(`Failed to clone repository ${repoFullName} for resummarization`);
    return false;
  }
  const fetchResult = await fetchLatestChanges({ owner, repoName: name, authToken: token });
  if (!fetchResult.success) console.warn(`Failed to fetch latest changes for ${repoFullName}: ${fetchResult.error}`);
  const correlationId = generateCorrelationId();
  await queue.add(
    'indexRepository',
    {
      repository: repoFullName,
      repoPath,
      correlationId,
      priority: 'normal',
      fullReindex: true
    },
    {
      jobId: `index-${repoFullName.replace('/', '-')}-prompt-change-${Date.now()}`,
      priority: 2 // Lower priority than manual triggers
    }
  );
  return true;
}
interface SettingFields { auto_followup_score_threshold?: unknown; auto_resolve_merge_conflicts?: unknown; pr_review_model?: unknown; ultrafix_rating_goal?: unknown; ultrafix_max_cycles?: unknown; ultrafix_pause_seconds?: unknown; }
export type SettingSaveName = 'auto_followup_score_threshold' | 'auto_resolve_merge_conflicts' | 'pr_review_model' | 'ultrafix_rating_goal' | 'ultrafix_max_cycles' | 'ultrafix_pause_seconds';
function validateStrictInt(raw: unknown, min: number, max: number): number | null {
  const str = String(raw);
  if (!/^-?\d+$/.test(str)) return null;
  const value = Number(str);
  if (!Number.isSafeInteger(value)) return null;
  return (value < min || value > max) ? null : value;
}
async function validatePrReviewModel(raw: unknown): Promise<{ error?: string; value?: string }> {
  if (typeof raw !== 'string') return { error: 'pr_review_model must be a string' };
  const val = raw.trim();
  if (val === '' && raw.length > 0) {
    return { error: 'pr_review_model must not be whitespace-only; use an empty string to clear' };
  }
  const result = await validatePrReviewModelValue(val);
  if (!result.valid) return { error: result.error };
  return { value: val };
}
export interface LabeledSaveDescriptor { name: SettingSaveName }
export async function extractSettingSaves(fields: SettingFields): Promise<{ error?: string; saves: LabeledSaveDescriptor[]; normalized: Record<string, unknown> }> {
  const saves: LabeledSaveDescriptor[] = [];
  const normalized: Record<string, unknown> = {};
  if (fields.auto_followup_score_threshold !== undefined) {
    const v = validateStrictInt(fields.auto_followup_score_threshold, 0, 9);
    if (v === null) return { error: 'auto_followup_score_threshold must be an integer between 0 and 9', saves: [], normalized };
    normalized.auto_followup_score_threshold = v;
    saves.push({ name: 'auto_followup_score_threshold' });
  }
  if (fields.auto_resolve_merge_conflicts !== undefined) {
    if (typeof fields.auto_resolve_merge_conflicts !== 'boolean') return { error: 'auto_resolve_merge_conflicts must be a boolean', saves: [], normalized };
    const val = fields.auto_resolve_merge_conflicts;
    normalized.auto_resolve_merge_conflicts = val;
    saves.push({ name: 'auto_resolve_merge_conflicts' });
  }
  if (fields.pr_review_model !== undefined) {
    const result = await validatePrReviewModel(fields.pr_review_model);
    if (result.error) return { error: result.error, saves: [], normalized };
    const val = result.value!;
    normalized.pr_review_model = val;
    saves.push({ name: 'pr_review_model' });
  }
  if (fields.ultrafix_rating_goal !== undefined) {
    const v = validateStrictInt(fields.ultrafix_rating_goal, 1, 10);
    if (v === null) return { error: 'ultrafix_rating_goal must be an integer between 1 and 10', saves: [], normalized };
    normalized.ultrafix_rating_goal = v;
    saves.push({ name: 'ultrafix_rating_goal' });
  }
  if (fields.ultrafix_max_cycles !== undefined) {
    const v = validateStrictInt(fields.ultrafix_max_cycles, 1, Infinity);
    if (v === null) return { error: 'ultrafix_max_cycles must be a positive integer', saves: [], normalized };
    normalized.ultrafix_max_cycles = v;
    saves.push({ name: 'ultrafix_max_cycles' });
  }
  if (fields.ultrafix_pause_seconds !== undefined) {
    const v = validateStrictInt(fields.ultrafix_pause_seconds, 0, Infinity);
    if (v === null) return { error: 'ultrafix_pause_seconds must be a non-negative integer', saves: [], normalized };
    normalized.ultrafix_pause_seconds = v;
    saves.push({ name: 'ultrafix_pause_seconds' });
  }
  return { saves, normalized };
}
const ALIAS_REGEX = /^[a-z0-9-]+$/;
const VALID_AGENT_TYPES = ['claude', 'codex', 'gemini'];
export function validateAgentsConfig(agents: AgentConfig[]): string | null {
  if (!Array.isArray(agents)) return 'agents must be an array';
  const seenAliases = new Set<string>();
  for (const agent of agents) {
    const error = validateSingleAgent(agent, seenAliases); if (error) return error;
    seenAliases.add(agent.alias);
  }
  return null;
}
function validateSingleAgent(agent: AgentConfig, seenAliases: Set<string>): string | null {
  if (!agent.id || typeof agent.id !== 'string') return `Agent missing required 'id' field`;
  if (!agent.type || !VALID_AGENT_TYPES.includes(agent.type)) return `Agent '${agent.id}' has invalid type. Must be one of: ${VALID_AGENT_TYPES.join(', ')}`;
  if (!agent.alias || typeof agent.alias !== 'string') return `Agent '${agent.id}' missing required 'alias' field`;
  if (!ALIAS_REGEX.test(agent.alias)) return `Agent '${agent.id}' has invalid alias '${agent.alias}'. Must match pattern ^[a-z0-9-]+$`;
  if (typeof agent.enabled !== 'boolean') return `Agent '${agent.id}' missing required 'enabled' field`;
  if (!agent.dockerImage || typeof agent.dockerImage !== 'string') return `Agent '${agent.id}' missing required 'dockerImage' field`;
  if (!agent.configPath || typeof agent.configPath !== 'string') return `Agent '${agent.id}' missing required 'configPath' field`;
  if (!Array.isArray(agent.supportedModels)) return `Agent '${agent.id}' missing required 'supportedModels' field`;
  if (seenAliases.has(agent.alias)) return `Duplicate agent alias '${agent.alias}' found`;
  return null;
}
export interface QueueIndexingResult { success: boolean; error?: string; jobId?: string; correlationId?: string; }
const DELAYED_REINDEX_KEY = 'config:summarization:delayed-reindex';
const REINDEX_DELAY_MS = 10 * 60 * 1000;
export async function scheduleDelayedReindex(redisClient: RedisClientType): Promise<boolean> {
  try {
    const scheduledTime = Date.now() + REINDEX_DELAY_MS;
    await redisClient.set(DELAYED_REINDEX_KEY, scheduledTime.toString(), { EX: Math.ceil(REINDEX_DELAY_MS / 1000) + 60 });
    console.log(`Scheduled delayed reindex for ${new Date(scheduledTime).toISOString()}`);
    return true;
  } catch (error) {
    console.error('Error scheduling delayed reindex:', error);
    return false;
  }
}
export async function cancelDelayedReindex(redisClient: RedisClientType): Promise<void> {
  try {
    await redisClient.del(DELAYED_REINDEX_KEY);
    console.log('Cancelled scheduled delayed reindex');
  } catch (error) {
    console.error('Error cancelling delayed reindex:', error);
  }
}
export async function checkAndExecuteDelayedReindex(redisClient: RedisClientType): Promise<boolean> {
  try {
    const scheduledTimeStr = await redisClient.get(DELAYED_REINDEX_KEY);
    if (!scheduledTimeStr) return false;
    const scheduledTime = parseInt(scheduledTimeStr, 10);
    if (Date.now() >= scheduledTime) {
      await redisClient.del(DELAYED_REINDEX_KEY);
      const count = await queueResummarizationForAllRepos();
      console.log(`Executed delayed reindex for ${count} repositories`);
      return true;
    }
    return false;
  } catch (error) {
    console.error('Error checking/executing delayed reindex:', error);
    return false;
  }
}
export async function queueIndexingJob(repository: string, fullReindex: boolean, baseBranch?: string): Promise<QueueIndexingResult> {
  const settings = await configManager.loadSummarizationSettings();
  if (!settings.enabled) return { success: false, error: 'Summarization is not enabled. Enable it in settings first.' };
  if (!settings.agent_alias) return { success: false, error: 'No agent configured for summarization. Configure one in settings first.' };
  const queue = await getIndexingQueue();
  const existingJobs = await queue.getJobs(['waiting', 'active', 'delayed']);
  if (existingJobs.some((j: { data: IndexingJobData }) => j.data.repository === repository)) return { success: false, error: 'Indexing job already queued for this repository' };
  const [owner, name] = repository.split('/');
  const octokit = await getAuthenticatedOctokit();
  const { token } = await octokit.auth({ type: "installation" }) as { token: string };
  const repoUrl = getRepoUrl({ repoOwner: owner, repoName: name });
  let repoPath: string;
  try {
    repoPath = await ensureRepoCloned({ repoUrl, owner, repoName: name, authToken: token, baseBranch });
  } catch (cloneError) {
    return { success: false, error: `Failed to clone repository: ${(cloneError as Error).message}` };
  }
  const fetchResult = await fetchLatestChanges({ owner, repoName: name, authToken: token, branch: baseBranch });
  if (!fetchResult.success) console.warn(`Failed to fetch latest changes for ${repository}: ${fetchResult.error}`);
  const correlationId = generateCorrelationId();
  const job = await queue.add(
    'indexRepository',
    { repository, repoPath, correlationId, priority: 'high', fullReindex, baseBranch },
    { jobId: `index-${repository.replace('/', '-')}-${Date.now()}`, priority: 1 }
  );
  return { success: true, jobId: job.id, correlationId };
}
export async function stopIndexingJob(repository: string, branch?: string): Promise<{ success: boolean; message?: string }> {
  try {
    const queue = await getIndexingQueue();
    const jobs = await queue.getJobs(['active', 'waiting', 'delayed']);
    const job = jobs.find((j: { data: IndexingJobData }) => {
      if (j.data.repository !== repository) return false;
      if (branch) return j.data.baseBranch === branch;
      return true;
    });
    if (job) {
      const state = await job.getState();
      if (state === 'active') await requestIndexingCancellation(repository); else await job.remove();
    }
    await updateRepositoryStatus(repository, 'idle', branch || 'HEAD');
    return { success: true };
  } catch (error) {
    console.error('Error stopping indexing job:', error);
    return { success: false, message: (error as Error).message };
  }
}
