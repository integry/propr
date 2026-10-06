/**
 * Worker side of live steering for ordinary task runs.
 *
 * While an agent runs, the worker announces the run in Redis with the
 * agent's declared steering capability; the API accepts steers only for an
 * announced run. Steers that a previous run accepted but never delivered are
 * claimed into this run's prompt, so each steer reaches an agent at most once.
 * The claim is recorded as delivered only once the agent process was started
 * with that prompt; a run that ends before then returns the steers to the
 * pending queue for the next run.
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
  releaseTaskSteers,
} from '@propr/core';
import type { Agent, LiveInputSource, TaskSteer } from '@propr/core';
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
  /** Pass to the agent as `onPromptHandoff`: the prompt carrying the steers was handed to an agent process. */
  onPromptHandoff(): void;
  /**
   * Withdraw the announcement once the agent stopped. Carried steers whose
   * prompt never reached an agent process are returned to the pending queue.
   */
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
  let carried: TaskSteer[] = [];
  try {
    carried = await claimTaskSteers(database, taskId, 'replacement_prompt');
    promptContext = formatReplacementRunSteers(carried);
    if (carried.length) logger.info({ taskId, steers: carried.length }, 'Carried undelivered operator input into the run prompt');
  } catch (error) {
    logger.warn({ taskId, error: (error as Error).message }, 'Could not load undelivered operator input for this run');
  }

  // Once an agent process was started with the prompt, its delivery is
  // settled (or uncertain): the steers are never replayed after that.
  let handedOff = false;
  const timelineWrites: Promise<unknown>[] = [];
  const onPromptHandoff = (): void => {
    if (handedOff) return;
    handedOff = true;
    for (const steer of carried) {
      timelineWrites.push(recordTaskSteerTimeline(database, steer, 'replacement_prompt').catch(error => {
        logger.warn({ taskId, steerId: steer.id, error: (error as Error).message }, 'Could not record carried operator input in the timeline');
      }));
    }
  };

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
    onPromptHandoff,
    async finish(): Promise<void> {
      clearInterval(refresh);
      if (!handedOff && carried.length) {
        // No agent process ever received the prompt, so releasing cannot duplicate input.
        try {
          await releaseTaskSteers(database, carried.map(steer => steer.id));
          logger.info({ taskId, steers: carried.length }, 'Returned carried operator input that no agent received');
        } catch (error) {
          logger.warn({ taskId, error: (error as Error).message }, 'Could not return undelivered operator input to the queue');
        }
      }
      await Promise.all(timelineWrites);
      try {
        await redisClient.del(key);
      } catch (error) {
        logger.warn({ taskId, error: (error as Error).message }, 'Could not withdraw the steerable run announcement');
      }
    },
  };
}
