import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import { db } from '../../db/connection.js';
import logger from '../../utils/logger.js';
import { getAuthenticatedOctokit } from '../../auth/githubAuth.js';
import { safeUpdateLabels } from '../../utils/github/labelOperations.js';
import { PlanIssueStatus, type PlanIssue } from '../../config/planIssueManager.js';
import { isTerminalStatus } from '../../webhook/statusMachine.js';
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
  ready: boolean;
  headStartedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

type QueueRow = {
  draft_id: string; execution_id: string; repository: string; issues: string; cursor: number;
  status: EpicQueueStatus; advance_on: EpicAdvancePolicy; blocked_reason: string | null;
  auto_merge: boolean | number; ready: boolean | number; head_started_at: number | null;
  created_at: number; updated_at: number;
};

type StartIssue = (input: Parameters<typeof labelPlanIssueForProcessing>[0]) => Promise<void>;
export interface EpicQueueDependencies {
  database?: Knex;
  startIssue?: StartIssue;
  finalize?: (draftId: string) => Promise<void>;
  now?: () => number;
  repairSetup?: (queue: EpicExecutionQueue) => Promise<boolean>;
}
const RETRY_PENDING_AFTER_MS = 15 * 60 * 1000;

function fromRow(row: QueueRow): EpicExecutionQueue {
  return {
    draftId: row.draft_id, executionId: row.execution_id, repository: row.repository, issues: JSON.parse(row.issues),
    cursor: row.cursor, status: row.status, advanceOn: row.advance_on,
    blockedReason: row.blocked_reason, autoMerge: Boolean(row.auto_merge), ready: Boolean(row.ready),
    headStartedAt: row.head_started_at, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export async function getEpicExecutionQueue(draftId: string, { database = db }: EpicQueueDependencies = {}): Promise<EpicExecutionQueue | null> {
  const row = await database('epic_execution_queues').where({ draft_id: draftId }).first<QueueRow>();
  return row ? fromRow(row) : null;
}

export function summarizeEpicQueue(queue: EpicExecutionQueue | null) {
  if (!queue) return null;
  return { issues: queue.issues, cursor: queue.cursor, head: queue.issues[queue.cursor] ?? null,
    status: queue.status, advanceOn: queue.advanceOn, blockedReason: queue.blockedReason };
}

/** The insert/update is atomic even when called inside the MCP claim transaction. */
export async function createEpicExecutionQueue(input: {
  draftId: string; repository: string; issues: number[]; advanceOn?: EpicAdvancePolicy;
  autoMerge?: boolean; ready?: boolean; headStartedAt?: number;
}, { database = db, now = Date.now }: EpicQueueDependencies = {}): Promise<EpicExecutionQueue> {
  if (!input.issues.length || new Set(input.issues).size !== input.issues.length) {
    throw new Error('An epic queue requires distinct selected issues.');
  }
  const timestamp = now();
  const row = {
    draft_id: input.draftId, execution_id: randomUUID(), repository: input.repository, issues: JSON.stringify(input.issues),
    cursor: 0, status: 'active', advance_on: input.advanceOn ?? 'merged', blocked_reason: input.ready === false ? 'Preparing queued issue model and epic branch labels.' : null,
    auto_merge: input.autoMerge ?? false, ready: input.ready ?? true,
    head_started_at: input.headStartedAt ?? null, created_at: timestamp, updated_at: timestamp,
  };
  const inserted = await database('epic_execution_queues').insert(row).onConflict('draft_id').ignore().returning('draft_id');
  if (!inserted.length) {
    const replaced = await database('epic_execution_queues').where({ draft_id: input.draftId })
      .whereIn('status', ['completed', 'cancelled']).update(row);
    if (!replaced) throw new Error('An active epic execution queue already exists for this plan.');
  }
  return (await getEpicExecutionQueue(input.draftId, { database }))!;
}

export function decideEpicAdvance(policy: EpicAdvancePolicy, status: PlanIssueStatus): 'advance' | 'wait' | 'ignore' {
  if (!isTerminalStatus(status)) return 'ignore';
  return policy === 'terminal' || status === PlanIssueStatus.MERGED ? 'advance' : 'wait';
}

/** Marks initial MCP selector synchronization complete before progression is allowed. */
export async function readyEpicExecutionQueue(draftId: string): Promise<void> {
  await db('epic_execution_queues').where({ draft_id: draftId, status: 'active' })
    .update({ ready: true, blocked_reason: null, updated_at: Date.now() });
  await startEpicQueueHead(draftId);
}

export async function cancelEpicExecutionQueue(draftId: string): Promise<void> {
  await db('epic_execution_queues').where({ draft_id: draftId, status: 'active' })
    .update({ status: 'cancelled', updated_at: Date.now() });
}

/** Only a matching head may move the cursor. Other observers reload the winning state. */
export async function advanceEpicQueue({ draftId, issueNumber, status }: {
  draftId: string; issueNumber: number; status: PlanIssueStatus;
}, deps: EpicQueueDependencies = {}): Promise<void> {
  const database = deps.database ?? db;
  const queue = await getEpicExecutionQueue(draftId, deps);
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
  if (cursor === queue.issues.length) await (deps.finalize ?? finalizeEpicPlanIfComplete)(draftId);
  else await startEpicQueueHead(draftId, deps);
}

/** Claims the label side effect durably; a lost dispatch is retried after 15 minutes. */
export async function startEpicQueueHead(draftId: string, deps: EpicQueueDependencies = {}): Promise<void> {
  const database = deps.database ?? db;
  const queue = await getEpicExecutionQueue(draftId, deps);
  if (!queue || queue.status !== 'active' || !queue.ready) return;
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
  const context = typeof draft.context_config === 'string' ? JSON.parse(draft.context_config || '{}') : draft.context_config;
  try {
    await (deps.startIssue ?? labelPlanIssueForProcessing)({ draftId, repository: queue.repository, issueNumber,
      epicLabel: typeof context?.epicLabel === 'string' ? context.epicLabel : undefined, autoMerge: queue.autoMerge });
  } catch (error) {
    // Keep the claim after failure: the external outcome may be uncertain, and recovery retries after fifteen minutes.
    await database('epic_execution_queues').where({ draft_id: draftId, execution_id: queue.executionId, status: 'active', cursor: queue.cursor, head_started_at: timestamp })
      .update({ blocked_reason: `Could not start issue #${issueNumber}: ${(error as Error).message}`, updated_at: timestamp });
    throw error;
  }
}

/** Recover a crash during initial MCP configuration without publishing processing labels. */
async function repairQueueSetup(queue: EpicExecutionQueue): Promise<boolean> {
  const [owner, repo] = queue.repository.split('/');
  const octokit = await getAuthenticatedOctokit();
  const head = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
    owner, repo, issue_number: queue.issues[0],
  });
  const selection = await db('plan_issues').where({ draft_id: queue.draftId, issue_number: queue.issues[0] }).first('agent_alias', 'model_name');
  if (!selection?.agent_alias || !selection?.model_name) return false;
  const labels = head.data.labels.map(label => typeof label === 'string' ? label : label.name);
  const epicLabel = labels.find(label => label?.startsWith('base-'));
  const modelLabel = labels.find(label => label?.startsWith('llm-'));
  // If dispatch never established selectors, its external outcome is uncertain.
  // Do not silently create an epic or choose a default model during recovery.
  if (!epicLabel || !modelLabel) return false;
  for (const issueNumber of queue.issues.slice(1)) {
    const issue = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', { owner, repo, issue_number: issueNumber });
    const existing = issue.data.labels.map(label => typeof label === 'string' ? label : label.name)
      .filter((label): label is string => !!label);
    const remove = existing.filter(label => (label.startsWith('base-') && label !== epicLabel)
      || (label.startsWith('llm-') && label !== modelLabel) || (!queue.autoMerge && label === 'auto-merge'));
    const result = await safeUpdateLabels({ octokit, owner, repo, issueNumber,
      logger: logger.withCorrelation(`epic-setup-repair-${queue.draftId}`) }, remove,
    [epicLabel, modelLabel, ...(queue.autoMerge ? ['auto-merge'] : [])]);
    if (!result.success) throw new Error(result.errors.join('; '));
    const { updatePlanIssue } = await import('../../config/planIssueManager.js');
    await updatePlanIssue(queue.draftId, issueNumber, { agent_alias: selection.agent_alias, model_name: selection.model_name });
  }
  return true;
}

/** Queue-only recovery preserves the legacy status machine's terminal-state guard. */
async function reconcileReopenedQueueHead(queue: EpicExecutionQueue, issue: PlanIssue): Promise<void> {
  if (queue.advanceOn !== 'merged' || issue.status !== PlanIssueStatus.CLOSED || !issue.pr_number) return;
  const [owner, repo] = queue.repository.split('/');
  const octokit = await getAuthenticatedOctokit();
  const response = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', { owner, repo, pull_number: issue.pr_number });
  const status = response.data.merged || response.data.merged_at ? PlanIssueStatus.MERGED
    : response.data.state === 'open' ? PlanIssueStatus.UNDER_REVIEW : null;
  if (status) {
    const { updatePlanIssue } = await import('../../config/planIssueManager.js');
    await updatePlanIssue(queue.draftId, issue.issue_number, { status });
  }
}

export async function reconcileEpicExecutionQueues(deps: EpicQueueDependencies = {}): Promise<{ reconciled: number }> {
  const database = deps.database ?? db;
  const queues = await database('epic_execution_queues').whereIn('status', ['active', 'completed'])
    .orderBy('updated_at').orderBy('draft_id').limit(100).select('draft_id', 'status', 'execution_id');
  let reconciled = 0;
  for (const queue of queues) {
    try {
      if (queue.status === 'completed') await (deps.finalize ?? finalizeEpicPlanIfComplete)(queue.draft_id);
      else {
        const current = await getEpicExecutionQueue(queue.draft_id, deps);
        if (current && !current.ready && (deps.now ?? Date.now)() - current.createdAt >= RETRY_PENDING_AFTER_MS) {
          const repaired = await (deps.repairSetup ?? repairQueueSetup)(current);
          await database('epic_execution_queues').where({ draft_id: queue.draft_id, execution_id: current.executionId, status: 'active', ready: false })
            .update({ ready: repaired, blocked_reason: repaired ? null : 'Initial epic dispatch did not establish model and branch labels; inspect the implementation operation before recovery.', updated_at: (deps.now ?? Date.now)() });
        }
        const head = await getEpicExecutionQueue(queue.draft_id, deps);
        if (head) {
          const issue = await database('plan_issues').where({ draft_id: head.draftId, issue_number: head.issues[head.cursor] }).first<PlanIssue>();
          if (issue) {
            await reconcileTerminalInProgressIssues(head.repository, [issue], logger.withCorrelation(`epic-reconcile-${head.draftId}`));
            await reconcileReopenedQueueHead(head, issue);
          }
        }
        await startEpicQueueHead(queue.draft_id, deps);
      }
      await database('epic_execution_queues').where({ draft_id: queue.draft_id, execution_id: queue.execution_id })
        .update({ updated_at: (deps.now ?? Date.now)() });
      reconciled++;
    } catch (error) {
      logger.warn({ draftId: queue.draft_id, error: (error as Error).message }, 'Failed to reconcile epic queue');
    }
  }
  return { reconciled };
}

/** Status writes must never fail because progression failed; recovery retries it. */
export async function onPlanIssueStatusChanged(draftId: string, issueNumber: number, status: PlanIssueStatus): Promise<void> {
  try { await advanceEpicQueue({ draftId, issueNumber, status }); }
  catch (error) { logger.warn?.({ draftId, issueNumber, status, error: (error as Error).message }, 'Failed to advance epic queue after issue status change'); }
}
