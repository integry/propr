/**
 * Live steering contract for ordinary (non-goal) tasks, shared by the REST
 * API, MCP, CLI, web UI and the worker so limits and per-agent capabilities
 * cannot drift between entry points.
 */
import type { AgentType } from './modelDefinitions.js';

/**
 * How an agent receives operator input while an ordinary task runs:
 * - `live`: written into the running agent session immediately.
 * - `next-step`: delivered when the agent reaches its next step boundary.
 * - `none`: the agent's one-shot runtime has no input channel during a run.
 */
export const TASK_STEERING_CAPABILITIES = ['none', 'next-step', 'live'] as const;
export type TaskSteeringCapability = typeof TASK_STEERING_CAPABILITIES[number];

/**
 * Steering capability of each agent's ordinary task runtime. Claude task runs
 * keep a stream-json stdin control channel open, the same channel native
 * goals use. Codex (`codex exec --ephemeral`), Antigravity (`agy --print`),
 * OpenCode and Vibe task runs are one-shot invocations that read their prompt
 * once, so they cannot be steered; their goals keep their own input paths.
 */
export const AGENT_TASK_STEERING: Readonly<Record<AgentType, TaskSteeringCapability>> = Object.freeze({
  claude: 'live',
  codex: 'none',
  antigravity: 'none',
  opencode: 'none',
  vibe: 'none',
});

export const TASK_STEER_MAX_LENGTH = 4_000;
export const TASK_STEER_MAX_PER_RUN = 20;

/** Heading used wherever steers are summarized for a run (timeline, completion comment). */
export const TASK_STEER_SECTION_TITLE = 'Operator input during the run';

export function taskSteeringCapability(agentType: string | null | undefined): TaskSteeringCapability {
  return agentType && agentType in AGENT_TASK_STEERING
    ? AGENT_TASK_STEERING[agentType as AgentType]
    : 'none';
}

/** Returns a validation error for a steering message, or null when it is acceptable. */
export function validateTaskSteerMessage(message: unknown): string | null {
  if (typeof message !== 'string' || !message.trim()) return 'message is required';
  if (message.length > TASK_STEER_MAX_LENGTH) {
    return `message must be at most ${TASK_STEER_MAX_LENGTH} characters`;
  }
  return null;
}

/**
 * Redis key a worker holds while an agent of a steerable task flow runs. Its
 * value is a {@link TaskSteeringRunAnnouncement}; it expires on its own if
 * the worker dies, so a steer is never accepted for a run nobody executes.
 */
export function taskSteeringRedisKey(taskId: string): string {
  return `task:steering:${taskId}`;
}

export interface TaskSteeringRunAnnouncement {
  capability: TaskSteeringCapability;
  agentAlias: string;
  agentType: string;
  /** Identifies the run for the per-run steer limit. */
  runKey: string;
  startedAt: string;
}
