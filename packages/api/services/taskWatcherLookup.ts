import { RedisClientType } from 'redis';
import { Knex } from 'knex';
import { loadAgents, type AgentConfig } from '@propr/core';

export interface TaskWatcherLookupDeps {
  redisClient: RedisClientType;
  db: Knex;
}

/**
 * Find the agent config for a task based on agent alias in task ID
 */
export async function findAgentConfigForTask(taskId: string): Promise<AgentConfig | null> {
  try {
    const agents = await loadAgents();
    for (const agent of agents) {
      if (taskId.includes(`-${agent.alias}-`)) {
        return agent;
      }
    }
    for (const agent of agents) {
      if (taskId.includes(`-${agent.type}-`)) {
        return agent;
      }
    }
    return null;
  } catch (error) {
    console.error('[TaskWatcher] Error loading agent config:', error);
    return null;
  }
}

/**
 * Find the execution start timestamp for a task from Redis or database
 */
export async function findExecutionStartTimestampForTask(
  deps: TaskWatcherLookupDeps,
  normalizedTaskId: string
): Promise<string | null> {
  try {
    const stateData = await deps.redisClient.get(`worker:state:${normalizedTaskId}`);
    if (stateData) {
      const state = JSON.parse(stateData) as {
        history?: Array<{ state?: string; timestamp?: string }>
      };
      const history = Array.isArray(state.history) ? state.history : [];
      const entry = history.find(
        h => h.timestamp && (h.state === 'claude_execution' || h.state === 'codex_execution' || h.state === 'antigravity_execution' || h.state === 'vibe_execution')
      ) || history.find(h => h.timestamp && (h.state ?? '').endsWith('_execution'));
      if (entry?.timestamp) return entry.timestamp;
    }
  } catch (error) {
    console.error('[TaskWatcher] Error fetching execution start from Redis:', error);
  }

  try {
    const llmExecution = await deps.db('llm_executions')
      .where({ task_id: normalizedTaskId })
      .orderBy('start_time', 'desc')
      .first('start_time');
    const startTime = llmExecution?.start_time;
    return startTime ? new Date(startTime as string | Date).toISOString() : null;
  } catch (error) {
    console.error('[TaskWatcher] Error fetching execution start from database:', error);
    return null;
  }
}
