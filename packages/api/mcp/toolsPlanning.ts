import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { loadAgents, loadSyntheticAgents } from '@propr/core';
import type { createPlannerRoutes } from '../routes/plannerRoutes.js';
import { McpError } from './config.js';
import { callWorkflow } from './adapter.js';
import { type McpTool, type ToolDeps, TERMINAL_PLAN_STATUSES, planScopeShape, planShape, mutationShape, pageShape, repositorySchema, textSchema, idSchema, ok, workflow, markMergedPullRequests } from './tools.js';
import { planRelationLimit, summarizePlan } from './listSummaries.js';
import { getPlanRevision, listPlanRevisions, restorePlanRevision } from '../routes/plannerHelpers/planRevisions.js';
import { classifyError, type McpErrorStage } from './errorEnvelope.js';
import { findMarkedIssue, parseContextConfig, partialPublication, publicationSummary, type ActivePublication, type PublishedIssue } from './planPublication.js';

const target = { table: 'task_drafts', column: 'draft_id', arg: 'planId', owner: 'user_id' };
const columns = ['draft_id', 'repository', 'name', 'initial_prompt', 'plan_json', 'attachments', 'context_config', 'status', 'mcp_revision', 'paused', 'created_at', 'updated_at'];

type PublicationStep = 'authorize' | 'create_issue' | 'load_issues' | 'record_issue' | 'verify_claim' | 'complete';

function requiredTaskFields(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['title', 'body', 'implementation'];
  const task = value as Record<string, unknown>;
  return ['title', 'body', 'implementation'].filter(field => typeof task[field] !== 'string' || task[field].length === 0);
}

function validatePublicationPlan(planJson: unknown, schema: z.ZodType): Array<Record<string, unknown>> {
  let value: unknown;
  try { value = typeof planJson === 'string' ? JSON.parse(planJson) : planJson; }
  catch { value = null; }
  const entries = Array.isArray(value) ? value : [];
  const incomplete = entries.map((task, index) => ({ index,
    title: task && typeof task === 'object' && typeof (task as Record<string, unknown>).title === 'string'
      ? (task as Record<string, unknown>).title : `Task ${index + 1}`,
    missing: requiredTaskFields(task),
  })).filter(task => task.missing.length > 0);
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new McpError('PLAN_INVALID', 'Plan is incomplete or invalid. Update it before publishing.', 400, {
    stage: 'validation', retryable: false, details: { incomplete },
  });
  return parsed.data as Array<Record<string, unknown>>;
}

function failureStage(step: PublicationStep, stage: McpErrorStage | null): McpErrorStage {
  if (stage) return stage;
  if (step === 'authorize') return 'authorization';
  if (step === 'record_issue') return 'database';
  return 'github';
}

export function addPlanningTools(tools: McpTool[], deps: ToolDeps, planner: ReturnType<typeof createPlannerRoutes>): void {
  const planTask = z.object({ id: idSchema.optional(), title: z.string().min(1).max(256), body: textSchema, implementation: textSchema, notes: textSchema.optional() }).strict();
  const plan = z.array(planTask).min(1).max(20);
  
  const { db, policy } = deps;
  tools.push({ name: 'list_plans', description: 'List compact plan summaries with issue progress, agent assignments and pull requests. Filter with status to see only one lifecycle state, such as review or executing; active covers every plan that has not merged or failed.', scope: 'read', readOnly: true,
    schema: z.object({ repository: repositorySchema, ...planScopeShape, ...pageShape }).strict(), run: async ({ principal, args }) => {
      const query = db('task_drafts').where({ repository: args.repository, user_id: principal.user.id });
      // The lifecycle filter runs in the query, before paging, so offset and limit page the filtered set.
      if (args.status === 'active') query.whereRaw(`coalesce(status, 'draft') not in (${TERMINAL_PLAN_STATUSES.map(() => '?').join(', ')})`, [...TERMINAL_PLAN_STATUSES]);
      else if (args.status && args.status !== 'all') query.where('status', args.status);
      const rows = await query
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
      const context = parseContextConfig(draft.context_config);
      return ok({ ...draft, context_config: undefined, publication: publicationSummary(context.publication),
        attachments: attachments.map(({ id, originalName, mimeType, size }: Record<string, unknown>) => ({ id, originalName, mimeType, size })),
        plan: draft.plan_json ? JSON.parse(draft.plan_json) : [], plan_json: undefined,
        issues: await db('plan_issues').where({ draft_id: args.planId }).limit(100) });
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
  tools.push({ name: 'list_plan_revisions', description: 'List earlier versions of your plan, newest first, with their task titles. Every generation, refinement, edit or restore keeps the plan it replaced.', scope: 'read', readOnly: true,
    schema: z.object(planShape).strict(), target, run: async ({ args }) => ok({ planId: args.planId, revisions: await listPlanRevisions(db, args.planId) }) });
  tools.push({ name: 'get_plan_revision', description: 'Read the full tasks of one earlier plan version from list_plan_revisions.', scope: 'read', readOnly: true,
    schema: z.object({ ...planShape, revisionId: z.number().int().positive() }).strict(), target, run: async ({ args }) => {
      const revision = await getPlanRevision(db, args.planId, args.revisionId);
      if (!revision) throw new McpError('NOT_FOUND', 'Plan revision not found.', 404);
      return ok(revision);
    } });
  tools.push({ name: 'restore_plan_revision', description: 'Make an earlier plan version current again at an exact revision. The replaced plan stays in the history, so a restore can be undone. Published or busy plans cannot be restored.', scope: 'plan', target,
    schema: z.object({ ...mutationShape, ...planShape, expectedRevision: z.number().int().min(0), revisionId: z.number().int().positive() }).strict(), run: async ({ args }) => {
      const result = await restorePlanRevision(db, args.planId, args.revisionId, { expectedRevision: args.expectedRevision });
      if (!result.restored && result.reason === 'not_found') throw new McpError('NOT_FOUND', 'Plan revision not found.', 404);
      if (!result.restored) throw new McpError('STALE_REVISION', 'Plan changed, is busy or was already published. Read it again before restoring.', 409);
      return ok({ planId: args.planId, revision: result.revision, status: 'review', plan: result.plan });
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
    // eslint-disable-next-line complexity -- publication recovery deliberately keeps claim, adoption and failure transitions in one auditable operation.
    schema: z.object({ ...mutationShape, ...planShape, expectedRevision: z.number().int().min(0), resume: z.boolean().default(false) }).strict(), run: async ({ principal, args, operationId }) => {
      const draft = await db('task_drafts').where({ draft_id: args.planId, mcp_revision: args.expectedRevision }).first();
      if (!draft) throw new McpError('STALE_REVISION', 'Plan revision changed.', 409);
      const publicationPlan = z.array(planTask.extend({ issue_number: z.number().int().positive().optional(), issue_url: z.string().url().optional() })).min(1).max(20);
      const tasks = validatePublicationPlan(draft.plan_json, publicationPlan);
      const initialContext = parseContextConfig(draft.context_config);
      const priorPublication = args.resume ? partialPublication(initialContext.publication) : undefined;
      const previousStatus = String(draft.status || 'draft');
      if (args.resume && (draft.status !== 'executing' || !priorPublication)) {
        throw new McpError('PRECONDITION_FAILED', 'Plan is not partially published. Resume is only available for an executing plan whose publication state is partial.', 409);
      }
      const originalOperationId = priorPublication?.operationId ?? String(operationId);
      const activePublication: ActivePublication = { state: 'active', operationId: originalOperationId,
        attemptId: String(operationId), created: priorPublication?.created ?? [], claimedAt: new Date().toISOString() };
      const activeContext: Record<string, unknown> = { ...initialContext, publication: activePublication };
      const activeContextJson = JSON.stringify(activeContext);
      const claim = db('task_drafts').where({ draft_id: args.planId, mcp_revision: args.expectedRevision });
      if (args.resume) claim.andWhere({ status: 'executing' });
      else claim.whereIn('status', ['draft', 'review', 'approved']);
      const claimedRevision = args.expectedRevision + 1;
      const claimed = await claim.update({ status: 'executing', context_config: activeContextJson,
        updated_at: db.fn.now(), mcp_revision: claimedRevision });
      if (!claimed) throw new McpError('PRECONDITION_FAILED', args.resume
        ? 'Plan is no longer available to resume. Read it again and confirm its publication is still partial.'
        : 'Plan is already published or busy.', 409);
      const [owner, repo] = args.repository.split('/');
      const created = new Map<number, PublishedIssue>((priorPublication?.created ?? []).map(issue => [issue.index, issue]));
      const adopted: number[] = [];

      const ownsClaim = () => db('task_drafts').where({ draft_id: args.planId, status: 'executing',
        mcp_revision: claimedRevision, context_config: activeContextJson }).first('draft_id');
      const assertClaim = async (): Promise<void> => {
        if (!await ownsClaim()) throw new McpError('PUBLICATION_CLAIM_LOST',
          'The publication attempt no longer owns this plan. Inspect its current state before recovery.', 409,
          { stage: 'database', retryable: false });
      };

      const fail = async (error: unknown, failure: { index: number; title: string; step: PublicationStep;
        sideEffectsPossible?: boolean }): Promise<never> => {
        const classified = classifyError(error, { sideEffectsPossible: false });
        const outcomeUncertain = failure.sideEffectsPossible === true && classified.status >= 500;
        const cause = { code: classified.code, message: classified.message };
        const createdIssues = [...created.values()].sort((left, right) => left.index - right.index);
        const details = { failedIndex: failure.index, failedTitle: failure.title,
          step: failure.step, createdIssues, cause };
        if (!createdIssues.length && !args.resume && !outcomeUncertain) {
          const released = await db('task_drafts').where({ draft_id: args.planId, status: 'executing',
            mcp_revision: claimedRevision, context_config: activeContextJson })
            .update({ status: previousStatus, context_config: JSON.stringify(initialContext), updated_at: db.fn.now() });
          if (!released) await assertClaim();
          throw new McpError('PUBLISH_FAILED', `Plan publication failed while processing task ${failure.index + 1}.`, 409, {
            stage: failureStage(failure.step, classified.stage), retryable: classified.retryable, details,
          });
        }
        const context: Record<string, unknown> = { ...activeContext };
        context.publication = { state: 'partial', operationId: originalOperationId, created: createdIssues,
          failedIndex: failure.index, failedAt: new Date().toISOString(), cause };
        const preserved = await db('task_drafts').where({ draft_id: args.planId, status: 'executing',
          mcp_revision: claimedRevision, context_config: activeContextJson })
          .update({ context_config: JSON.stringify(context), updated_at: db.fn.now() });
        if (!preserved) await assertClaim();
        throw new McpError('PUBLISH_PARTIAL', `Plan publication stopped after creating ${createdIssues.length} issue(s). Call publish_plan again with resume: true.`, 409, {
          stage: ['load_issues', 'verify_claim', 'complete'].includes(failure.step) ? 'database' : 'github', retryable: false, details,
        });
      };
      const requireClaim = async (failure: { index: number; title: string }): Promise<void> => {
        try { await assertClaim(); }
        catch (error) {
          if (error instanceof McpError && error.code === 'PUBLICATION_CLAIM_LOST') throw error;
          await fail(error, { ...failure, step: 'verify_claim' });
        }
      };

      const recordedRows: Array<{ issue_number: unknown }> = await (async () => {
        try { return await db('plan_issues').where({ draft_id: args.planId }).select('issue_number').orderBy('id'); }
        catch (error) {
          const index = priorPublication?.failedIndex ?? 0;
          return fail(error, { index, title: String(tasks[index]?.title || `Task ${index + 1}`), step: 'load_issues' });
        }
      })();
      const recorded = new Set<number>(recordedRows.map(row => Number(row.issue_number)));
      for (const [index, task] of tasks.entries()) {
        const number = Number(task.issue_number);
        if (!created.has(index) && Number.isSafeInteger(number) && number > 0 && recorded.has(number)) {
          created.set(index, { index, number, url: typeof task.issue_url === 'string'
            ? task.issue_url : `https://github.com/${args.repository}/issues/${number}` });
        }
      }
      const represented = new Set([...created.values()].map(issue => issue.number));
      for (const row of recordedRows) {
        const number = Number(row.issue_number);
        if (represented.has(number)) continue;
        const index = tasks.findIndex((_task, candidate) => !created.has(candidate));
        if (index < 0) break;
        created.set(index, { index, number, url: `https://github.com/${args.repository}/issues/${number}` });
        represented.add(number);
      }
      for (const issue of [...created.values()].sort((left, right) => left.index - right.index)) {
        if (recorded.has(issue.number)) continue;
        try {
          await db('plan_issues').insert({ draft_id: args.planId, repository: args.repository, issue_number: issue.number });
          recorded.add(issue.number);
        } catch (error) {
          await fail(error, { index: issue.index,
            title: String(tasks[issue.index]?.title || `Task ${issue.index + 1}`), step: 'record_issue' });
        }
      }

      for (const [index, task] of tasks.entries()) {
        if (created.has(index)) continue;
        // Deliberately no automatic POST retry: the durable operation and draft
        // claim and marker recovery prevent a replay after an uncertain response.
        try { await policy.repository(principal, args.repository, true); }
        catch (error) { await fail(error, { index, title: String(task.title), step: 'authorize' }); }
        await requireClaim({ index, title: String(task.title) });
        let issue: { number: number; url: string; title: string } | undefined;
        if (args.resume) {
          try {
            const floor = [...created.values()].reduce<number | undefined>((highest, candidate) =>
              highest === undefined || candidate.number > highest ? candidate.number : highest, undefined);
            const lookup = await findMarkedIssue(principal, args.repository,
              { operationId: originalOperationId, index, afterIssueNumber: floor });
            if (lookup.state === 'found') issue = lookup.issue;
            else if (lookup.state === 'incomplete') throw new McpError('MARKER_LOOKUP_INCOMPLETE',
              'Recovery could not search the complete publication window. No new issue was created.', 409,
              { stage: 'github', retryable: false });
          }
          catch (error) { await fail(error, { index, title: String(task.title), step: 'create_issue' }); }
          await requireClaim({ index, title: String(task.title) });
        }
        if (!issue) {
          try {
            const response = await principal.github.request('POST /repos/{owner}/{repo}/issues', { owner, repo, title: String(task.title),
              body: `${task.body}\n\n## Implementation\n${task.implementation}${task.notes ? `\n\n## Notes\n${task.notes}` : ''}\n\n<!-- propr-mcp:${originalOperationId}:${index} -->`, labels: ['propr-planned'] });
            issue = { number: response.data.number, url: response.data.html_url, title: response.data.title };
          } catch (error) {
            await fail(error, { index, title: String(task.title), step: 'create_issue', sideEffectsPossible: true });
          }
        } else adopted.push(index);
        if (!issue) throw new McpError('INTERNAL_ERROR', 'Issue publication returned no result.', 500, { stage: 'internal' });
        const published = { index, number: issue.number, url: issue.url };
        created.set(index, published);
        try {
          await db('plan_issues').insert({ draft_id: args.planId, repository: args.repository, issue_number: issue.number });
          recorded.add(issue.number);
        } catch (error) { await fail(error, { index, title: String(task.title), step: 'record_issue' }); }
      }
      const issues = tasks.map((task, index) => ({ ...created.get(index)!, title: String(task.title) }))
        .map(({ number, url, title }) => ({ number, url, title }));
      const finalContext: Record<string, unknown> = { ...activeContext };
      delete finalContext.publication;
      const linkedTasks = tasks.map((task, index) => ({ ...task,
        issue_number: created.get(index)!.number, issue_url: created.get(index)!.url }));
      const completed = await (async () => {
        try {
          return await db('task_drafts').where({ draft_id: args.planId, status: 'executing',
            mcp_revision: claimedRevision, context_config: activeContextJson }).update({
            status: 'executed', context_config: JSON.stringify(finalContext), plan_json: JSON.stringify(linkedTasks), updated_at: db.fn.now(),
          });
        } catch (error) {
          const index = tasks.length - 1;
          return fail(error, { index, title: String(tasks[index]?.title || `Task ${index + 1}`), step: 'complete' });
        }
      })();
      if (!completed) await requireClaim({ index: tasks.length - 1, title: String(tasks.at(-1)?.title || `Task ${tasks.length}`) });
      return ok({ planId: args.planId, issues, resumed: Boolean(args.resume), adopted });
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
