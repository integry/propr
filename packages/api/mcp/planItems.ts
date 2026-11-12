import type { Knex } from 'knex';
import type { z } from 'zod';
import { normalizePlanItems, resolvePlanItemIssueDependencies, serializeDependsOnIssues } from '@propr/shared';
import { logger, syncPlanDependencyLinks, type GitHubRequest, type PlanDependencyLinksResult } from '@propr/core';
import { McpError } from './config.js';
import type { McpPrincipal } from './policy.js';
import { withinPublicationLease } from './planPublication.js';
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

/**
 * Second publication pass: links each published issue on GitHub as blocked by
 * its prerequisites, with the caller's credential. Each request stays inside
 * the publication lease, and `renewClaim` runs before each dependant issue so a
 * slow GitHub cannot let another attempt take the claim over mid-way. Link
 * failures are returned per link and never thrown; only a claim error is.
 */
export async function linkPublishedDependencies(options: {
  principal: McpPrincipal; repository: string; tasks: unknown[];
  issues: ReadonlyMap<number, { number: number; id?: number }>;
  leaseDeadline: () => number; renewClaim: () => Promise<void>;
}): Promise<PlanDependencyLinksResult | null> {
  const [owner, repo] = options.repository.split('/');
  const issues = [...options.issues.values()];
  const request: GitHubRequest = (route, parameters) => withinPublicationLease(options.leaseDeadline(), signal =>
    options.principal.github.request(route, { ...parameters, request: { signal } }));
  return syncPlanDependencyLinks({ request, owner, repo, plan: options.tasks, logger,
    issueNumbers: options.tasks.map((_task, index) => options.issues.get(index)?.number),
    issueIds: new Map(issues.flatMap(issue => typeof issue.id === 'number' ? [[issue.number, issue.id] as [number, number]] : [])),
    beforeIssue: () => options.renewClaim() });
}
