import type { Knex } from 'knex';
import { GOAL_ERROR_CODES } from '@propr/shared';
import { GoalIntegrationStore } from './goalIntegrationStore.js';
import { GoalError, goalTransaction, guardLease, nowIso } from './goalRepositorySupport.js';
import type { GoalLeaseFence, GoalRecord } from './goalTypes.js';
import { validateGoalPlan } from './goalPlanValidator.js';
import type { GoalPlanInput, ValidatedGoalPlan, ValidatedGoalPlanNode } from './goalOrchestrationTypes.js';

export { buildGoalArtifactMarker, parseGoalArtifactMarker } from './goalGitHubStore.js';

interface NodeSpecRow {
  node_id: string; goal_id: string; plan_revision: number; correlation_key: string;
  acceptance_criteria_json: string; estimate: number; depth: number;
  base_branch: string; head_branch: string; no_code: number;
}

/** Public persistence facade; focused stores below it keep transaction concerns cohesive. */
export class GoalOrchestrationRepository extends GoalIntegrationStore {
  constructor(db: Knex) { super(db); }

  async installPlan(
    goalId: string,
    input: GoalPlanInput,
    fence: GoalLeaseFence
  ): Promise<{ revision: number; plan: ValidatedGoalPlan; replayed: boolean }> {
    const plan = validateGoalPlan(goalId, input);
    return goalTransaction(this.db, async (trx) => {
      await guardLease(trx, goalId, fence);
      const latest = await trx('goal_plan_revisions').where('goal_id', goalId).orderBy('revision', 'desc').first();
      if (latest?.plan_hash === plan.hash) return { revision: latest.revision as number, plan, replayed: true };
      const claimedArtifact = await trx('goal_github_outbox').where({ goal_id: goalId, state: 'claimed' }).first('operation_id');
      if (claimedArtifact) {
        throw new GoalError(
          GOAL_ERROR_CODES.hierarchyConflict,
          'Replanning waits for claimed GitHub effects to reconcile before changing artifact identities',
          409
        );
      }
      await assertReplacementPreservesWork(trx, goalId, plan);
      const revision = Number(latest?.revision ?? 0) + 1;
      const diff = await planDiff(trx, goalId, plan);
      await trx('goal_plan_revisions').insert({
        goal_id: goalId, revision, schema_version: 1, plan_hash: plan.hash,
        plan_json: JSON.stringify(plan), change_summary_json: JSON.stringify(diff), created_at: nowIso(),
      });
      await supersedeOmittedNodes(trx, goalId, plan.nodes.map((node) => node.nodeId));
      for (const node of plan.nodes) await upsertPlanNode(trx, goalId, revision, node);
      await replaceDependencies(trx, goalId, plan);
      return { revision, plan, replayed: false };
    });
  }

  async getCurrentPlan(goalId: string): Promise<{ revision: number; plan: ValidatedGoalPlan } | null> {
    const row = await this.db('goal_plan_revisions').where('goal_id', goalId).orderBy('revision', 'desc').first();
    if (!row) return null;
    return { revision: row.revision as number, plan: JSON.parse(row.plan_json as string) as ValidatedGoalPlan };
  }

  async heartbeat(goalId: string, controllerId: string, scanState: Record<string, unknown>, fence: GoalLeaseFence): Promise<void> {
    await goalTransaction(this.db, async (trx) => {
      await guardLease(trx, goalId, fence);
      const heartbeat = {
        controller_id: controllerId, lease_generation: fence.leaseEpoch,
        heartbeat_at: nowIso(), scan_state_json: JSON.stringify(scanState),
      };
      await trx('goal_controller_heartbeats').insert({ goal_id: goalId, ...heartbeat })
        .onConflict('goal_id').merge(heartbeat);
    });
  }

  async listRecoverableGoals(now = nowIso()): Promise<string[]> {
    return this.db<GoalRecord>('goals').whereNotIn('state', ['completed', 'failed', 'cancelled'])
      .andWhere((query) => void query.whereNull('lease_owner').orWhereNull('lease_expires_at').orWhere('lease_expires_at', '<=', now))
      .orderBy('created_at').pluck('goal_id');
  }
}

async function supersedeOmittedNodes(trx: Knex.Transaction, goalId: string, currentIds: string[]): Promise<void> {
  const prior = await trx('goal_nodes').where('goal_id', goalId).select('node_id');
  const omitted = prior.map((row) => row.node_id as string).filter((id) => !currentIds.includes(id));
  if (omitted.length === 0) return;
  const timestamp = nowIso();
  await trx('goal_nodes').where('goal_id', goalId).whereIn('node_id', omitted).whereIn('status', ['pending', 'blocked'])
    .update({ status: 'cancelled', updated_at: timestamp });
  await trx('goal_node_integrations').where('goal_id', goalId).whereIn('node_id', omitted)
    .update({ runtime_state: 'cancelled', integration_state: 'cancelled', updated_at: timestamp });
  await trx('goal_github_outbox').where('goal_id', goalId).whereIn('node_id', omitted)
    .whereIn('state', ['pending', 'claimed']).update({
      state: 'superseded', claimed_by: null, claim_generation: null, claim_token: null,
      claim_expires_at: null, superseded_at: timestamp, updated_at: timestamp,
    });
}

async function upsertPlanNode(
  trx: Knex.Transaction,
  goalId: string,
  revision: number,
  node: ValidatedGoalPlanNode
): Promise<void> {
  const existing = await trx('goal_nodes').where({ goal_id: goalId, node_id: node.nodeId }).first();
  if (!existing) {
    await trx('goal_nodes').insert({
      node_id: node.nodeId, requested_node_id: node.nodeId, goal_id: goalId,
      parent_node_id: node.parentNodeId, kind: node.kind, idempotency_key: `plan-node:${node.key}`,
      external_ref: null, external_kind: null, title: node.title, status: 'pending',
      attempt_count: 0, order_index: node.orderIndex, created_at: nowIso(), updated_at: nowIso(),
    });
  } else {
    await trx('goal_nodes').where({ goal_id: goalId, node_id: node.nodeId }).update({
      parent_node_id: node.parentNodeId, kind: node.kind, title: node.title,
      order_index: node.orderIndex, ...(existing.status === 'cancelled' ? { status: 'pending' } : {}),
      updated_at: nowIso(),
    });
  }
  await trx('goal_node_specs').insert(toSpec(goalId, revision, node)).onConflict('node_id').merge({
    plan_revision: revision, acceptance_criteria_json: JSON.stringify(node.acceptanceCriteria),
    estimate: node.estimate, depth: node.depth, base_branch: node.baseBranch,
    head_branch: node.headBranch, no_code: node.noCode, updated_at: nowIso(),
  });
  await trx('goal_node_integrations').insert({
    goal_id: goalId, node_id: node.nodeId, runtime_state: 'pending',
    integration_state: 'pending', updated_at: nowIso(),
  }).onConflict(['goal_id', 'node_id']).ignore();
}

async function replaceDependencies(trx: Knex.Transaction, goalId: string, plan: ValidatedGoalPlan): Promise<void> {
  const currentIds = plan.nodes.map((node) => node.nodeId);
  await trx('goal_node_dependencies').where('goal_id', goalId).whereIn('node_id', currentIds).delete();
  const dependencies = plan.nodes.flatMap((node) => node.dependencyNodeIds.map((dependency) => ({
    goal_id: goalId, node_id: node.nodeId, depends_on_node_id: dependency, created_at: nowIso(),
  })));
  if (dependencies.length > 0) await trx('goal_node_dependencies').insert(dependencies);
}

function toSpec(goalId: string, revision: number, node: ValidatedGoalPlanNode): NodeSpecRow & {
  created_at: string; updated_at: string;
} {
  return {
    node_id: node.nodeId, goal_id: goalId, plan_revision: revision, correlation_key: node.key,
    acceptance_criteria_json: JSON.stringify(node.acceptanceCriteria), estimate: node.estimate,
    depth: node.depth, base_branch: node.baseBranch, head_branch: node.headBranch,
    no_code: node.noCode ? 1 : 0, created_at: nowIso(), updated_at: nowIso(),
  };
}

async function assertReplacementPreservesWork(trx: Knex.Transaction, goalId: string, plan: ValidatedGoalPlan): Promise<void> {
  const protectedRows = await trx('goal_nodes as n').join('goal_node_specs as s', 's.node_id', 'n.node_id')
    .where('n.goal_id', goalId).whereIn('n.status', ['in_progress', 'completed'])
    .select('n.node_id', 'n.parent_node_id', 'n.kind', 'n.title', 's.correlation_key',
      's.base_branch', 's.head_branch', 's.acceptance_criteria_json', 's.estimate', 's.no_code');
  const edges = await trx('goal_node_dependencies').where('goal_id', goalId).select('node_id', 'depends_on_node_id');
  const byKey = new Map(plan.nodes.map((node) => [node.key, node]));
  for (const existing of protectedRows) {
    const replacement = byKey.get(existing.correlation_key as string);
    const dependencies = edges.filter((edge) => edge.node_id === existing.node_id)
      .map((edge) => edge.depends_on_node_id as string).sort();
    if (!replacement || replacement.nodeId !== existing.node_id || replacement.parentNodeId !== existing.parent_node_id
      || replacement.kind !== existing.kind || replacement.title !== existing.title
      || replacement.baseBranch !== existing.base_branch || replacement.headBranch !== existing.head_branch
      || replacement.estimate !== existing.estimate || replacement.noCode !== Boolean(existing.no_code)
      || JSON.stringify(replacement.acceptanceCriteria) !== existing.acceptance_criteria_json
      || JSON.stringify(replacement.dependencyNodeIds) !== JSON.stringify(dependencies)) {
      throw new GoalError(GOAL_ERROR_CODES.hierarchyConflict, 'A replan cannot discard or remap active/completed work', 409);
    }
  }
}

async function planDiff(trx: Knex.Transaction, goalId: string, plan: ValidatedGoalPlan): Promise<Array<Record<string, unknown>>> {
  const revision = await trx('goal_plan_revisions').where('goal_id', goalId).orderBy('revision', 'desc').first('plan_json');
  const previous = revision ? JSON.parse(revision.plan_json as string) as ValidatedGoalPlan : null;
  const oldByKey = new Map((previous?.nodes ?? []).map((node) => [node.key, node]));
  const oldKeys = new Set(oldByKey.keys());
  const newKeys = new Set(plan.nodes.map((node) => node.key));
  return [
    ...[...newKeys].filter((key) => !oldKeys.has(key)).map((key) => ({ action: 'added', key })),
    ...[...oldKeys].filter((key) => !newKeys.has(key)).map((key) => ({ action: 'removed', key })),
    ...plan.nodes.filter((node) => oldByKey.has(node.key)
      && JSON.stringify(oldByKey.get(node.key)) !== JSON.stringify(node))
      .map((node) => ({ action: 'modified', key: node.key, before: oldByKey.get(node.key), after: node })),
  ];
}
