import crypto from 'node:crypto';
import type { Knex } from 'knex';
import { GOAL_ERROR_CODES } from '@propr/shared';
import { buildGoalArtifactMarker, GoalGitHubStore, type GoalArtifactRow } from './goalGitHubStore.js';
import { GoalError, goalTransaction, guardLease, nowIso } from './goalRepositorySupport.js';
import type { GoalLeaseFence, GoalRecord } from './goalTypes.js';
import type {
  GoalCompletionReadiness, GoalGitHubArtifact, GoalNodeReadiness,
  GoalReadinessPolicy, GoalValidationEvidenceInput,
} from './goalOrchestrationTypes.js';
import type { AttemptRow } from './goalAttemptStore.js';

/** Exact-head validation, Ultrafix, and integration completion persistence. */
export class GoalIntegrationStore extends GoalGitHubStore {
  async descendantsIntegrated(goalId: string, nodeId: string): Promise<boolean> {
    const descendants = await descendantIds(this.db, goalId, nodeId);
    if (descendants.length === 0) return true;
    const rows = await this.db('goal_node_integrations').where('goal_id', goalId)
      .whereIn('node_id', descendants).select('integration_state');
    return rows.length === descendants.length
      && rows.every((row) => ['integrated', 'no_diff'].includes(row.integration_state as string));
  }

  async markAggregateRuntimeComplete(goalId: string, nodeId: string, fence: GoalLeaseFence): Promise<void> {
    await goalTransaction(this.db, async (trx) => {
      await guardLease(trx, goalId, fence);
      const node = await trx('goal_nodes').where({ goal_id: goalId, node_id: nodeId })
        .whereIn('kind', ['root_epic', 'sub_epic']).first();
      if (!node) notFound('Aggregate goal node not found');
      const timestamp = nowIso();
      await trx('goal_node_integrations').where({ goal_id: goalId, node_id: nodeId }).update({
        runtime_state: 'succeeded', integration_state: 'awaiting_artifacts',
        runtime_completed_at: timestamp, updated_at: timestamp,
      });
      await trx('goal_nodes').where({ goal_id: goalId, node_id: nodeId }).whereIn('status', ['pending', 'blocked'])
        .update({ status: 'blocked', updated_at: timestamp });
    });
  }

  async startUltrafixCycle(input: {
    goalId: string; nodeId: string; attemptId: string | null; headSha: string; fence: GoalLeaseFence;
  }): Promise<number> {
    return goalTransaction(this.db, async (trx) => {
      await guardLease(trx, input.goalId, input.fence);
      const attempt = input.attemptId === null ? null : await trx<AttemptRow>('goal_attempts').where({
        goal_id: input.goalId, node_id: input.nodeId, attempt_id: input.attemptId,
      }).first();
      const goal = await trx<GoalRecord>('goals').where('goal_id', input.goalId).first();
      if (input.attemptId !== null && !attempt) notFound('Goal attempt not found');
      const enabled = attempt ? Boolean(attempt.ultrafix_enabled) : Boolean(goal?.ultrafix_enabled);
      const maxCycles = attempt ? attempt.ultrafix_max_cycles : goal?.ultrafix_max_cycles;
      if (!enabled || maxCycles === null || maxCycles === undefined) invalidState('Ultrafix is not enabled');
      const latest = await trx('goal_ultrafix_cycles').where({ goal_id: input.goalId, node_id: input.nodeId }).max({ max: 'cycle' }).first();
      const cycle = Number(latest?.max ?? 0) + 1;
      if (cycle > maxCycles) invalidState('Ultrafix cycle snapshot has been exhausted');
      await trx('goal_ultrafix_cycles').insert({
        goal_id: input.goalId, node_id: input.nodeId, cycle, attempt_id: input.attemptId,
        head_sha: input.headSha, status: 'running', score: null, created_at: nowIso(), completed_at: null,
      });
      return cycle;
    });
  }

  async finishUltrafixCycle(input: {
    goalId: string; nodeId: string; cycle: number;
    result: { status: 'passed' | 'failed' | 'exhausted'; score?: number | null };
    fence: GoalLeaseFence;
  }): Promise<void> {
    await goalTransaction(this.db, async (trx) => {
      await guardLease(trx, input.goalId, input.fence);
      if (!Number.isSafeInteger(input.cycle) || input.cycle < 1) invalid('cycle must be a positive integer');
      if (input.result.score != null && (!Number.isInteger(input.result.score) || input.result.score < 0 || input.result.score > 10)) invalid('Invalid Ultrafix score');
      const changed = await trx('goal_ultrafix_cycles').where({
        goal_id: input.goalId, node_id: input.nodeId, cycle: input.cycle,
      }).update({ status: input.result.status, score: input.result.score ?? null, completed_at: nowIso() });
      if (changed !== 1) notFound('Ultrafix cycle not found');
    });
  }

  async canStartUltrafix(goalId: string, nodeId: string, attemptId: string | null): Promise<boolean> {
    const attempt = attemptId === null ? null : await this.db<AttemptRow>('goal_attempts')
      .where({ goal_id: goalId, node_id: nodeId, attempt_id: attemptId }).first();
    const goal = await this.db<GoalRecord>('goals').where('goal_id', goalId).first();
    const enabled = attempt ? Boolean(attempt.ultrafix_enabled) : Boolean(goal?.ultrafix_enabled);
    const maxCycles = attempt ? attempt.ultrafix_max_cycles : goal?.ultrafix_max_cycles;
    if (!enabled || maxCycles === null || maxCycles === undefined) return false;
    const latest = await this.db('goal_ultrafix_cycles').where({ goal_id: goalId, node_id: nodeId }).max({ max: 'cycle' }).first();
    return Number(latest?.max ?? 0) < maxCycles;
  }

  async hasPassingUltrafix(
    goalId: string,
    nodeId: string,
    exact: { headSha: string; baseSha: string; policy: GoalReadinessPolicy }
  ): Promise<boolean> {
    const goal = await this.db<GoalRecord>('goals').where('goal_id', goalId).first();
    if (!goal?.ultrafix_enabled || goal.ultrafix_goal === null) return true;
    const rows = await this.db('goal_validation_evidence').where({
      goal_id: goalId, node_id: nodeId, kind: 'ultrafix', head_sha: exact.headSha,
      base_sha: exact.baseSha, policy_hash: exact.policy.policyHash,
      status: 'passed', invalidated_at: null,
    });
    return rows.some((row) => scoreOf(row) >= goal.ultrafix_goal!);
  }

  async recordNoDiffArtifact(goalId: string, nodeId: string, fence: GoalLeaseFence): Promise<GoalGitHubArtifact> {
    return goalTransaction(this.db, async (trx) => {
      const goal = await guardLease(trx, goalId, fence);
      const spec = await trx('goal_node_specs').where({ goal_id: goalId, node_id: nodeId }).first();
      if (!spec) notFound('Goal node specification not found');
      const marker = buildGoalArtifactMarker({
        schemaVersion: 1, repository: goal.repository, goalId, nodeId,
        artifactKind: 'pull_request', head: spec!.head_branch as string, base: spec!.base_branch as string,
      });
      const artifactId = `ga_${crypto.createHash('sha256').update(`${goalId}\0${nodeId}\0pull_request`).digest('hex').slice(0, 32)}`;
      const timestamp = nowIso();
      await trx('goal_github_artifacts').insert({
        artifact_id: artifactId, goal_id: goalId, node_id: nodeId, kind: 'pull_request',
        repository: goal.repository, remote_id: null, number: null, url: null,
        head_branch: spec!.head_branch, base_branch: spec!.base_branch, head_sha: null, base_sha: null,
        state: 'no_diff', marker, last_observed_at: timestamp, created_at: timestamp, updated_at: timestamp,
      }).onConflict(['goal_id', 'node_id', 'kind']).merge({
        state: 'no_diff', marker, head_branch: spec!.head_branch, base_branch: spec!.base_branch,
        last_observed_at: timestamp, updated_at: timestamp,
      });
      await trx('goal_node_integrations').where({ goal_id: goalId, node_id: nodeId, runtime_state: 'succeeded' })
        .update({ integration_state: 'no_diff', integrated_at: timestamp, updated_at: timestamp });
      await trx('goal_nodes').where({ goal_id: goalId, node_id: nodeId }).whereIn('status', ['blocked', 'in_progress'])
        .update({ status: 'completed', updated_at: timestamp });
      return toArtifact((await trx<GoalArtifactRow>('goal_github_artifacts').where('artifact_id', artifactId).first())!);
    });
  }

  async recordEvidence(goalId: string, nodeId: string, input: GoalValidationEvidenceInput): Promise<void> {
    await goalTransaction(this.db, async (trx) => {
      await guardLease(trx, goalId, input);
      const cycle = input.cycle ?? 0;
      const evidenceId = crypto.createHash('sha256').update([
        goalId, nodeId, input.kind, input.headSha, input.baseSha, input.policyHash, String(cycle),
      ].join('\0')).digest('hex');
      const values = {
        expected_checks_json: JSON.stringify([...(input.expectedChecks ?? [])].sort()),
        result_json: JSON.stringify(input.result), status: input.status,
        observed_at: input.observedAt ?? nowIso(), invalidated_at: null,
      };
      await trx('goal_validation_evidence').insert({
        evidence_id: evidenceId, goal_id: goalId, node_id: nodeId, kind: input.kind,
        head_sha: input.headSha, base_sha: input.baseSha, policy_hash: input.policyHash,
        cycle, ...values, created_at: nowIso(),
      }).onConflict(['goal_id', 'node_id', 'kind', 'head_sha', 'base_sha', 'policy_hash', 'cycle']).merge(values);
      await trx('goal_validation_evidence').where({ goal_id: goalId, node_id: nodeId, kind: input.kind, invalidated_at: null })
        .andWhere((query) => void query.whereNot('head_sha', input.headSha)
          .orWhereNot('base_sha', input.baseSha).orWhereNot('policy_hash', input.policyHash))
        .update({ invalidated_at: nowIso() });
    });
  }

  async nodeReadiness(goalId: string, nodeId: string, policy: GoalReadinessPolicy): Promise<GoalNodeReadiness> {
    const node = await this.db('goal_nodes').where({ goal_id: goalId, node_id: nodeId }).first();
    if (!node) notFound('Goal node not found');
    const reasons: string[] = [];
    if (!await this.descendantsIntegrated(goalId, nodeId)) reasons.push('descendants_not_integrated');
    const integration = await this.db('goal_node_integrations').where({ goal_id: goalId, node_id: nodeId }).first();
    if (integration?.runtime_state !== 'succeeded' && integration?.integration_state !== 'no_diff') reasons.push('runtime_not_completed');
    if (!await directDependenciesIntegrated(this.db, goalId, nodeId)) reasons.push('dependencies_not_integrated');
    const artifact = await this.db<GoalArtifactRow>('goal_github_artifacts')
      .where({ goal_id: goalId, node_id: nodeId, kind: 'pull_request' }).first();
    if (artifact?.state === 'no_diff') return { ready: reasons.length === 0, reasons };
    if (!artifact || !['present', 'merged'].includes(artifact.state) || !artifact.head_sha || !artifact.base_sha) {
      reasons.push('pull_request_head_missing');
      return uniqueReadiness(reasons);
    }
    const evidence = await this.db('goal_validation_evidence').where({
      goal_id: goalId, node_id: nodeId, head_sha: artifact.head_sha, base_sha: artifact.base_sha,
      policy_hash: policy.policyHash, invalidated_at: null,
    });
    reasons.push(...evidenceFailures(evidence, policy));
    const goal = await this.db<GoalRecord>('goals').where('goal_id', goalId).first();
    if (goal?.merge_policy !== policy.mergePolicy) reasons.push('merge_policy_mismatch');
    if (goal?.ultrafix_enabled && goal.ultrafix_goal !== null
      && !evidence.some((row) => row.kind === 'ultrafix' && row.status === 'passed' && scoreOf(row) >= goal.ultrafix_goal!)) {
      reasons.push('ultrafix_threshold_not_met');
    }
    return uniqueReadiness(reasons);
  }

  async reconcileIntegrationEvidence(goalId: string, policy: GoalReadinessPolicy, fence: GoalLeaseFence): Promise<number> {
    await this.assertFence(goalId, fence);
    const integrations = await this.db('goal_node_integrations').where({ goal_id: goalId, runtime_state: 'succeeded' })
      .whereNotIn('integration_state', ['integrated', 'no_diff', 'failed', 'cancelled']);
    let count = 0;
    for (const integration of integrations) {
      const artifact = await this.db<GoalArtifactRow>('goal_github_artifacts')
        .where({ goal_id: goalId, node_id: integration.node_id, kind: 'pull_request' }).first();
      if (!artifact?.head_sha || !artifact.base_sha) continue;
      const readiness = await this.nodeReadiness(goalId, integration.node_id as string, policy);
      const state = readiness.ready ? artifact.state === 'merged' ? 'integrated' : 'ready_to_merge' : 'awaiting_validation';
      await persistIntegration(this.db, {
        goalId, nodeId: integration.node_id as string, artifact, state, policy, fence,
      });
      if (state === 'integrated') count += 1;
    }
    return count;
  }

  async goalCompletionReadiness(goalId: string, policy: GoalReadinessPolicy): Promise<GoalCompletionReadiness> {
    const goal = await this.db<GoalRecord>('goals').where('goal_id', goalId).first();
    if (!goal) notFound('Goal not found');
    const root = await this.db('goal_nodes').where('goal_id', goalId)
      .where((query) => void query.where('kind', 'root_epic').orWhere('kind', 'implementation_pr'))
      .orderBy('order_index').first();
    if (!root) return { ready: false, reasons: ['completion_node_missing'], terminalAction: null };
    const readiness = await this.nodeReadiness(goalId, root.node_id as string, policy);
    if (!readiness.ready) return { ...readiness, terminalAction: null };
    const artifact = await this.db<GoalArtifactRow>('goal_github_artifacts')
      .where({ goal_id: goalId, node_id: root.node_id, kind: 'pull_request' }).first();
    if (artifact?.state === 'no_diff') return { ready: true, reasons: [], terminalAction: 'complete' };
    if (artifact?.state !== 'merged') return { ready: false, reasons: ['final_merge_pending'], terminalAction: 'wait_for_merge' };
    return { ready: true, reasons: [], terminalAction: 'complete' };
  }
}

async function directDependenciesIntegrated(db: Knex, goalId: string, nodeId: string): Promise<boolean> {
  const dependencies = await db('goal_node_dependencies as dependency')
    .leftJoin('goal_node_integrations as integration', function joinIntegration() {
      this.on('integration.goal_id', '=', 'dependency.goal_id').andOn('integration.node_id', '=', 'dependency.depends_on_node_id');
    }).where({ 'dependency.goal_id': goalId, 'dependency.node_id': nodeId }).select('integration.integration_state');
  return dependencies.every((row) => ['integrated', 'no_diff'].includes(row.integration_state as string));
}

function evidenceFailures(rows: Array<Record<string, unknown>>, policy: GoalReadinessPolicy): string[] {
  const reasons: string[] = [];
  for (const kind of policy.requiredEvidence) {
    const passing = rows.filter((row) => row.kind === kind && row.status === 'passed');
    if (passing.length === 0) reasons.push(`${kind}_evidence_missing_or_unsuccessful`);
    if (kind === 'ci' && policy.expectedChecks) {
      const expected = JSON.stringify([...policy.expectedChecks].sort());
      if (!passing.some((row) => JSON.stringify(JSON.parse(row.expected_checks_json as string)) === expected)) reasons.push('ci_expected_check_set_mismatch');
    }
  }
  return reasons;
}

async function persistIntegration(db: Knex, input: {
  goalId: string; nodeId: string; artifact: GoalArtifactRow;
  state: string; policy: GoalReadinessPolicy; fence: GoalLeaseFence;
}): Promise<void> {
  await goalTransaction(db, async (trx) => {
    await guardLease(trx, input.goalId, input.fence);
    const timestamp = nowIso();
    await trx('goal_node_integrations').where({ goal_id: input.goalId, node_id: input.nodeId }).update({
      integration_state: input.state, head_sha: input.artifact.head_sha, base_sha: input.artifact.base_sha,
      policy_hash: input.policy.policyHash,
      merged_remote_id: input.state === 'integrated' ? input.artifact.remote_id : null,
      integrated_at: input.state === 'integrated' ? timestamp : null, updated_at: timestamp,
    });
    if (input.state === 'integrated') await trx('goal_nodes').where({ goal_id: input.goalId, node_id: input.nodeId })
      .update({ status: 'completed', updated_at: timestamp });
  });
}

async function descendantIds(db: Knex, goalId: string, rootId: string): Promise<string[]> {
  const rows = await db('goal_nodes').where('goal_id', goalId).select('node_id', 'parent_node_id');
  const children = new Map<string, string[]>();
  for (const row of rows) {
    if (row.parent_node_id == null) continue;
    children.set(row.parent_node_id as string, [...(children.get(row.parent_node_id as string) ?? []), row.node_id as string]);
  }
  const result: string[] = [];
  const pending = [...(children.get(rootId) ?? [])];
  while (pending.length > 0) {
    const id = pending.pop()!;
    result.push(id);
    pending.push(...(children.get(id) ?? []));
  }
  return result;
}

function scoreOf(row: Record<string, unknown>): number {
  return Number((JSON.parse(row.result_json as string) as { score?: unknown }).score ?? -1);
}

function uniqueReadiness(reasons: string[]): GoalNodeReadiness {
  const unique = [...new Set(reasons)];
  return { ready: unique.length === 0, reasons: unique };
}

function toArtifact(row: GoalArtifactRow): GoalGitHubArtifact {
  return {
    artifactId: row.artifact_id, goalId: row.goal_id, nodeId: row.node_id, kind: row.kind,
    repository: row.repository, remoteId: row.remote_id, number: row.number, url: row.url,
    headBranch: row.head_branch, baseBranch: row.base_branch, headSha: row.head_sha,
    baseSha: row.base_sha, state: row.state, marker: row.marker, lastObservedAt: row.last_observed_at,
  };
}

function invalid(message: string): never { throw new GoalError(GOAL_ERROR_CODES.validation, message, 400); }
function invalidState(message: string): never { throw new GoalError(GOAL_ERROR_CODES.invalidTransition, message, 409); }
function notFound(message: string): never { throw new GoalError(GOAL_ERROR_CODES.notFound, message, 404); }
