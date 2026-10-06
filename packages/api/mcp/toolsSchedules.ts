import { z } from 'zod';
import { getSchedule, listScheduleRuns, listSchedules, type TaskSchedule } from '@propr/core';
import { MAX_RUN_COST_CAP_USD } from '@propr/shared';
import { createScheduleRoutes } from '../routes/scheduleRoutes.js';
import { callWorkflow } from './adapter.js';
import { McpError } from './config.js';
import type { McpPrincipal } from './policy.js';
import { type McpTool, type ToolDeps, idSchema, mutationShape, ok, repositorySchema } from './tools.js';
import { ultrafixGoalSchema } from './ultrafix.js';

// No owner column: an instance administrator may also act on another user's
// schedule. The workflow handler enforces "owner or instance.manage_settings".
const scheduleTarget = { table: 'task_schedules', column: 'id', arg: 'scheduleId' };

/** Running a schedule performs what its instruction asks for, so it needs the same scopes as creating it. */
function requireInstructionScopes(deps: ToolDeps, principal: McpPrincipal, instruction: { autoMerge?: boolean; runUltrafix?: boolean }): void {
  if (instruction.autoMerge) deps.policy.requireScope(principal, 'merge');
  if (instruction.runUltrafix) deps.policy.requireScope(principal, 'review');
}

async function scheduleInRepository(deps: ToolDeps, repository: string, id: string): Promise<TaskSchedule> {
  const schedule = await getSchedule(deps.db, id);
  if (!schedule || schedule.repository !== repository) throw new McpError('NOT_FOUND', 'Schedule not found.', 404);
  return schedule;
}

export function addScheduleTools(tools: McpTool[], deps: ToolDeps): void {
  const routes = createScheduleRoutes({ db: deps.db, services: deps.scheduleServices });
  // Built here, not at module load: tools.js and this module import each other.
  const scheduleShape = { repository: repositorySchema.toLowerCase(), scheduleId: z.uuid() };

  tools.push({ name: 'create_schedule', description: 'Create a schedule that STARTS an ordinary one-off task (the same work create_task starts) every time its cron expression fires, as you, until it is paused or deleted. cron is a 5-field expression (minute hour day-of-month month day-of-week) evaluated in timezone (an IANA zone such as Europe/Berlin); schedules may fire at most every 5 minutes, and the first run is the next matching slot after now. A schedule pauses itself after repeated failures. runUltrafix, autoMerge, ultrafixGoal, ultrafixMaxCycles and maxCostUsd behave as on create_task; omitted Ultrafix bounds resolve from instance settings at each run. Set enabled false to create it paused. Keep the idempotencyKey stable.', scope: 'execute',
    schema: z.object({ ...mutationShape, repository: scheduleShape.repository,
      name: z.string().min(1).max(200).optional().describe('Display name. Defaults to the start of the instruction.'),
      cron: z.string().min(1).max(200).describe('5-field cron expression, for example "0 9 * * 1-5" for 09:00 on weekdays.'),
      timezone: z.string().min(1).max(100).describe('IANA time zone the cron expression is evaluated in, for example UTC or America/New_York.'),
      instruction: z.string().min(1).max(50000).refine(value => !!value.trim(), 'Instruction must not be blank.'),
      agentAlias: idSchema.optional(), model: idSchema.optional(), autoMerge: z.boolean().default(false),
      runUltrafix: z.boolean().default(false), ultrafixGoal: ultrafixGoalSchema,
      ultrafixMaxCycles: z.number().int().min(1).max(10).optional(),
      maxCostUsd: z.number().positive().max(MAX_RUN_COST_CAP_USD).optional().describe('Spend cap in USD for each scheduled run.'),
      enabled: z.boolean().default(true),
    }).strict(), run: async ({ principal, args }) => {
      requireInstructionScopes(deps, principal, args);
      if (!args.runUltrafix && (args.ultrafixGoal !== undefined || args.ultrafixMaxCycles !== undefined)) {
        throw new McpError('INVALID_INPUT', 'ultrafixGoal and ultrafixMaxCycles apply only when runUltrafix is true.');
      }
      const response = await callWorkflow(routes.create, principal, { body: {
        repository: args.repository, cron: args.cron, timezone: args.timezone, enabled: args.enabled,
        ...(args.name !== undefined ? { name: args.name } : {}),
        instruction: { text: args.instruction, agentAlias: args.agentAlias, model: args.model,
          autoMerge: args.autoMerge, runUltrafix: args.runUltrafix,
          ...(args.runUltrafix && args.ultrafixGoal !== undefined ? { ultrafixGoal: args.ultrafixGoal } : {}),
          ...(args.runUltrafix && args.ultrafixMaxCycles !== undefined ? { ultrafixMaxCycles: args.ultrafixMaxCycles } : {}),
          ...(args.maxCostUsd !== undefined ? { maxCostUsd: args.maxCostUsd } : {}) },
      } });
      const { schedule } = response.data as { schedule: TaskSchedule };
      return { status: 201, data: { schedule, continuation: { scheduleId: schedule.id, repository: schedule.repository } } };
    } });

  tools.push({ name: 'list_schedules', description: 'List recurring task schedules in one repository, or across every repository in this grant, with their cron, time zone, owner, enabled or paused state, next and last run. Pass scheduleId to also read that schedule\'s recent runs.', scope: 'read', readOnly: true,
    schema: z.object({ repository: scheduleShape.repository.optional(), scheduleId: z.uuid().optional(),
      runLimit: z.number().int().min(1).max(50).default(10),
    }).strict().refine(args => !args.scheduleId || args.repository, { message: 'scheduleId requires repository.' }),
    run: async ({ principal, args }) => {
      if (args.scheduleId) {
        const schedule = await scheduleInRepository(deps, args.repository, args.scheduleId);
        return ok({ schedules: [schedule], runs: await listScheduleRuns(deps.db, schedule.id, args.runLimit) });
      }
      const granted = new Set(principal.grant.repositories.map(repository => repository.toLowerCase()));
      const schedules = (await listSchedules(deps.db, { repository: args.repository }))
        .filter(schedule => granted.has(schedule.repository));
      return ok({ schedules });
    } });

  tools.push({ name: 'run_schedule_now', description: 'Run a schedule once immediately, outside its cron slots, which STARTS its task now. Only the schedule\'s owner or an instance administrator may run it. A paused schedule is re-enabled. Manual runs are not limited by the unattended-work admission limits. Follow the started task with get_task_submission using the run\'s submissionId.', scope: 'execute',
    schema: z.object({ ...mutationShape, ...scheduleShape }).strict(), target: scheduleTarget,
    run: async ({ principal, args, operationId }) => {
      const schedule = await scheduleInRepository(deps, args.repository, args.scheduleId);
      requireInstructionScopes(deps, principal, schedule.instruction);
      const response = await callWorkflow(routes.runNow, principal, {
        params: { id: schedule.id },
        // The operation identity keeps a retried call on the same manual run.
        idempotencyKey: `mcp-${operationId}`,
      });
      const data = response.data as { schedule: TaskSchedule; run: { submissionId: string | null; taskId: string | null } };
      return { status: 202, data: { ...data, continuation: { scheduleId: schedule.id,
        ...(data.run.submissionId ? { submissionId: data.run.submissionId } : {}),
        ...(data.run.taskId ? { taskId: data.run.taskId } : {}) } } };
    } });

  tools.push({ name: 'delete_schedule', description: 'Delete a recurring task schedule and its run history so it never fires again. Tasks it already started are not affected. Only the schedule\'s owner or an instance administrator may delete it.', scope: 'execute',
    schema: z.object({ ...mutationShape, ...scheduleShape }).strict(), target: scheduleTarget,
    run: async ({ principal, args }) => {
      await callWorkflow(routes.remove, principal, { params: { id: args.scheduleId } });
      return ok({ deleted: true, scheduleId: args.scheduleId });
    } });
}
