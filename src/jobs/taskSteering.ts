/**
 * Worker side of live steering for ordinary task runs.
 *
 * While an agent runs, the worker announces the run in Redis with the
 * agent's declared steering capability; the API accepts steers only for an
 * announced run. Steers that a previous run accepted but never delivered are
 * claimed into this run's prompt, so each steer reaches an agent at most once.
 * The claim is stored as being prepared; the handoff is persisted before an
 * agent process is started with that prompt, and the delivery is confirmed by
 * the agent's own output. A run whose agent startup conclusively failed (or
 * never began) returns the steers to the pending queue, and a preparation
 * claim left by a worker that died is reclaimed by the next run. A handoff
 * whose outcome is uncertain is never replayed.
 */

import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import {
  claimTaskSteers,
  confirmTaskSteersReceived,
  createTaskSteeringSource,
  db as defaultDb,
  formatReplacementRunSteers,
  logger,
  markTaskSteersHandedOff,
  recordTaskSteerTimeline,
  releaseTaskSteers,
} from '@propr/core';
import type { Agent, LiveInputSource, PromptHandoff, TaskSteer } from '@propr/core';
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
  /** Pass to the agent as `promptHandoff`: delivery bookkeeping for the prompt carrying the steers. */
  promptHandoff: PromptHandoff;
  /**
   * Withdraw the announcement once the agent stopped. Carried steers whose
   * prompt definitely reached no agent are returned to the pending queue.
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

  // The handoff is committed before an agent process is started with the
  // prompt, so a worker that dies after exposing it never leaves a claim the
  // next run would reclaim. Every started execution may have reached an agent
  // unless its startup conclusively failed; only then are the steers released.
  const carriedIds = carried.map(steer => steer.id);
  let started = 0;
  let notReceived = 0;
  let received = false;
  const timelineWrites: Promise<unknown>[] = [];
  const promptHandoff: PromptHandoff = {
    async beforeStart(): Promise<void> {
      if (!carried.length) return;
      // Throws on failure: the prompt carrying the steers is then not sent.
      const moved = await markTaskSteersHandedOff(database, carriedIds);
      // A later execution of this run (a retry) finds them already handed off.
      if (moved !== carried.length && started === 0) {
        throw new Error('Carried operator input is no longer claimed by this run; not starting the agent with it');
      }
      started += 1;
    },
    received(): void {
      if (received || !carried.length) return;
      received = true;
      timelineWrites.push(confirmTaskSteersReceived(database, carriedIds).catch(error => {
        logger.warn({ taskId, error: (error as Error).message }, 'Could not record that carried operator input reached the agent');
      }));
      for (const steer of carried) {
        timelineWrites.push(recordTaskSteerTimeline(database, steer, 'replacement_prompt').catch(error => {
          logger.warn({ taskId, steerId: steer.id, error: (error as Error).message }, 'Could not record carried operator input in the timeline');
        }));
      }
    },
    notReceived(): void {
      if (carried.length) notReceived += 1;
    },
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
    promptHandoff,
    async finish(): Promise<void> {
      clearInterval(refresh);
      if (carried.length && !received && started === notReceived) {
        // No agent ever received the prompt, so releasing cannot duplicate input.
        try {
          await releaseTaskSteers(database, carriedIds);
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
