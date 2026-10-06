/**
 * Worker side of live steering for ordinary task runs.
 *
 * While an agent runs, the worker announces the run in Redis with the
 * agent's declared steering capability; the API accepts steers only for an
 * announced run. Steers that a previous run accepted but never delivered are
 * claimed into this run's prompt, so each steer reaches an agent at most once.
 */

import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import {
  claimTaskSteers,
  createTaskSteeringSource,
  db as defaultDb,
  formatReplacementRunSteers,
  logger,
  recordTaskSteerTimeline,
} from '@propr/core';
import type { Agent, LiveInputSource } from '@propr/core';
import { taskSteeringRedisKey, type TaskSteeringRunAnnouncement } from '@propr/shared';

/** Announcements expire on their own if the worker dies mid-run. */
const ANNOUNCEMENT_TTL_SECONDS = 120;
const ANNOUNCEMENT_REFRESH_MS = 30_000;

export interface TaskSteeringRedis {
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export interface TaskSteeringRun {
  /** Live input source to pass to the agent; omitted when the agent cannot be steered. */
  steering?: LiveInputSource;
  /** Prompt context carrying steers a previous run never delivered ('' when none). */
  promptContext: string;
  /** Withdraw the announcement once the agent stopped. */
  finish(): Promise<void>;
}

export async function startTaskSteeringRun(params: {
  taskId: string;
  agent: Pick<Agent, 'config' | 'steeringCapability'>;
  redisClient: TaskSteeringRedis;
  db?: Knex;
}): Promise<TaskSteeringRun> {
  const { taskId, agent, redisClient } = params;
  const database = params.db ?? defaultDb;
  const capability = agent.steeringCapability;
  const key = taskSteeringRedisKey(taskId);

  let promptContext = '';
  try {
    const carried = await claimTaskSteers(database, taskId, 'replacement_prompt');
    promptContext = formatReplacementRunSteers(carried);
    await Promise.all(carried.map(steer => recordTaskSteerTimeline(database, steer, 'replacement_prompt')));
    if (carried.length) logger.info({ taskId, steers: carried.length }, 'Carried undelivered operator input into the run prompt');
  } catch (error) {
    logger.warn({ taskId, error: (error as Error).message }, 'Could not load undelivered operator input for this run');
  }

  const announcement: TaskSteeringRunAnnouncement = {
    capability,
    agentAlias: agent.config.alias,
    agentType: agent.config.type,
    runKey: `run:${randomUUID()}`,
    startedAt: new Date().toISOString(),
  };
  const announce = async (): Promise<void> => {
    try {
      await redisClient.set(key, JSON.stringify(announcement), 'EX', ANNOUNCEMENT_TTL_SECONDS);
    } catch (error) {
      logger.warn({ taskId, error: (error as Error).message }, 'Could not announce the steerable run');
    }
  };
  await announce();
  const refresh = setInterval(() => { void announce(); }, ANNOUNCEMENT_REFRESH_MS);
  refresh.unref?.();

  return {
    ...(capability !== 'none' ? { steering: createTaskSteeringSource(database, taskId) } : {}),
    promptContext,
    async finish(): Promise<void> {
      clearInterval(refresh);
      try {
        await redisClient.del(key);
      } catch (error) {
        logger.warn({ taskId, error: (error as Error).message }, 'Could not withdraw the steerable run announcement');
      }
    },
  };
}
