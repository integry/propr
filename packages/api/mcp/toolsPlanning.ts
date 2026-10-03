import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getEpicExecutionQueue, summarizeEpicQueue, type EpicAdvancePolicy } from '@propr/core';
import type { createPlannerRoutes } from '../routes/plannerRoutes.js';
import { McpError } from './config.js';
import { callWorkflow } from './adapter.js';
import { type McpTool, type ToolDeps, addPlanImplementationTool, TERMINAL_PLAN_STATUSES, planScopeShape, planShape, mutationShape, pageShape, repositorySchema, textSchema, idSchema, ok, workflow, markMergedPullRequests } from './tools.js';
import { planRelationLimit, summarizePlan } from './listSummaries.js';
import { getCurrentPlanCause, getPlanRevision, listPlanRevisions, restorePlanRevision } from '../routes/plannerHelpers/planRevisions.js';
import { classifyError, type McpErrorStage } from './errorEnvelope.js';
import { activePublication as parseActivePublication, findMarkedIssue, parseContextConfig, partialPublication, publicationLeaseLapsed, publicationLeaseLapsesAt, publicationSummary, publicationOwner, publicationOwnerStopped, withinPublicationLease, PUBLICATION_LEASE_EXPIRED, PUBLICATION_LEASE_MS, type ActivePublication, type PublishedIssue } from './planPublication.js';
import { McpOperations } from './operations.js';

/** Pure dispatch policy; schemas deliberately leave new options absent on old replays. */
export function planEpicDispatch({ issues, planOrder, useEpic, epicExecution, epicAdvanceOn, modelCount }: {
  issues: number[]; planOrder: number[]; useEpic: boolean;
  epicExecution?: 'sequential' | 'parallel'; epicAdvanceOn?: EpicAdvancePolicy; modelCount: number;
}): { mode: 'sequential' | 'parallel'; advanceOn: EpicAdvancePolicy; dispatchNow: number[]; queued: number[] } {
  const mode = useEpic ? epicExecution ?? 'sequential' : 'parallel';
  const advanceOn = epicAdvanceOn ?? 'merged';
  if (mode === 'parallel') return { mode, advanceOn, dispatchNow: [...issues], queued: [] };
  if (modelCount > 1) throw new McpError('INVALID_INPUT', 'Sequential epics require one model per issue: comparing models would create multiple PRs into the same epic branch. Use epicExecution: "parallel" for model comparisons.');
  const selected = new Set(issues);
  const ordered = planOrder.filter(number => selected.has(number));
  if (ordered.length !== issues.length) throw new McpError('INVALID_INPUT', 'Selected issues must appear once in plan publication order.');
  return { mode, advanceOn, dispatchNow: ordered.slice(0, 1), queued: ordered.slice(1) };
}

const target = { table: 'task_drafts', column: 'draft_id', arg: 'planId', owner: 'user_id' };
const columns = ['draft_id', 'repository', 'name', 'initial_prompt', 'plan_json', 'plan_cause', 'attachments', 'context_config', 'status', 'mcp_revision', 'paused', 'created_at', 'updated_at'];

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
  if (step === 'authorize') return 'authorization';
  if (['load_issues', 'record_issue', 'verify_claim', 'complete'].includes(step)) return 'database';
  if (step === 'create_issue') return 'github';
  if (stage) return stage;
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
      const revisions = await listPlanRevisions(db, args.planId);
      return ok({ ...draft, context_config: undefined, plan_cause: undefined, publication: publicationSummary(context.publication),
        attachments: attachments.map(({ id, originalName, mimeType, size }: Record<string, unknown>) => ({ id, originalName, mimeType, size })),
        plan: draft.plan_json ? JSON.parse(draft.plan_json) : [], plan_json: undefined,
        revisionHistory: {
          count: revisions.length,
          currentCause: draft.plan_cause || 'unknown',
          latest: revisions.slice(0, 10).map(revision => ({
            revisionId: revision.revision_id,
            cause: revision.cause,
            replacedAt: revision.replaced_at,
            issueCount: revision.issue_count,
            titles: revision.titles.slice(0, 5),
          })),
          tools: ['list_plan_revisions', 'get_plan_revision', 'restore_plan_revision'],
        },
        epicQueue: summarizeEpicQueue(await getEpicExecutionQueue(args.planId, { database: db })),
        issues: await db('plan_issues').where({ draft_id: args.planId }).limit(100) });
    } });
  tools.push({ name: 'create_plan', description: 'Create a draft plan only. This does not publish issues or start execution.', scope: 'plan',
    schema: z.object({ ...mutationShape, repository: repositorySchema, name: z.string().min(1).max(256), prompt: textSchema, plan: plan.optional(), todoIds: z.array(z.uuid()).max(20).optional() }).strict(),
    run: async ({ principal, args }) => {
      const id = randomUUID();
      await db.transaction(async tx => {
        const todoIds = [...new Set<string>(args.todoIds || [])];
        if (todoIds.length && (await tx('repo_todos').where({ user_id: principal.user.id, repository: args.repository }).whereIn('todo_id', todoIds)).length !== todoIds.length) throw new McpError('NOT_FOUND', 'Selected TODOs must belong to you in this repository.', 404);
        await tx('task_drafts').insert({ draft_id: id, user_id: principal.user.id, repository: args.repository, name: args.name, initial_prompt: args.prompt,
          plan_json: args.plan ? JSON.stringify(args.plan) : null, plan_cause: args.plan ? 'manual_edit' : null, status: 'draft' });
        if (todoIds.length) await tx('repo_todos').whereIn('todo_id', todoIds).update({ linked_draft_id: id, updated_at: tx.fn.now() });
      });
      return ok({ planId: id, revision: 0, status: 'draft' });
    } });
  tools.push({ name: 'update_plan', description: 'Update a draft using its exact revision. Read the plan again on a conflict.', scope: 'plan', target,
    schema: z.object({ ...mutationShape, ...planShape, expectedRevision: z.number().int().min(0), name: z.string().min(1).max(256).optional(), prompt: textSchema.optional(), plan: plan.optional() }).strict(),
    run: async ({ principal, args }) => {
      const serializedPlan = args.plan === undefined ? undefined : JSON.stringify(args.plan);
      const changed = await db('task_drafts').where({ draft_id: args.planId, user_id: principal.user.id, mcp_revision: args.expectedRevision })
        .whereIn('status', ['draft', 'review', 'approved', 'failed']).update({
          ...(args.name !== undefined ? { name: args.name } : {}), ...(args.prompt !== undefined ? { initial_prompt: args.prompt } : {}),
          ...(serializedPlan !== undefined ? { plan_json: serializedPlan,
            plan_cause: db.raw('CASE WHEN ?? = ? THEN ?? ELSE ? END', ['plan_json', serializedPlan, 'plan_cause', 'manual_edit']) } : {}),
          updated_at: db.fn.now(), mcp_revision: args.expectedRevision + 1,
        });
      if (!changed) throw new McpError('STALE_REVISION', 'Plan changed or an operation is active. Read it again before updating.', 409);
      return ok({ planId: args.planId, revision: args.expectedRevision + 1 });
    } });
  tools.push({ name: 'list_plan_revisions', description: 'List earlier versions of your plan, newest first, with their task titles. Every generation, refinement, edit or restore keeps the plan it replaced.', scope: 'read', readOnly: true,
    schema: z.object(planShape).strict(), target, run: async ({ args }) => {
      const revisions = await listPlanRevisions(db, args.planId);
      return ok({ planId: args.planId,
        currentCause: revisions[0]?.currentCause ?? await getCurrentPlanCause(db, args.planId), revisions });
    } });
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
      const partial = args.resume ? partialPublication(initialContext.publication) : undefined;
      const active = args.resume ? parseActivePublication(initialContext.publication) : undefined;
      // A persisted callback result, an OS-verified dead process or a lapsed
      // claim lease permits marker reconciliation. Lifecycle timeout or
      // cancellation alone cannot prove that an invocation has stopped making
      // external requests; the lease can, because its owner aborts each issue
      // POST at the lease deadline. It is the only proof available after the
      // runtime restarted into a fresh PID namespace.
      const stoppedActiveAttempt = active ? await db('mcp_operations').where({
        id: active.attemptId, owner_id: principal.user.id, tool: 'publish_plan', repository: args.repository,
      }).whereIn('state', ['completed', 'failed', 'cancelled', 'unknown']).whereNotNull('result')
        .where('updated_at', '>=', Date.parse(active.claimedAt)).first('id') : undefined;
      // Settle the prior attempt's own receipt for anyone polling it. This only
      // reclassifies a result-less receipt as unknown; it never writes a result,
      // so it cannot supply the stopped-attempt evidence read above.
      if (active) await new McpOperations(db).markInterruptedInvocations(principal, active.attemptId);
      const priorPublication = partial ?? (active && (stoppedActiveAttempt || publicationOwnerStopped(active.owner)
        || publicationLeaseLapsed(active)) ? active : undefined);
      const previousStatus = String(draft.status || 'draft');
      if (args.resume && draft.status === 'executing' && active && !priorPublication) {
        // The owner may renew again, so the lapse time is a lower bound and this
        // stays non-retryable: a later resume needs a new idempotency key.
        throw new McpError('PRECONDITION_FAILED', 'Plan is not recoverable yet. Its prior publication attempt may still be running; resume with a new idempotencyKey once its claim has lapsed.', 409, {
          stage: 'precondition', details: { claimLapsesAt: new Date(publicationLeaseLapsesAt(active)).toISOString() },
        });
      }
      if (args.resume && (draft.status !== 'executing' || !priorPublication)) {
        throw new McpError('PRECONDITION_FAILED', 'Plan is not recoverable. Resume requires a partial publication or an active publication whose prior attempt has stopped.', 409);
      }
      const originalOperationId = priorPublication?.operationId ?? String(operationId);
      const claimedAt = Date.now();
      const activePublication: ActivePublication = { state: 'active', operationId: originalOperationId,
        attemptId: String(operationId), created: priorPublication?.created ?? [], claimedAt: new Date(claimedAt).toISOString(),
        renewedAt: new Date(claimedAt).toISOString(), owner: publicationOwner() };
      const activeContext: Record<string, unknown> = { ...initialContext, publication: activePublication };
      // The stored context and revision are this attempt's claim token. Each
      // lease renewal replaces both, so later claim predicates read the current values.
      let activeContextJson = JSON.stringify(activeContext);
      let leaseDeadline = claimedAt + PUBLICATION_LEASE_MS;
      const claim = db('task_drafts').where({ draft_id: args.planId, mcp_revision: args.expectedRevision });
      if (args.resume) claim.andWhere({ status: 'executing', context_config: draft.context_config });
      else claim.whereIn('status', ['draft', 'review', 'approved']);
      let claimedRevision = args.expectedRevision + 1;
      const claimed = await claim.update({ status: 'executing', context_config: activeContextJson,
        updated_at: db.fn.now(), mcp_revision: claimedRevision });
      if (!claimed) throw new McpError('PRECONDITION_FAILED', args.resume
        ? 'Plan is no longer available to resume. Read it again and confirm its publication is still recoverable.'
        : 'Plan is already published or busy.', 409);
      const [owner, repo] = args.repository.split('/');
      const created = new Map<number, PublishedIssue>((priorPublication?.created ?? []).map(issue => [issue.index, issue]));
      const adopted: number[] = [];

      const ownsClaim = () => db('task_drafts').where({ draft_id: args.planId, status: 'executing',
        mcp_revision: claimedRevision, context_config: activeContextJson }).first('draft_id');
      const claimLost = () => new McpError('PUBLICATION_CLAIM_LOST',
        'The publication attempt no longer owns this plan. Inspect its current state before recovery.', 409,
        { stage: 'database', retryable: false });
      const assertClaim = async (): Promise<void> => {
        if (!await ownsClaim()) throw claimLost();
      };
      // Renewal doubles as the claim check: one statement proves this attempt
      // still owns the draft and restarts the lease that bounds its next issue
      // POST. A takeover compares the stored context and revision too, so it
      // cannot act on a lease that was renewed after it was read. The revision
      // is advanced here because the draft trigger would advance it regardless.
      const renewClaim = async (): Promise<void> => {
        const renewedAt = Date.now();
        const renewedContextJson = JSON.stringify({ ...activeContext,
          publication: { ...activePublication, renewedAt: new Date(renewedAt).toISOString() } });
        const renewed = await db('task_drafts').where({ draft_id: args.planId, status: 'executing',
          mcp_revision: claimedRevision, context_config: activeContextJson })
          .update({ context_config: renewedContextJson, mcp_revision: claimedRevision + 1 });
        if (!renewed) throw claimLost();
        activeContextJson = renewedContextJson;
        claimedRevision += 1;
        leaseDeadline = renewedAt + PUBLICATION_LEASE_MS;
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
          // The claim and its renewals advanced the revision, so a retry with the
          // caller's expectedRevision would fail as stale. Report the current one.
          const currentRevision = await db('task_drafts').where({ draft_id: args.planId }).first('mcp_revision').then(row => row?.mcp_revision, () => undefined);
          throw new McpError('PUBLISH_FAILED', `Plan publication failed while processing task ${failure.index + 1}.`, 409, {
            stage: failureStage(failure.step, classified.stage), retryable: classified.retryable, details: { ...details, currentRevision },
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
          stage: failureStage(failure.step, classified.stage), retryable: false, details,
        });
      };
      const requireClaim = async (failure: { index: number; title: string }, renew = false): Promise<void> => {
        try { await (renew ? renewClaim() : assertClaim()); }
        catch (error) {
          if (error instanceof McpError && error.code === 'PUBLICATION_CLAIM_LOST') throw error;
          await fail(error, { ...failure, step: 'verify_claim' });
        }
      };

      const recordIssue = async (number: number): Promise<void> => {
        // The authority check and insert share one statement, including after
        // a GitHub await. Losing the claim cannot append rows to a newer attempt.
        const inserted = await db.raw(`insert into \`plan_issues\` (draft_id, repository, issue_number)
          select draft_id, ?, ? from task_drafts
          where draft_id = ? and status = 'executing' and mcp_revision = ? and context_config = ?
          returning id`, [args.repository, number, args.planId, claimedRevision, activeContextJson]);
        if (!inserted.length) await assertClaim();
      };

      const recordedRows: Array<{ issue_number: unknown }> = await (async () => {
        try { return await db('plan_issues').where({ draft_id: args.planId }).select('issue_number').orderBy('id'); }
        catch (error) {
          const firstMissing = tasks.findIndex((_task, index) => !created.has(index));
          const index = partial?.failedIndex ?? Math.max(firstMissing, 0);
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
          await recordIssue(issue.number);
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
        // One renewal per task, placed directly before its issue is created or adopted.
        await requireClaim({ index, title: String(task.title) }, !args.resume);
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
          await requireClaim({ index, title: String(task.title) }, true);
        }
        if (!issue) {
          try {
            const response = await withinPublicationLease(leaseDeadline, signal => principal.github.request('POST /repos/{owner}/{repo}/issues', { owner, repo, title: String(task.title),
              body: `${task.body}\n\n## Implementation\n${task.implementation}${task.notes ? `\n\n## Notes\n${task.notes}` : ''}\n\n<!-- propr-mcp:${originalOperationId}:${index} -->`, labels: ['propr-planned'],
              request: { signal } }));
            issue = { number: response.data.number, url: response.data.html_url, title: response.data.title };
          } catch (error) {
            // A lease that ran out before the request started sent nothing.
            const sent = !(error instanceof McpError && error.code === PUBLICATION_LEASE_EXPIRED);
            await fail(error, { index, title: String(task.title), step: sent ? 'create_issue' : 'verify_claim', sideEffectsPossible: sent });
          }
        } else adopted.push(index);
        if (!issue) throw new McpError('INTERNAL_ERROR', 'Issue publication returned no result.', 500, { stage: 'internal' });
        const published = { index, number: issue.number, url: issue.url };
        created.set(index, published);
        try {
          await recordIssue(issue.number);
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

  addPlanImplementationTool(tools, deps, planner, target);
}
