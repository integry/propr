import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import { db } from '../../db/connection.js';
import logger from '../../utils/logger.js';
import { getAuthenticatedOctokit } from '../../auth/githubAuth.js';
import { safeUpdateLabels } from '../../utils/github/labelOperations.js';
import { PlanIssueStatus, type PlanIssue } from '../../config/planIssueManager.js';
import { isTerminalStatus, isInProgressStatus } from '../../webhook/statusMachine.js';
import { labelPlanIssueForProcessing, finalizeEpicPlanIfComplete, reconcileTerminalInProgressIssues } from '../../webhook/planIssueTrigger.js';

export type EpicAdvancePolicy = 'merged' | 'terminal';
export type EpicQueueStatus = 'active' | 'completed' | 'cancelled';
export interface EpicExecutionQueue {
  draftId: string;
  executionId: string;
  repository: string;
  issues: number[];
  cursor: number;
  status: EpicQueueStatus;
  advanceOn: EpicAdvancePolicy;
  blockedReason: string | null;
  autoMerge: boolean;
  /** Non-epic auto-merge queues start successors without the plan's epic branch label. */
  useEpic: boolean;
  /** Parallel epics dispatch every child up front; the row only owes epic finalization. */
  parallel: boolean;
  /** Durable initial dispatch intent; plan_issues retains the old model for label removal. */
  headSelection: { agent_alias: string; model_name: string } | null;
  /** Outstanding epic completion labeling, independent of the current children's branch. */
  owesEpicFinalization: boolean;
  ready: boolean;
  headStartedAt: number | null;
  createdAt: number;
  updatedAt: number;
  finalizedAt: number | null;
  finalizationStartedAt: number | null;
}

type QueueRow = {
  draft_id: string; execution_id: string; repository: string; issues: string; cursor: number;
  status: EpicQueueStatus; advance_on: EpicAdvancePolicy; blocked_reason: string | null;
  auto_merge: boolean | number; use_epic: boolean | number; parallel: boolean | number; ready: boolean | number; head_started_at: number | null;
  head_selection: string | null; owes_epic_finalization: boolean | number;
  created_at: number; updated_at: number; finalized_at: number | null; finalization_started_at: number | null;
};

type StartIssue = (input: Parameters<typeof labelPlanIssueForProcessing>[0]) => Promise<void>;
export interface EpicQueueDependencies {
  database?: Knex;
  startIssue?: StartIssue;
  finalize?: (draftId: string, canFinalize: () => Promise<boolean>) => Promise<boolean>;
  now?: () => number;
  repairSetup?: (queue: EpicExecutionQueue) => Promise<boolean>;
}
const RETRY_PENDING_AFTER_MS = 15 * 60 * 1000;

function fromRow(row: QueueRow): EpicExecutionQueue {
  return {
    draftId: row.draft_id, executionId: row.execution_id, repository: row.repository, issues: JSON.parse(row.issues),
    cursor: row.cursor, status: row.status, advanceOn: row.advance_on,
    blockedReason: row.blocked_reason, autoMerge: Boolean(row.auto_merge), useEpic: Boolean(row.use_epic), parallel: Boolean(row.parallel), ready: Boolean(row.ready),
    headSelection: row.head_selection ? JSON.parse(row.head_selection) : null,
    owesEpicFinalization: Boolean(row.owes_epic_finalization),
    headStartedAt: row.head_started_at, createdAt: row.created_at, updatedAt: row.updated_at,
    finalizedAt: row.finalized_at, finalizationStartedAt: row.finalization_started_at,
  };
}

export async function getEpicExecutionQueue(draftId: string, { database = db }: EpicQueueDependencies = {}): Promise<EpicExecutionQueue | null> {
  const row = await database('epic_execution_queues').where({ draft_id: draftId }).first<QueueRow>();
  return row ? fromRow(row) : null;
}

export function summarizeEpicQueue(queue: EpicExecutionQueue | null) {
  if (!queue) return null;
  return { issues: queue.issues, cursor: queue.cursor, head: queue.parallel ? null : queue.issues[queue.cursor] ?? null,
    status: queue.status, advanceOn: queue.advanceOn, blockedReason: queue.blockedReason,
    ...(queue.parallel ? { executionMode: 'parallel' as const } : {}) };
}

/** The insert/update is atomic even when called inside the MCP claim transaction. */
export async function createEpicExecutionQueue(input: {
  draftId: string; repository: string; issues: number[]; advanceOn?: EpicAdvancePolicy;
  headSelection?: { agent_alias: string; model_name: string };
  autoMerge?: boolean; useEpic?: boolean; parallel?: boolean; ready?: boolean; headStartedAt?: number;
}, { database = db, now = Date.now }: EpicQueueDependencies = {}): Promise<EpicExecutionQueue> {
  if (!input.issues.length || new Set(input.issues).size !== input.issues.length) {
    throw new Error('An epic queue requires distinct selected issues.');
  }
  const timestamp = now();
  const row = {
    draft_id: input.draftId, execution_id: randomUUID(), repository: input.repository, issues: JSON.stringify(input.issues),
    head_selection: input.headSelection ? JSON.stringify(input.headSelection) : null,
    owes_epic_finalization: input.useEpic ?? true,
    cursor: 0, status: 'active', advance_on: input.advanceOn ?? 'merged', blocked_reason: input.ready === false ? 'Preparing queued issue model and epic branch labels.' : null,
    auto_merge: input.autoMerge ?? false, use_epic: input.useEpic ?? true, parallel: input.parallel ?? false, ready: input.ready ?? true,
    head_started_at: input.headStartedAt ?? null, finalized_at: null, finalization_started_at: null, created_at: timestamp, updated_at: timestamp,
  };
  const inserted = await database('epic_execution_queues').insert(row).onConflict('draft_id').ignore().returning('draft_id');
  if (!inserted.length) {
    const replaced = await database('epic_execution_queues').where({ draft_id: input.draftId })
      .whereIn('status', ['completed', 'cancelled']).update({ ...row,
        // Transfer the unresolved obligation atomically with revoking the old execution.
        owes_epic_finalization: database.raw('CASE WHEN owes_epic_finalization = ? AND finalized_at IS NULL THEN ? ELSE ? END',
          [true, true, row.owes_epic_finalization]),
      });
    if (!replaced) throw new Error('An active epic execution queue already exists for this plan.');
  }
  return (await getEpicExecutionQueue(input.draftId, { database }))!;
}

export function decideEpicAdvance(policy: EpicAdvancePolicy, status: PlanIssueStatus): 'advance' | 'wait' | 'ignore' {
  if (!isTerminalStatus(status)) return 'ignore';
  return policy === 'terminal' || status === PlanIssueStatus.MERGED ? 'advance' : 'wait';
}

/** Marks initial selector synchronization complete before progression is allowed. */
export async function readyEpicExecutionQueue(draftId: string, executionId?: string): Promise<void> {
  const owned = db('epic_execution_queues').where({ draft_id: draftId, status: 'active' });
  if (executionId) owned.where({ execution_id: executionId });
  await owned.update({ ready: true, blocked_reason: null, updated_at: Date.now() });
  await startEpicQueueHead(draftId);
}

export async function cancelEpicExecutionQueue(draftId: string, executionId?: string): Promise<void> {
  const query = db('epic_execution_queues').where({ draft_id: draftId, status: 'active' });
  if (executionId) query.where({ execution_id: executionId });
  await query.update({ status: 'cancelled', updated_at: Date.now() });
}

/** Fresh external evidence plus a guarded pending status prove that setup never dispatched. */
export const UNSTARTED_EPIC_REASON = 'Initial queue head never started; implementation may be requested again.';
export async function cancelUnstartedEpicExecutionQueue(queue: EpicExecutionQueue,
  { database = db, now = Date.now }: EpicQueueDependencies = {}): Promise<boolean> {
  if (queue.parallel || queue.ready || queue.cursor !== 0 || queue.status !== 'active') return false;
  const issueNumber = queue.issues[0];
  const issue = await database('plan_issues').where({ draft_id: queue.draftId, issue_number: issueNumber }).first('status');
  if (issue?.status !== PlanIssueStatus.PENDING) return false;
  const { getPrimaryProcessingLabels } = await import('../../daemon/configLoader.js');
  const configuredLabels = getPrimaryProcessingLabels();
  const processingLabels = configuredLabels.length ? configuredLabels : ['AI'];
  const octokit = await getAuthenticatedOctokit();
  const [owner, repo] = queue.repository.split('/');
  const response = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', { owner, repo, issue_number: issueNumber });
  const labels = response.data.labels.map(label => typeof label === 'string' ? label : label.name);
  if (processingLabels.some(label => labels.includes(label))) return false;
  // Recheck persisted evidence and execution authority after the GitHub await.
  return Boolean(await database('epic_execution_queues')
    .where({ draft_id: queue.draftId, execution_id: queue.executionId, status: 'active', ready: false, cursor: 0 })
    .whereExists(database('plan_issues').select('id').where({ draft_id: queue.draftId, issue_number: issueNumber, status: 'pending' }))
    .update({ status: 'cancelled', blocked_reason: UNSTARTED_EPIC_REASON, updated_at: now() }));
}

/** Only a matching head may move the cursor. Other observers reload the winning state. */
export async function advanceEpicQueue({ draftId, issueNumber, status }: {
  draftId: string; issueNumber: number; status: PlanIssueStatus;
}, deps: EpicQueueDependencies = {}): Promise<void> {
  const database = deps.database ?? db;
  const queue = await getEpicExecutionQueue(draftId, deps);
  if (queue?.parallel) return queue.issues.includes(issueNumber) ? completeParallelEpicQueue(queue, deps) : undefined;
  if (!queue || queue.status !== 'active' || !queue.ready || queue.issues[queue.cursor] !== issueNumber) return;
  // Use persisted evidence: a delayed closed event must not block a now-merged head.
  const issue = await database('plan_issues').where({ draft_id: draftId, issue_number: issueNumber }).first('status');
  const decision = decideEpicAdvance(queue.advanceOn, issue?.status ?? status);
  if (decision === 'ignore') return;
  const timestamp = (deps.now ?? Date.now)();
  if (decision === 'wait') {
    await database('epic_execution_queues').where({ draft_id: draftId, execution_id: queue.executionId, status: 'active', cursor: queue.cursor })
      .update({ blocked_reason: `Issue #${issueNumber} is ${issue?.status ?? status}; this epic advances only after it is merged. Reopen, fix and merge it to continue.`, updated_at: timestamp });
    return;
  }
  const cursor = queue.cursor + 1;
  const changed = await database('epic_execution_queues')
    .where({ draft_id: draftId, execution_id: queue.executionId, status: 'active', cursor: queue.cursor })
    .update({ cursor, head_started_at: null, blocked_reason: null,
      status: cursor === queue.issues.length ? 'completed' : 'active', updated_at: timestamp });
  if (!changed) return;
  if (cursor === queue.issues.length) await finalizeCompletedEpicQueue(draftId, deps, queue.executionId);
  else await startEpicQueueHead(draftId, deps);
}

/** Parallel children finish in any order; the last persisted terminal child completes the execution. */
async function completeParallelEpicQueue(queue: EpicExecutionQueue, deps: EpicQueueDependencies): Promise<void> {
  const database = deps.database ?? db;
  if (queue.status !== 'active') return;
  const children = await database('plan_issues').where({ draft_id: queue.draftId }).whereIn('issue_number', queue.issues).select('status');
  if (children.length !== queue.issues.length || !children.every(child => isTerminalStatus(child.status))) return;
  const changed = await database('epic_execution_queues').where({ draft_id: queue.draftId, execution_id: queue.executionId, status: 'active' })
    .update({ cursor: queue.issues.length, blocked_reason: null, status: 'completed', updated_at: (deps.now ?? Date.now)() });
  if (changed) await finalizeCompletedEpicQueue(queue.draftId, deps, queue.executionId);
}

/** Finalization is owed until labeling succeeds or there is no epic PR to label. */
export async function finalizeCompletedEpicQueue(draftId: string, deps: EpicQueueDependencies = {}, executionId?: string): Promise<void> {
  const database = deps.database ?? db;
  const queue = await getEpicExecutionQueue(draftId, deps);
  if (!queue || queue.status !== 'completed' || queue.finalizedAt !== null
    || (executionId !== undefined && executionId !== queue.executionId)) return;
  const timestamp = (deps.now ?? Date.now)();
  if (queue.finalizationStartedAt !== null && timestamp - queue.finalizationStartedAt < RETRY_PENDING_AFTER_MS) return;
  const ownership = { draft_id: draftId, execution_id: queue.executionId, status: 'completed' };
  const claim = database('epic_execution_queues').where(ownership).whereNull('finalized_at');
  if (queue.finalizationStartedAt === null) claim.whereNull('finalization_started_at');
  else claim.where({ finalization_started_at: queue.finalizationStartedAt });
  if (!await claim.update({ finalization_started_at: timestamp, updated_at: timestamp })) return;
  const owned = () => database('epic_execution_queues').where(ownership)
    .whereNull('finalized_at').where({ finalization_started_at: timestamp });
  const unfinishedStatuses = Object.values(PlanIssueStatus).filter(status =>
    status === PlanIssueStatus.PENDING || isInProgressStatus(status));
  const canFinalize = async () => Boolean(await owned()
    .whereExists(database('task_drafts').select('draft_id').where({ draft_id: draftId, paused: false }))
    .whereNotExists(database('plan_issues').select('id').where({ draft_id: draftId }).whereIn('status', unfinishedStatuses))
    .first('draft_id'));
  // Recheck authority and eligibility together after awaited GitHub reads, before labeling.
  // A crash between GitHub accepting the label and persisting success can still require a retry.
  const finalize = deps.finalize ?? ((id, guard) => finalizeEpicPlanIfComplete(id, guard,
    () => recoverOwedEpicLabel(queue, database)));
  try {
    // Branch selection is independent of an explicitly inherited finalization obligation.
    const finalized = queue.owesEpicFinalization ? await finalize(draftId, canFinalize) : true;
    await owned().update({ finalized_at: finalized ? (deps.now ?? Date.now)() : null,
      finalization_started_at: null, updated_at: (deps.now ?? Date.now)() });
  } catch (error) {
    await owned().update({ finalization_started_at: null });
    throw error;
  }
}

/**
 * Dispatch can create the epic and label its children even though saving the selector failed.
 * Save an externally verified selector only while the given execution still holds the obligation.
 */
async function persistRecoveredEpicLabel(database: Knex, queue: EpicExecutionQueue, epicLabel: string,
  authority: { status: EpicQueueStatus; ready?: boolean }): Promise<boolean> {
  return database.transaction(async trx => {
    const draft = await trx('task_drafts').where({ draft_id: queue.draftId }).forUpdate().first('context_config');
    if (!draft) return false;
    const parsed = typeof draft.context_config === 'string' ? JSON.parse(draft.context_config || '{}') : draft.context_config;
    const context = parsed && typeof parsed === 'object' ? parsed : {};
    // A selector saved concurrently wins; a different branch must not be finalized as this one.
    if (typeof context.epicLabel === 'string') return context.epicLabel === epicLabel;
    return Boolean(await trx('task_drafts').where({ draft_id: queue.draftId })
      .whereExists(trx('epic_execution_queues').select('draft_id')
        .where({ draft_id: queue.draftId, execution_id: queue.executionId, ...authority }).whereNull('finalized_at'))
      .update({ context_config: JSON.stringify({ ...context, epicLabel }), updated_at: trx.fn.now() }));
  });
}

/**
 * A missing saved selector does not prove that no epic PR exists. Recover the branch from the
 * labels this execution's children carry; without one unambiguous selector, finalization stays owed.
 */
async function recoverOwedEpicLabel(queue: EpicExecutionQueue, database: Knex): Promise<string | undefined> {
  const log = logger.withCorrelation(`epic-complete-${queue.draftId}`);
  // Children of a non-epic execution never carried the inherited epic's selector.
  if (!queue.useEpic) {
    log.warn({ draftId: queue.draftId }, 'Epic branch selector is missing; finalization remains owed');
    return undefined;
  }
  const [owner, repo] = queue.repository.split('/');
  const octokit = await getAuthenticatedOctokit();
  const found = new Set<string>();
  for (const issueNumber of queue.issues) {
    const issue = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', { owner, repo, issue_number: issueNumber });
    for (const label of issue.data.labels) {
      const name = typeof label === 'string' ? label : label.name;
      if (name?.startsWith('base-')) found.add(name);
    }
  }
  const [epicLabel] = found;
  if (found.size !== 1 || !await persistRecoveredEpicLabel(database, queue, epicLabel, { status: 'completed' })) {
    log.warn({ draftId: queue.draftId, candidates: [...found] }, 'Epic branch selector could not be recovered; finalization remains owed');
    return undefined;
  }
  log.info({ draftId: queue.draftId, epicLabel }, 'Recovered epic branch selector from issue labels');
  return epicLabel;
}

/** Claims the label side effect durably; a lost dispatch is retried after 15 minutes. */
export async function startEpicQueueHead(draftId: string, deps: EpicQueueDependencies = {}): Promise<void> {
  const database = deps.database ?? db;
  const queue = await getEpicExecutionQueue(draftId, deps);
  if (!queue || queue.status !== 'active' || !queue.ready) return;
  if (queue.parallel) return completeParallelEpicQueue(queue, deps);
  const issueNumber = queue.issues[queue.cursor];
  const issue = await database('plan_issues').where({ draft_id: draftId, issue_number: issueNumber }).first('status');
  if (!issue) {
    await database('epic_execution_queues').where({ draft_id: draftId, execution_id: queue.executionId, status: 'active', cursor: queue.cursor })
      .update({ blocked_reason: `Selected issue #${issueNumber} is missing from this plan.`, updated_at: (deps.now ?? Date.now)() });
    return;
  }
  if (isTerminalStatus(issue.status)) {
    await advanceEpicQueue({ draftId, issueNumber, status: issue.status }, deps);
    return;
  }
  const draft = await database('task_drafts').where({ draft_id: draftId }).first('paused', 'context_config');
  if (!draft || draft.paused) return;
  // Clear the explanation if a blocked issue has been reopened.
  if (queue.blockedReason && issue.status !== PlanIssueStatus.PENDING) {
    await database('epic_execution_queues').where({ draft_id: draftId, execution_id: queue.executionId, status: 'active', cursor: queue.cursor })
      .update({ blocked_reason: null });
  }
  if (issue.status !== PlanIssueStatus.PENDING) return;
  await dispatchPendingQueueHead(queue, draft.context_config, deps);
}

async function dispatchPendingQueueHead(queue: EpicExecutionQueue, contextConfig: unknown, deps: EpicQueueDependencies): Promise<void> {
  const database = deps.database ?? db;
  const draftId = queue.draftId;
  const issueNumber = queue.issues[queue.cursor];
  const timestamp = (deps.now ?? Date.now)();
  if (queue.headStartedAt !== null && timestamp - queue.headStartedAt < RETRY_PENDING_AFTER_MS) return;
  const claim = database('epic_execution_queues').where({ draft_id: draftId, execution_id: queue.executionId, status: 'active', cursor: queue.cursor, ready: true });
  if (queue.headStartedAt === null) claim.whereNull('head_started_at');
  else claim.where({ head_started_at: queue.headStartedAt });
  // Recheck pause and issue state in the same statement as the dispatch claim.
  claim.whereExists(database('task_drafts').select('draft_id').where({ draft_id: draftId, paused: false }));
  claim.whereExists(database('plan_issues').select('id').where({ draft_id: draftId, issue_number: issueNumber, status: 'pending' }));
  const changed = await claim.update({ head_started_at: timestamp, blocked_reason: null, updated_at: timestamp });
  if (!changed) return;
  const context = typeof contextConfig === 'string' ? JSON.parse(contextConfig || '{}') : contextConfig;
  try {
    await (deps.startIssue ?? labelPlanIssueForProcessing)({ draftId, repository: queue.repository, issueNumber,
      epicLabel: queue.useEpic && typeof context?.epicLabel === 'string' ? context.epicLabel : undefined, autoMerge: queue.autoMerge });
  } catch (error) {
    // Keep the claim after failure: the external outcome may be uncertain, and recovery retries after fifteen minutes.
    await database('epic_execution_queues').where({ draft_id: draftId, execution_id: queue.executionId, status: 'active', cursor: queue.cursor, head_started_at: timestamp })
      .update({ blocked_reason: `Could not start issue #${issueNumber}: ${(error as Error).message}`, updated_at: timestamp });
    throw error;
  }
}

/** Recover a crash during initial selector configuration without publishing processing labels. */
async function repairQueueSetup(queue: EpicExecutionQueue): Promise<boolean> {
  const [owner, repo] = queue.repository.split('/');
  const octokit = await getAuthenticatedOctokit();
  const head = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
    owner, repo, issue_number: queue.issues[0],
  });
  const selection = queue.headSelection ?? await db('plan_issues').where({ draft_id: queue.draftId, issue_number: queue.issues[0] }).first('agent_alias', 'model_name');
  if (!selection?.agent_alias || !selection?.model_name) return false;
  const labels = head.data.labels.map(label => typeof label === 'string' ? label : label.name);
  const selectors = await verifiedQueueHeadSelectors(queue, selection, labels);
  if (!selectors) return false;
  const restored = await db('plan_issues').where({ draft_id: queue.draftId, issue_number: queue.issues[0] })
    .whereExists(db('epic_execution_queues').select('draft_id').where({ draft_id: queue.draftId,
      execution_id: queue.executionId, status: 'active', ready: false }))
    .update({ agent_alias: selection.agent_alias, model_name: selection.model_name });
  if (!restored) return false;
  // Finalization reads the saved selector; setup is not repaired until the recovered one is durable.
  if (selectors.epicLabel && !await persistRecoveredEpicLabel(db, queue, selectors.epicLabel, { status: 'active', ready: false })) return false;
  for (const issueNumber of queue.issues.slice(1)) {
    if (!await repairQueuedIssueSetup(queue, issueNumber, { selection, ...selectors }, octokit)) return false;
  }
  return true;
}

async function repairQueuedIssueSetup(queue: EpicExecutionQueue, issueNumber: number,
  { selection, epicLabel, modelLabel }: { selection: { agent_alias: string; model_name: string }; epicLabel?: string; modelLabel: string },
  octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>,
): Promise<boolean> {
  const [owner, repo] = queue.repository.split('/');
  const issue = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', { owner, repo, issue_number: issueNumber });
  const existing = issue.data.labels.map(label => typeof label === 'string' ? label : label.name)
    .filter((label): label is string => !!label);
  const configured = await db('plan_issues').where({ draft_id: queue.draftId, issue_number: issueNumber }).first('agent_alias', 'model_name');
  // UI queues retain each issue's selection. MCP persists its shared selection when claiming issues.
  const { resolvePlanIssueDefaultSelection } = await import('../../config/planIssueDefaults.js');
  const issueSelection = configured?.agent_alias && configured?.model_name ? configured : await resolvePlanIssueDefaultSelection(configured);
  if (!issueSelection.agent_alias || !issueSelection.model_name) return false;
  const issueModelLabel = issueSelection.agent_alias === selection.agent_alias && issueSelection.model_name === selection.model_name
    ? modelLabel : await queuedModelLabel(issueSelection);
  if (!issueModelLabel) return false;
  const remove = existing.filter(label => (label.startsWith('base-') && label !== epicLabel)
    || (label.startsWith('llm-') && label !== issueModelLabel) || (!queue.autoMerge && label === 'auto-merge'));
  const { updatePlanIssue } = await import('../../config/planIssueManager.js');
  const current = await getEpicExecutionQueue(queue.draftId);
  if (current?.executionId !== queue.executionId || current.status !== 'active' || current.ready) return false;
  await updatePlanIssue(queue.draftId, issueNumber, issueSelection);
  const result = await safeUpdateLabels({ octokit, owner, repo, issueNumber,
    logger: logger.withCorrelation(`epic-setup-repair-${queue.draftId}`) }, remove,
  [...(epicLabel ? [epicLabel] : []), issueModelLabel, ...(queue.autoMerge ? ['auto-merge'] : [])]);
  if (!result.success) throw new Error(result.errors.join('; '));
  return true;
}

async function verifiedQueueHeadSelectors(queue: EpicExecutionQueue,
  selection: { agent_alias: string; model_name: string }, labels: (string | undefined)[]
): Promise<{ epicLabel?: string; modelLabel: string } | null> {
  const draft = await db('task_drafts').where({ draft_id: queue.draftId }).first('context_config');
  const context = typeof draft?.context_config === 'string' ? JSON.parse(draft.context_config || '{}') : draft?.context_config;
  const epicLabel = queue.useEpic ? (typeof context?.epicLabel === 'string' ? context.epicLabel : labels.find(label => label?.startsWith('base-'))) : undefined;
  const modelLabel = await queuedModelLabel(selection);
  // If dispatch never established selectors, its external outcome is uncertain.
  // Do not silently create an epic or choose a default model during recovery.
  if (!modelLabel || !labels.includes(modelLabel) || (queue.useEpic && (!epicLabel || !labels.includes(epicLabel)))) return null;
  return { epicLabel, modelLabel };
}

async function queuedModelLabel(selection: { agent_alias: string; model_name: string }): Promise<string | null> {
  const { AgentRegistry } = await import('../../agents/AgentRegistry.js');
  const { MODEL_INFO_MAP } = await import('../../config/modelDefinitions.js');
  const { buildAgentModelLlmLabel, buildDynamicLlmLabel } = await import('@propr/shared');
  const { toProprOpenCodeModelId } = await import('../../agents/impl/openCodeUtils.js');
  const registry = AgentRegistry.getInstance();
  await registry.ensureInitialized();
  const modelInfo = MODEL_INFO_MAP[selection.model_name];
  const agent = registry.getAgentByAlias(selection.agent_alias) ?? registry.getAllAgents().find(candidate =>
    candidate.config.supportedModels.some(model => model.toLowerCase() === selection.model_name.toLowerCase()
      || (candidate.config.type === 'opencode' && model.toLowerCase() === toProprOpenCodeModelId(selection.model_name).toLowerCase())));
  if (!agent) return modelInfo?.githubLabel ?? null;
  if (modelInfo?.githubLabel) return buildAgentModelLlmLabel(agent.config.type, agent.config.alias, modelInfo);
  const model = agent.config.type === 'opencode' ? toProprOpenCodeModelId(selection.model_name) : selection.model_name;
  return buildDynamicLlmLabel(agent.config.alias, model);
}

async function reconcileQueueHead(draftId: string, deps: EpicQueueDependencies): Promise<void> {
  const database = deps.database ?? db;
  const head = await getEpicExecutionQueue(draftId, deps);
  if (!head) return;
  // Every parallel child can be running; a sequential queue has only its head in flight.
  const issues = await database('plan_issues').where({ draft_id: head.draftId })
    .whereIn('issue_number', head.parallel ? head.issues : [head.issues[head.cursor]]).select<PlanIssue[]>();
  if (!issues.length) return;
  await reconcileTerminalInProgressIssues(head.repository, issues, logger.withCorrelation(`epic-reconcile-${head.draftId}`));
}

/** Returns true when recovery cancels an execution that never dispatched. */
async function recoverQueueSetup(queue: EpicExecutionQueue, deps: EpicQueueDependencies): Promise<boolean> {
  if (queue.ready || (deps.now ?? Date.now)() - queue.createdAt < RETRY_PENDING_AFTER_MS) return false;
  const repaired = await (deps.repairSetup ?? repairQueueSetup)(queue);
  if (!repaired && await cancelUnstartedEpicExecutionQueue(queue, deps)) return true;
  const database = deps.database ?? db;
  await database('epic_execution_queues').where({ draft_id: queue.draftId, execution_id: queue.executionId, status: 'active', ready: false })
    .update({ ready: repaired, blocked_reason: repaired ? null : 'Initial epic dispatch did not establish model and branch labels; inspect the implementation operation before recovery.', updated_at: (deps.now ?? Date.now)() });
  return false;
}

export async function reconcileEpicExecutionQueues(deps: EpicQueueDependencies = {}): Promise<{ reconciled: number }> {
  const database = deps.database ?? db;
  const queues = await database('epic_execution_queues').where(builder => builder.where('status', 'active')
    .orWhere(pending => pending.where('status', 'completed').whereNull('finalized_at')))
    .orderBy('updated_at').orderBy('draft_id').limit(100).select('draft_id', 'status', 'execution_id');
  let reconciled = 0;
  for (const queue of queues) {
    try {
      if (queue.status === 'completed') await finalizeCompletedEpicQueue(queue.draft_id, deps, queue.execution_id);
      else {
        const current = await getEpicExecutionQueue(queue.draft_id, deps);
        if (current && await recoverQueueSetup(current, deps)) {
          reconciled++;
          continue;
        }
        await reconcileQueueHead(queue.draft_id, deps);
        await startEpicQueueHead(queue.draft_id, deps);
      }
      reconciled++;
    } catch (error) {
      logger.warn({ draftId: queue.draft_id, error: (error as Error).message }, 'Failed to reconcile epic queue');
    } finally {
      // Rotate every attempted execution, including failed setup and finalization.
      // A replacement execution must retain its own recovery priority.
      await database('epic_execution_queues').where({ draft_id: queue.draft_id, execution_id: queue.execution_id })
        .update({ updated_at: (deps.now ?? Date.now)() });
    }
  }
  return { reconciled };
}

/** Status writes must never fail because progression failed; recovery retries it. */
export async function onPlanIssueStatusChanged(draftId: string, issueNumber: number, status: PlanIssueStatus): Promise<void> {
  try { await advanceEpicQueue({ draftId, issueNumber, status }); }
  catch (error) { logger.warn?.({ draftId, issueNumber, status, error: (error as Error).message }, 'Failed to advance epic queue after issue status change'); }
}
