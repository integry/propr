/**
 * The capacity report served by `GET /api/agent-run-admission`, the
 * `get_agent_run_admission` MCP tool and `propr admission`.
 *
 * It reports what admission enforces (the instance-wide agent-run limit and
 * per-agent ceilings) and, labelled separately, the other limits a scheduler
 * must respect: queue worker concurrency and repository workflow slots.
 * Subscription usage (Agent Tank, `get_provider_usage`, the automation
 * `/capacity` routes) is a different thing and is deliberately not included.
 *
 * Redaction: no holder token, container ID, daemon identity, instance ID or
 * environment value other than the limits. Task IDs and repository names
 * appear only when the caller's `access` says it may see them; the counts
 * always cover everything.
 */
import type { Queue } from 'bullmq';
import type { RedisClientType } from 'redis';
import { readAgentRunAdmissionSnapshot, type AgentRunAdmissionSnapshot } from '@propr/core';

const WORKER_SET_KEY = 'system:status:workers';
const WORKER_CAPACITY_KEY = 'system:status:worker-capacity';

export interface AgentRunAdmissionReportDeps {
  taskQueue: Pick<Queue, 'getActiveCount'> & { opts?: { prefix?: string } };
  redisClient: Pick<RedisClientType, 'sMembers' | 'hGetAll'>;
  /** Test hook; defaults to the core snapshot over a short-lived Redis connection. */
  readSnapshot?: () => Promise<AgentRunAdmissionSnapshot>;
}

export interface AgentRunAdmissionReportAccess {
  /** The subset of `taskIds` the caller may see. */
  visibleTasks(taskIds: string[]): Promise<Set<string>>;
  /** The subset of (lowercased) repository handles the caller may see. */
  visibleRepositories(repositories: string[]): Promise<Set<string>>;
}

export const QUEUE_WORKERS_LABEL = 'Queue worker concurrency: jobs the worker processes run at once (WORKER_CONCURRENCY per worker). A job holds its worker slot while it waits for admission; a deferred job does not.';
export const REPOSITORY_SLOTS_LABEL = 'Repository workflow slots: runs of one repository at once (limits.max_parallel_tasks in .propr/workflow.yml). Only repositories with a limit and running work are listed.';
export const SUBSCRIPTION_USAGE_NOTE = 'Subscription usage (provider quota through Agent Tank) is not part of this report; read it with get_provider_usage or the automation capacity routes.';

async function queueWorkers(deps: AgentRunAdmissionReportDeps) {
  const [inUse, workers] = await Promise.all([deps.taskQueue.getActiveCount(), deps.redisClient.sMembers(WORKER_SET_KEY)]);
  const published = workers.length ? await deps.redisClient.hGetAll(WORKER_CAPACITY_KEY) as Record<string, string> : {};
  let total: number | null = 0;
  for (const worker of workers) {
    const reported = Number(published[worker]);
    // A worker that has not reported its concurrency makes the total unknown, not smaller.
    if (!Number.isSafeInteger(reported) || reported <= 0) { total = null; break; }
    total += reported;
  }
  return { label: QUEUE_WORKERS_LABEL, inUse, total, workers: workers.length };
}

export async function buildAgentRunAdmissionReport(deps: AgentRunAdmissionReportDeps, access: AgentRunAdmissionReportAccess) {
  const read = deps.readSnapshot ?? (() => readAgentRunAdmissionSnapshot({ queuePrefix: deps.taskQueue.opts?.prefix }));
  const [snapshot, workers] = await Promise.all([
    read(),
    queueWorkers(deps).catch(() => ({ label: QUEUE_WORKERS_LABEL, inUse: null, total: null, workers: null })),
  ]);
  const taskIds = [...new Set(snapshot.agents.flatMap(agent => agent.tasks.map(task => task.taskId)))];
  const [visibleTasks, visibleRepositories] = await Promise.all([
    taskIds.length ? access.visibleTasks(taskIds) : Promise.resolve(new Set<string>()),
    snapshot.repositoryWorkflowSlots.length
      ? access.visibleRepositories(snapshot.repositoryWorkflowSlots.map(slot => slot.repository))
      : Promise.resolve(new Set<string>()),
  ]);
  return {
    asOf: snapshot.asOf,
    admission: {
      enabled: snapshot.enabled,
      agentCeilingsConfigured: snapshot.agentCeilingsConfigured,
      global: snapshot.global ?? null,
      ...(snapshot.unavailable ? { unavailable: snapshot.unavailable } : {}),
    },
    agents: snapshot.agents.map(agent => ({ ...agent, tasks: agent.tasks.filter(task => visibleTasks.has(task.taskId)) })),
    queueWorkers: workers,
    repositoryWorkflowSlots: {
      label: REPOSITORY_SLOTS_LABEL,
      repositories: snapshot.repositoryWorkflowSlots.filter(slot => visibleRepositories.has(slot.repository)),
    },
    subscriptionUsage: SUBSCRIPTION_USAGE_NOTE,
  };
}

export type AgentRunAdmissionReport = Awaited<ReturnType<typeof buildAgentRunAdmissionReport>>;
