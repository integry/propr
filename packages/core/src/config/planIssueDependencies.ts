import type { Knex } from 'knex';
import { resolvePlanItemIssueDependencies, serializeDependsOnIssues } from '@propr/shared';
import { db } from '../db/connection.js';

type PlanItemReference = { id?: unknown; dependsOn?: unknown; issue_number?: unknown };

/**
 * Records, on each published plan issue, the plan item it came from and the
 * issue numbers of the items it depends on. Runs once every issue of the plan
 * exists, because `dependsOn` may name a later item. The values depend only on
 * the plan and its issue numbers, so re-publication and resume write the same
 * rows. A prerequisite whose issue creation failed is recorded as unresolved
 * rather than dropped, so its dependant never looks independent to a graph
 * execution.
 */
export async function recordPlanIssueDependencies(
  draftId: string,
  plan: ReadonlyArray<PlanItemReference>,
  database: Knex = db,
): Promise<void> {
  const resolved = resolvePlanItemIssueDependencies(plan,
    plan.map(task => typeof task.issue_number === 'number' ? task.issue_number : null));
  for (const entry of resolved) {
    if (entry.issueNumber === null) continue;
    await database('plan_issues').where({ draft_id: draftId, issue_number: entry.issueNumber })
      .update({ plan_item_id: entry.itemId, depends_on_issues: serializeDependsOnIssues(entry.dependsOnIssues, entry.unresolvedDependsOn) });
  }
}
