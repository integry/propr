import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { loadAgents, loadSyntheticAgents } from '@propr/core';
import type { createPlannerRoutes } from '../routes/plannerRoutes.js';
import { McpError } from './config.js';
import { callWorkflow } from './adapter.js';
import { type McpTool, type ToolDeps, planShape, mutationShape, pageShape, repositorySchema, textSchema, idSchema, ok, workflow, markMergedPullRequests } from './tools.js';
import { planRelationLimit, summarizePlan } from './listSummaries.js';

const target = { table: 'task_drafts', column: 'draft_id', arg: 'planId', owner: 'user_id' };
const columns = ['draft_id', 'repository', 'name', 'initial_prompt', 'plan_json', 'attachments', 'status', 'mcp_revision', 'paused', 'created_at', 'updated_at'];

export function addPlanningTools(tools: McpTool[], deps: ToolDeps, planner: ReturnType<typeof createPlannerRoutes>): void {
  const planTask = z.object({ id: idSchema.optional(), title: z.string().min(1).max(256), body: textSchema, implementation: textSchema, notes: textSchema.optional() }).strict();
  const plan = z.array(planTask).min(1).max(20);
  
  const { db, policy } = deps;
  tools.push({ name: 'list_plans', description: 'List compact plan summaries with issue progress, agent assignments and pull requests.', scope: 'read', readOnly: true,
    schema: z.object({ repository: repositorySchema, ...pageShape }).strict(), run: async ({ principal, args }) => {
      const rows = await db('task_drafts').where({ repository: args.repository, user_id: principal.user.id })
        .select('draft_id', 'repository', 'name', 'initial_prompt', 'context_config', 'generation_trace',
          'refinement_result', 'status', 'mcp_revision', 'paused', 'created_at', 'updated_at')
        .orderBy('created_at', 'desc').orderBy('draft_id', 'desc').offset(args.offset).limit(args.limit);
      const planIds = rows.map(row => row.draft_id);
      const issueRows = planIds.length
        ? await db('plan_issues').whereIn('draft_id', planIds)
          .select('draft_id', 'pr_number', 'status', 'agent_alias', 'model_name').orderBy('id')
        : [];
      const issuesByPlan = new Map<string, Record<string, unknown>[]>();
      for (const issue of issueRows) {
        const issues = issuesByPlan.get(issue.draft_id) ?? [];
        issues.push(issue);
        issuesByPlan.set(issue.draft_id, issues);
      }
      const now = Date.now();
      const relationLimit = planRelationLimit(rows.length);
      const plans = rows.map(row => summarizePlan(row, issuesByPlan.get(row.draft_id) ?? [], now, relationLimit));
      const pullRequests = plans.flatMap(plan => plan.pull_requests as Record<string, unknown>[]);
      await markMergedPullRequests(db, args.repository, pullRequests, { number: 'number', state: 'state' });
      return ok({ plans, nextOffset: rows.length === args.limit ? args.offset + args.limit : null });
    } });
  tools.push({ name: 'get_plan', description: 'Read your plan, revision and published issue/task handles.', scope: 'read', readOnly: true, schema: z.object(planShape).strict(), target,
    run: async ({ args }) => {
      const draft = await db('task_drafts').where({ draft_id: args.planId }).first(columns);
      const attachments = JSON.parse(draft.attachments || '[]');
      return ok({ ...draft, attachments: attachments.map(({ id, originalName, mimeType, size }: Record<string, unknown>) => ({ id, originalName, mimeType, size })), plan: draft.plan_json ? JSON.parse(draft.plan_json) : [], plan_json: undefined, issues: await db('plan_issues').where({ draft_id: args.planId }).limit(100) });
    } });
  tools.push({ name: 'create_plan', description: 'Create a draft plan only. This does not publish issues or start execution.', scope: 'plan',
    schema: z.object({ ...mutationShape, repository: repositorySchema, name: z.string().min(1).max(256), prompt: textSchema, plan: plan.optional(), todoIds: z.array(z.uuid()).max(20).optional() }).strict(),
    run: async ({ principal, args }) => {
      const id = randomUUID();
      await db.transaction(async tx => {
        const todoIds = [...new Set<string>(args.todoIds || [])];
        if (todoIds.length && (await tx('repo_todos').where({ user_id: principal.user.id, repository: args.repository }).whereIn('todo_id', todoIds)).length !== todoIds.length) throw new McpError('NOT_FOUND', 'Selected TODOs must belong to you in this repository.', 404);
        await tx('task_drafts').insert({ draft_id: id, user_id: principal.user.id, repository: args.repository, name: args.name, initial_prompt: args.prompt, plan_json: args.plan ? JSON.stringify(args.plan) : null, status: 'draft' });
        if (todoIds.length) await tx('repo_todos').whereIn('todo_id', todoIds).update({ linked_draft_id: id, updated_at: tx.fn.now() });
      });
      return ok({ planId: id, revision: 0, status: 'draft' });
    } });
  tools.push({ name: 'update_plan', description: 'Update a draft using its exact revision. Read the plan again on a conflict.', scope: 'plan', target,
    schema: z.object({ ...mutationShape, ...planShape, expectedRevision: z.number().int().min(0), name: z.string().min(1).max(256).optional(), prompt: textSchema.optional(), plan: plan.optional() }).strict(),
    run: async ({ principal, args }) => {
      const changed = await db('task_drafts').where({ draft_id: args.planId, user_id: principal.user.id, mcp_revision: args.expectedRevision })
        .whereIn('status', ['draft', 'review', 'approved', 'failed']).update({
          ...(args.name !== undefined ? { name: args.name } : {}), ...(args.prompt !== undefined ? { initial_prompt: args.prompt } : {}),
          ...(args.plan !== undefined ? { plan_json: JSON.stringify(args.plan) } : {}), updated_at: db.fn.now(), mcp_revision: args.expectedRevision + 1,
        });
      if (!changed) throw new McpError('STALE_REVISION', 'Plan changed or an operation is active. Read it again before updating.', 409);
      return ok({ planId: args.planId, revision: args.expectedRevision + 1 });
    } });
  tools.push({ name: 'delete_plan', description: 'Delete your idle draft at an exact revision. Published or active plans cannot be deleted through this tool.', scope: 'plan', target,
    schema: z.object({ ...mutationShape, ...planShape, expectedRevision: z.number().int().min(0) }).strict(), run: async ({ principal, args }) => {
      const removed = await db('task_drafts').where({ draft_id: args.planId, user_id: principal.user.id, mcp_revision: args.expectedRevision }).whereIn('status', ['draft', 'review', 'approved']).delete();
      if (!removed) throw new McpError('STALE_REVISION', 'Plan changed or cannot be deleted.', 409);
      return ok({ planId: args.planId, deleted: true });
    } });
  workflow(tools, { name: 'generate_plan', description: 'Start generating a plan with a configured model. Poll the plan for progress.', scope: 'plan', target,
    schema: z.object({ ...mutationShape, ...planShape, generationModel: idSchema, baseBranch: idSchema.optional(), granularity: z.enum(['single', 'balanced', 'granular']).default('balanced') }).strict() }, planner.generate, args => ({ body: { draftId: args.planId, generationModel: args.generationModel, baseBranch: args.baseBranch, granularity: args.granularity } }));
  tools.push({ name: 'refine_plan', description: 'Refine your current plan with an instruction and exact revision.', scope: 'plan', target,
    schema: z.object({ ...mutationShape, ...planShape, expectedRevision: z.number().int().min(0), instruction: textSchema, generationModel: idSchema.optional() }).strict(), run: async ({ principal, args }) => {
      const draft = await db('task_drafts').where({ draft_id: args.planId, mcp_revision: args.expectedRevision }).first();
      if (!draft) throw new McpError('STALE_REVISION', 'Plan revision changed.', 409);
      const response = await callWorkflow(planner.refine, principal, { body: { draftId: args.planId, expectedRevision: args.expectedRevision, plan: JSON.parse(draft.plan_json), instruction: args.instruction, generationModel: args.generationModel } });
      return { status: response.status, data: { ...response.data as Record<string, unknown>, planId: args.planId } };
    } });
  for (const action of ['pause', 'resume'] as const) workflow(tools, { name: `${action}_plan`, description: `${action} implementation scheduling for your plan.`, scope: 'execute', target, schema: z.object({ ...mutationShape, ...planShape }).strict() }, action === 'pause' ? planner.pauseDraftExecution : planner.resumeDraftExecution, args => ({ params: { id: args.planId } }));

  tools.push({ name: 'publish_plan', description: 'Publish your approved plan as GitHub issues without starting implementation. Requires the exact revision.', scope: 'publish', target,
    schema: z.object({ ...mutationShape, ...planShape, expectedRevision: z.number().int().min(0) }).strict(), run: async ({ principal, args, operationId }) => {
      const draft = await db('task_drafts').where({ draft_id: args.planId, mcp_revision: args.expectedRevision }).first();
      if (!draft) throw new McpError('STALE_REVISION', 'Plan revision changed.', 409);
      const tasks = plan.parse(JSON.parse(draft.plan_json || '[]'));
      const claimed = await db('task_drafts').where({ draft_id: args.planId, mcp_revision: args.expectedRevision }).whereIn('status', ['draft', 'review', 'approved'])
        .update({ status: 'executing', updated_at: db.fn.now() });
      if (!claimed) throw new McpError('PRECONDITION_FAILED', 'Plan is already published or busy.', 409);
      const [owner, repo] = args.repository.split('/');
      const issues: Array<{ number: number; url: string; title: string }> = [];
      for (const [index, task] of tasks.entries()) {
        // Deliberately no automatic POST retry: the durable operation and draft
        // claim prevent a replay after an uncertain network response.
        await policy.repository(principal, args.repository, true);
        const response = await principal.github.request('POST /repos/{owner}/{repo}/issues', { owner, repo, title: task.title,
          body: `${task.body}\n\n## Implementation\n${task.implementation}${task.notes ? `\n\n## Notes\n${task.notes}` : ''}\n\n<!-- propr-mcp:${operationId}:${index} -->`, labels: ['propr-planned'] });
        await db('plan_issues').insert({ draft_id: args.planId, repository: args.repository, issue_number: response.data.number });
        issues.push({ number: response.data.number, url: response.data.html_url, title: response.data.title });
        await db('task_drafts').where({ draft_id: args.planId }).update({ plan_json: JSON.stringify(tasks.map((item, i) => issues[i] ? { ...item, issue_number: issues[i].number, issue_url: issues[i].url } : item)), updated_at: db.fn.now() });
      }
      await db('task_drafts').where({ draft_id: args.planId }).update({ status: 'executed', updated_at: db.fn.now() });
      return ok({ planId: args.planId, issues });
    } });

  tools.push({ name: 'implement_plan', description: 'Start selected published plan issues using explicit models, epic and auto-merge choices. Ultrafix is bounded to 10 cycles.', scope: 'execute', target,
    schema: z.object({ ...mutationShape, ...planShape, issues: z.array(z.number().int().positive()).min(1).max(20), models: z.array(z.object({ agent_alias: idSchema, model_name: idSchema }).strict()).min(1).max(4), useEpic: z.boolean().default(false), autoMerge: z.boolean().default(false), runUltrafix: z.boolean().default(false), ultrafixGoal: z.number().int().min(1).max(10).default(9), ultrafixMaxCycles: z.number().int().min(1).max(10).default(3) }).strict(), run: async ({ principal, args, operationId }) => {
      if (args.autoMerge) policy.requireScope(principal, 'merge');
      if (args.runUltrafix) policy.requireScope(principal, 'review');
      if (new Set(args.issues).size !== args.issues.length) throw new McpError('INVALID_INPUT', 'Select each issue only once.');
      const [agents, synthetic] = await Promise.all([loadAgents(), loadSyntheticAgents()]);
      for (const model of args.models) {
        const supported = agents.some(agent => agent.enabled && agent.alias === model.agent_alias && agent.supportedModels.includes(model.model_name))
          || synthetic.some(agent => agent.enabled && agent.alias === model.agent_alias && agent.models.some(choice => choice.enabled && choice.id === model.model_name));
        if (!supported) throw new McpError('INVALID_MODEL', 'Choose an enabled agent and supported model from list_models.');
      }
      const available = await db('plan_issues').where({ draft_id: args.planId }).whereIn('issue_number', args.issues);
      if (available.length !== new Set(args.issues).size) throw new McpError('NOT_FOUND', 'One or more selected issues do not belong to this plan.', 404);
      if (available.some(issue => issue.status !== 'pending')) throw new McpError('PRECONDITION_FAILED', 'A selected issue has already started.', 409);
      await db.transaction(async tx => {
        for (const number of args.issues) {
          const id = `${args.planId}:${number}`;
          const inserted = await tx('mcp_records').insert({ kind: 'issue_execution', id, owner_id: principal.user.id,
            value: policy.oauth.store.seal({ operationId, ownerId: principal.user.id }), expires_at: null }).onConflict(['kind', 'id']).ignore().returning('id');
          if (!inserted.length) throw new McpError('IMPLEMENTATION_ALREADY_REQUESTED', 'An implementation receipt already owns a selected issue. Inspect the plan and prior operation before recovery.', 409);
          await tx('plan_issues').where({ draft_id: args.planId, issue_number: number }).update({
            run_ultrafix: args.runUltrafix, ultrafix_goal: args.runUltrafix ? args.ultrafixGoal : null,
            ultrafix_max_cycles: args.runUltrafix ? args.ultrafixMaxCycles : null,
          });
        }
      });
      const results = [];
      for (const number of args.issues) {
        await policy.repository(principal, args.repository, true);
        if (!args.autoMerge) {
          const [owner, repo] = args.repository.split('/');
          try { await principal.github.request('DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}', { owner, repo, issue_number: number, name: 'auto-merge' }); }
          catch (error) { if ((error as { status?: number }).status !== 404) throw error; }
        }
        results.push((await callWorkflow(planner.implementIssue, principal, { params: { id: args.planId, issueNumber: String(number) }, body: { repository: args.repository, models: args.models, useEpic: args.useEpic, autoMerge: args.autoMerge } })).data);
      }
      return { status: 202, data: { planId: args.planId, issues: args.issues, results, message: 'Implementation requested. Inspect plan issues and tasks for execution state.' } };
    } });
}
