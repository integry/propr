import type { Knex } from 'knex';
import type { z } from 'zod';
import { normalizePlanItems, resolvePlanItemIssueDependencies, serializeDependsOnIssues } from '@propr/shared';
import { McpError } from './config.js';
import { preparePlanForStorage, type PreparedPlan } from '../routes/plannerHelpers/validation.js';

function invalidPlanItems(message: string, errors: unknown[]): McpError {
  return new McpError('PLAN_INVALID', message, 400, { stage: 'validation', retryable: false, details: { errors } });
}

function requiredTaskFields(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['title', 'body', 'implementation'];
  const task = value as Record<string, unknown>;
  return ['title', 'body', 'implementation'].filter(field => typeof task[field] !== 'string' || task[field].length === 0);
}

/** The stored plan parsed against the publication schema; incomplete tasks are listed by position. */
export function validatePublicationPlan(planJson: unknown, schema: z.ZodType): Array<Record<string, unknown>> {
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

/** Assigns missing item ids and rejects invalid ids or dependsOn edges, exactly as the REST draft update does. */
export function prepareMcpPlan(plan: unknown[]): Extract<PreparedPlan, { valid: true }> {
  const prepared = preparePlanForStorage(plan);
  if (!prepared.valid) throw invalidPlanItems(prepared.error, prepared.errors);
  return prepared;
}

/** The plan to publish, with ids for items that lack one (older drafts); invalid dependencies are refused. */
export function publicationPlanItems<T>(tasks: T[]): T[] {
  const graph = normalizePlanItems(tasks);
  if (!graph.ok) throw invalidPlanItems(graph.message, graph.errors);
  return graph.plan;
}

/** The predicate that proves a publication attempt still owns its draft. */
export interface PublicationClaim {
  planId: string;
  revision: number;
  contextConfig: string;
}

/**
 * Once every issue exists, records on each `plan_issues` row its item id and
 * prerequisite issue numbers, each update guarded by the publication claim.
 * The values follow from the plan and its issue numbers alone, so a resume
 * rewrites rows recorded by an earlier attempt identically. Returns false
 * when an update matched nothing, which the caller checks against its claim.
 */
export async function recordPublishedDependencies(db: Knex, claim: PublicationClaim, tasks: unknown[],
  issueNumbers: Array<number | undefined>): Promise<boolean> {
  let complete = true;
  for (const entry of resolvePlanItemIssueDependencies(tasks, issueNumbers)) {
    if (entry.issueNumber === null) continue;
    const updated = await db('plan_issues').where({ draft_id: claim.planId, issue_number: entry.issueNumber })
      .whereExists(db('task_drafts').select(db.raw('1')).where({ draft_id: claim.planId, status: 'executing',
        mcp_revision: claim.revision, context_config: claim.contextConfig }))
      .update({ plan_item_id: entry.itemId, depends_on_issues: serializeDependsOnIssues(entry.dependsOnIssues) });
    if (!updated) complete = false;
  }
  return complete;
}
