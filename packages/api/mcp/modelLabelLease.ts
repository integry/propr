import { randomUUID } from 'node:crypto';
import type { RedisClientType } from 'redis';
import { McpError } from './config.js';

const MODEL_LABEL_LEASE_MS = 60_000;
const MODEL_LABEL_WAIT_MS = 15_000;
/** Renewal stops after this long, so a hung GitHub read cannot hold the lease forever. */
const MODEL_LABEL_MAX_HOLD_MS = 5 * 60_000;
const RELEASE_LEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0`;
const RENEW_LEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) end return 0`;

export interface ModelLabelLease {
  /** Prove the lease is still held and extend it; throws before a write when it was lost. */
  confirm(): Promise<void>;
}

/**
 * Serialize model-label convergence per pull request across API processes, so two
 * routings cannot both read "no managed label" and each add their own. The caller
 * reads labels inside the lease and confirms it before every label write, because a
 * lease that lapsed during a slow GitHub read may already belong to another routing
 * whose labels the caller never saw. Label edits made outside ProPR remain a race no
 * lease can close.
 */
export async function withModelLabelLease<T>(redis: RedisClientType, repository: string, pullRequest: number, run: (lease: ModelLabelLease) => Promise<T>): Promise<T> {
  const key = `mcp:pull-request-model:${repository.toLowerCase()}#${pullRequest}`;
  const token = randomUUID();
  const deadline = Date.now() + MODEL_LABEL_WAIT_MS;
  while (await redis.set(key, token, { NX: true, PX: MODEL_LABEL_LEASE_MS }) !== 'OK') {
    if (Date.now() >= deadline) throw new McpError('PULL_REQUEST_BUSY', 'Another model change for this pull request is still running. Read the pull request again, then retry.', 409);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const acquiredAt = Date.now();
  const release = () => redis.eval(RELEASE_LEASE, { keys: [key], arguments: [token] });
  // Compare-and-extend: a lease that expired or passed to another routing is never revived.
  const renew = async () => Number(await redis.eval(RENEW_LEASE, { keys: [key], arguments: [token, String(MODEL_LABEL_LEASE_MS)] })) === 1;
  const lease: ModelLabelLease = {
    confirm: async () => {
      if (!await renew()) throw new McpError('MODEL_LABEL_LEASE_LOST', 'Another model change took over this pull request before this one could write its labels. Read the pull request labels again before retrying.', 409);
    },
  };
  // Keep the lease alive through slow reads; confirm() still decides before each write.
  const heartbeat = setInterval(() => {
    if (Date.now() - acquiredAt >= MODEL_LABEL_MAX_HOLD_MS) clearInterval(heartbeat);
    else renew().catch(() => undefined);
  }, MODEL_LABEL_LEASE_MS / 3);
  heartbeat.unref?.();
  let result: T;
  try { result = await run(lease); }
  catch (error) { await release().catch(() => undefined); throw error; }
  finally { clearInterval(heartbeat); }
  // A lease that expired mid-convergence no longer proves exclusivity, so the
  // outcome is reported as uncertain rather than as a converged label set.
  if (Number(await release()) !== 1) throw new Error('Model label lease expired before convergence completed.');
  return result;
}
