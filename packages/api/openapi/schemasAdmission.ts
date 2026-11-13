import { z } from 'zod';
import { apiSchemas } from './schemas.js';

/** Response schema of `GET /api/agent-run-admission` (see services/agentRunAdmissionReport.ts). */

function component<T extends z.ZodType>(id: string, schema: T, description: string): T {
  const described = schema.describe(description) as T;
  apiSchemas.add(described, { id });
  return described;
}

const count = z.number().int().min(0);
const isoDateTime = z.string().meta({ format: 'date-time' });

export const AgentRunAdmissionStateCounts = component('AgentRunAdmissionStateCounts', z.object({
  reserved: count.describe('Admitted, container not started yet.'),
  running: count,
  draining: count.describe('Finished parents that keep their slot until their nested executions end.'),
  recovering: count.describe('Holders whose removal is not confirmed yet, including expired leases; nothing else is admitted meanwhile.'),
  total: count,
}), 'Admitted executions by state.');

export const AgentRunAdmissionWaitingCounts = component('AgentRunAdmissionWaitingCounts', z.object({
  total: count,
  globalLimit: count.describe('Waiting because the instance-wide limit is full.'),
  agentCeiling: count.describe('Waiting because the agent\'s own ceiling is full.'),
  recovering: count.describe('Waiting until an unconfirmed holder is removed.'),
  starting: count.describe('Registered; first admission reply still pending.'),
}), 'Launches waiting at the admission boundary, by reason. Jobs deferred to the queue are counted separately.');

export const AgentRunAdmissionTask = component('AgentRunAdmissionTask', z.object({
  taskId: z.string(),
  alias: z.string().nullable(),
  state: z.enum(['reserved', 'running', 'draining', 'recovering', 'waiting']),
  waitReason: z.enum(['global_limit', 'alias_limit', 'recovering', 'starting']).optional(),
  nested: z.boolean(),
  since: isoDateTime.optional(),
}), 'A task holding or waiting for a slot. Listed only when the caller may see the task.');

export const AgentRunAdmissionAgent = component('AgentRunAdmissionAgent', z.object({
  alias: z.string().describe('Direct agent alias (never a synthetic alias).'),
  ceiling: z.number().int().positive().nullable().describe('PROPR_AGENT_RUN_ALIAS_LIMITS entry; null = global limit only.'),
  inUse: count.describe('What the ceiling is compared with: holders plus nested executions counted against it.'),
  holders: AgentRunAdmissionStateCounts,
  nested: z.object({ total: count, chargedUnderParent: count, countedAgainstCeiling: count }),
  waiting: AgentRunAdmissionWaitingCounts,
  deferred: count.describe('Queue jobs delayed until this agent has capacity.'),
  tasks: z.array(AgentRunAdmissionTask),
}), 'Admission state of one direct agent.');

export const AgentRunAdmissionReport = component('AgentRunAdmissionReport', z.object({
  asOf: isoDateTime,
  admission: z.object({
    enabled: z.boolean(),
    agentCeilingsConfigured: z.boolean(),
    global: z.object({
      limit: z.number().int().positive(),
      limitSource: z.enum(['PROPR_AGENT_RUN_LIMIT', 'hosted_entitlement']),
      generation: count,
      nestedLimit: z.number().int().positive(),
      nestedLimitSource: z.enum(['PROPR_AGENT_RUN_NESTED_LIMIT', 'default']),
      inUse: count.describe('Top-level executions; each takes one global slot.'),
      holders: AgentRunAdmissionStateCounts,
      unattributedHolders: count,
      nested: z.object({ total: count, chargedUnderParent: count, countedAgainstOtherAgent: count }),
      waiting: AgentRunAdmissionWaitingCounts,
      deferred: count,
    }).nullable().describe('Null when admission is off or its state could not be read.'),
    unavailable: z.string().optional().describe('Why the admission state is missing although admission is enabled.'),
  }),
  agents: z.array(AgentRunAdmissionAgent),
  queueWorkers: z.object({
    label: z.string(),
    inUse: count.nullable(),
    total: count.nullable().describe('Sum of the concurrency live workers report; null when unknown.'),
    workers: count.nullable(),
  }),
  repositoryWorkflowSlots: z.object({
    label: z.string(),
    repositories: z.array(z.object({ repository: z.string(), inUse: count, limit: z.number().int().positive(), waiting: count }))
      .describe('Every repository with a limit and running work that the caller may see; the list is complete, never truncated.'),
    unavailable: z.string().optional().describe('Why repository usage could not be read; `repositories` is then empty and means unknown, not idle.'),
  }),
  subscriptionUsage: z.string().describe('Subscription usage is reported elsewhere; this says where.'),
}), 'What physical agent-run admission enforces, globally and per agent, with the other limits a scheduler must respect.');
