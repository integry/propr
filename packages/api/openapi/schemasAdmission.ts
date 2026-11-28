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

export const AgentRunAdmissionConfiguration = component('AgentRunAdmissionConfiguration', z.object({
  status: z.enum(['current', 'uninitialized', 'pending_generation', 'mismatch', 'missing']).describe(
    'current: compatible protocol; the stored limit and generation equal the configured ones. uninitialized: nothing stored yet; the first admission stores the configured ones. '
    + 'pending_generation: compatible protocol and the configured generation is higher; the next admission attempt fences and removes every older reservation, then switches. '
    + 'mismatch: incompatible protocol, same generation with another limit, a lower generation, or an unreadable stored record; every launch is refused. A higher generation resolves limit/generation mismatches only within a compatible protocol. For incompatible protocols, draining and raising the generation are insufficient: follow "Rolling restarts with mixed versions" in the agent-run capacity operations docs. Drain with the existing version, stop every execution process, confirm Redis holders and physical Docker work are empty, then reset only the admission configuration key; never clear holder records to force an upgrade. '
    + 'missing: nothing stored while holder records remain; every launch is refused.'),
  admitting: z.boolean().describe('False when admission refuses every launch with the configured limit and generation: `limit` minus `inUse` is then not usable capacity.'),
  stored: z.object({ limit: z.number().int().positive(), generation: count }).nullable()
    .describe('Limit and generation of the stored admission configuration; null when none (or none readable) is stored.'),
}), 'The stored admission configuration compared with the configured global limit and generation. The admission protocol prefix is checked; the Docker daemon identity is neither shown nor compared.');

export const AgentRunAdmissionRuntime = component('AgentRunAdmissionRuntime', z.object({
  runtime: z.string().describe('Default agent runtime (an agent\'s own `runtime` setting can select another, checked the same way at launch).'),
  selectedBy: z.enum(['PROPR_AGENT_RUNTIME', 'default']),
  registered: z.array(z.string()).describe('Runtimes this process can launch.'),
  capabilities: z.object({
    bindMounts: z.boolean(),
    restrictedNetwork: z.boolean().describe('Outbound traffic can be confined to the run\'s host/port allowlist.'),
    mcpPrivateNetwork: z.boolean().describe('Runs can join the private network that reaches ProPR MCP.'),
    mcpReachableUrl: z.boolean().describe('Runs can reach ProPR MCP at a reachable URL with a per-run token (the fallback without private networking).'),
    reattach: z.boolean(),
  }),
  network: z.object({
    instanceMode: z.enum(['open', 'restricted']).nullable().describe('Instance network mode; null when the policy could not be read (runs then fail closed).'),
    enforced: z.boolean().nullable(),
    restrictedRuns: z.enum(['enforced', 'refused']).describe('enforced: restricted runs are confined; refused: admission refuses them before launch instead of running them open.'),
    enforcement: z.object({ method: z.string(), description: z.string() }).nullable().describe('How the runtime confines restricted runs.'),
    refusal: z.string().optional().describe('The error a restricted run gets on this runtime.'),
    refusingRuns: z.boolean().describe('The instance mode is restricted and enforced, and this runtime cannot enforce it: runs are being refused now. False for a restricted default that is not enforced: only runs whose effective policy remains restricted are refused.'),
    unavailable: z.string().optional(),
  }),
  mcp: z.object({
    transport: z.enum(['private-network', 'reachable-url', 'ssh-reverse-forward', 'unavailable']).describe('How runs granted ProPR MCP reach it on this runtime.'),
    reason: z.string(),
  }),
}), 'What the default agent runtime can enforce. Admission refuses a run whose spec needs a capability its runtime lacks.');

export const AgentRunAdmissionReport = component('AgentRunAdmissionReport', z.object({
  asOf: isoDateTime,
  admission: z.object({
    enabled: z.boolean(),
    agentCeilingsConfigured: z.boolean(),
    global: z.object({
      limit: z.number().int().positive().describe('Global limit configured on the answering process; enforced only while `configuration.admitting`.'),
      limitSource: z.enum(['PROPR_AGENT_RUN_LIMIT', 'hosted_entitlement']),
      generation: count.describe('Admission generation configured on the answering process (PROPR_AGENT_RUN_GENERATION, default 0).'),
      configuration: AgentRunAdmissionConfiguration,
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
  spritePool: z.object({ cap: count, inUse: count, idle: count, provisioning: count, orphansDeleted: count, awaitingCleanup: count }).optional(),
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
  runtime: AgentRunAdmissionRuntime.nullable().describe('Null when the runtime selection could not be resolved; see `runtimeUnavailable`.'),
  runtimeUnavailable: z.string().optional(),
  subscriptionUsage: z.string().describe('Subscription usage is reported elsewhere; this says where.'),
}), 'What physical agent-run admission enforces, globally and per agent, with the other limits a scheduler must respect.');
