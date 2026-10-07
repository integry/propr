import * as core from '@propr/core';
import { getLlmLabel } from './planIssueHelpers.js';
import { persistEffectiveUltrafixSettings } from './planIssueConfigSync.js';

export class EpicQueueRequestError extends Error {
  readonly status = 409;
}

/** UI/API epic requests claim the remaining published issues before dispatching the head. */
export async function enqueueEpicImplementation(params: {
  draftId: string;
  issueNumber: number;
  repository: string;
  autoMerge: boolean;
  contextConfig: Record<string, unknown> | null;
  headSelection?: { agent_alias: string; model_name: string };
  implement: () => Promise<unknown>;
}): Promise<unknown> {
  const {
    createEpicExecutionQueue,
    db,
    getEpicExecutionQueue,
    getPlanIssuesByDraft,
    isInProgressStatus,
    PlanIssueStatus,
    readyEpicExecutionQueue,
  } = core;
  const { draftId, issueNumber, repository, autoMerge } = params;
  const existing = await getEpicExecutionQueue(draftId);
  if (existing?.status === 'active') throw new EpicQueueRequestError('An active epic execution queue already exists for this plan.');
  const issues = await getPlanIssuesByDraft(draftId);
  if (issues.some(issue => isInProgressStatus(issue.status))) {
    throw new EpicQueueRequestError('Wait for the running plan issues to finish before implementing the remaining epic.');
  }
  const pending = issues.filter(issue => issue.status === PlanIssueStatus.PENDING).sort((left, right) => left.id - right.id);
  if (pending[0]?.issue_number !== issueNumber) {
    throw new EpicQueueRequestError('Implement the first pending issue to start the epic.');
  }
  let queue: core.EpicExecutionQueue;
  try {
    // Like the retired UI chain, a closed or failed issue does not hold the remaining epic.
    queue = await createEpicExecutionQueue({ draftId, repository, issues: pending.map(issue => issue.issue_number),
      advanceOn: 'terminal', autoMerge, headSelection: params.headSelection, ready: false, headStartedAt: Date.now() });
  } catch (error) {
    if ((error as Error).message.includes('active epic execution queue')) throw new EpicQueueRequestError((error as Error).message);
    throw error;
  }
  // A rejected implementation can already have published labels or queued work.
  // Keep recovery and finalization owed when the external outcome is uncertain.
  let result: unknown;
  try { result = await params.implement(); }
  catch (error) {
    await core.cancelUnstartedEpicExecutionQueue(queue).catch(() => false);
    throw error;
  }
  // The head establishes the epic branch. Configure successors without starting them,
  // preserving each issue's selected model and effective ultrafix settings.
  const draft = await db('task_drafts').where({ draft_id: draftId }).first('context_config');
  const context = typeof draft.context_config === 'string' ? JSON.parse(draft.context_config) : draft.context_config;
  if (typeof context?.epicLabel !== 'string') throw new Error('Epic branch selector is missing for queued issues');
  await configureQueuedSuccessors({ draftId, executionId: queue.executionId, repository, issues: pending.slice(1), epicLabel: context.epicLabel,
    autoMerge, contextConfig: params.contextConfig });
  await readyEpicExecutionQueue(draftId, queue.executionId);
  return result;
}

/**
 * Non-epic auto-merge requests queue the remaining pending issues behind the requested one,
 * so each merge (or failed task) starts the next issue as the retired UI chain did.
 */
export async function enqueueAutoMergeImplementation(params: {
  draftId: string;
  issueNumber: number;
  repository: string;
  contextConfig: Record<string, unknown> | null;
  headSelection?: { agent_alias: string; model_name: string };
  implement: () => Promise<unknown>;
}): Promise<unknown> {
  const { createEpicExecutionQueue, getEpicExecutionQueue, getPlanIssuesByDraft, PlanIssueStatus } = core;
  const { draftId, issueNumber, repository } = params;
  // An active queue already owns progression and skips issues started out of band.
  if ((await getEpicExecutionQueue(draftId))?.status === 'active') return params.implement();
  const issues = await getPlanIssuesByDraft(draftId);
  const head = issues.find(issue => issue.issue_number === issueNumber);
  const successors = issues.filter(issue => issue.status === PlanIssueStatus.PENDING && issue.issue_number !== issueNumber)
    .sort((left, right) => left.id - right.id);
  if (head?.status !== PlanIssueStatus.PENDING || !successors.length) return params.implement();
  let queue: core.EpicExecutionQueue;
  try {
    queue = await createEpicExecutionQueue({ draftId, repository, issues: [issueNumber, ...successors.map(issue => issue.issue_number)],
      advanceOn: 'terminal', autoMerge: true, useEpic: false, headSelection: params.headSelection, ready: false, headStartedAt: Date.now() });
  } catch (error) {
    if (!(error as Error).message.includes('active epic execution queue')) throw error;
    return params.implement();
  }
  let result: unknown;
  try { result = await params.implement(); }
  catch (error) {
    await core.cancelUnstartedEpicExecutionQueue(queue).catch(() => false);
    throw error;
  }
  await configureQueuedSuccessors({ draftId, executionId: queue.executionId, repository, issues: successors, autoMerge: true, contextConfig: params.contextConfig });
  await core.readyEpicExecutionQueue(draftId, queue.executionId);
  return result;
}

/** Persist each successor's model and ultrafix settings, then sync selectors without a processing label. */
async function configureQueuedSuccessors(params: {
  draftId: string; executionId: string; repository: string; issues: core.PlanIssue[]; epicLabel?: string; autoMerge: boolean;
  contextConfig: Record<string, unknown> | null;
}): Promise<void> {
  const { draftId, repository, epicLabel, autoMerge } = params;
  const octokit = await core.getAuthenticatedOctokit();
  const canConfigure = async () => {
    const current = await core.getEpicExecutionQueue(draftId);
    return current?.executionId === params.executionId && current.status === 'active' && !current.ready;
  };
  if (!await canConfigure()) throw new Error('Queue setup ownership was lost');
  const successors = await persistEffectiveUltrafixSettings({ draftId, issues: params.issues, contextConfig: params.contextConfig });
  for (const issue of successors) {
    const selection = issue.agent_alias && issue.model_name ? issue : await core.resolvePlanIssueDefaultSelection(issue);
    if (!await canConfigure()) throw new Error('Queue setup ownership was lost');
    await core.updatePlanIssue(draftId, issue.issue_number, { agent_alias: selection.agent_alias, model_name: selection.model_name });
    await syncQueuedEpicIssueSelectors({ draftId, repository, issueNumber: issue.issue_number,
      epicLabel, autoMerge, selection, octokit, canConfigure });
  }
}

/** Synchronize selectors without publishing the processing label. */
export async function syncQueuedEpicIssueSelectors(params: {
  draftId: string; repository: string; issueNumber: number; epicLabel?: string; autoMerge: boolean;
  selection: { agent_alias: string | null; model_name: string | null };
  canConfigure?: () => Promise<boolean>;
  octokit?: Awaited<ReturnType<typeof core.getAuthenticatedOctokit>>;
}): Promise<void> {
  const { draftId, repository, issueNumber, epicLabel, autoMerge, selection } = params;
  const octokit = params.octokit ?? await core.getAuthenticatedOctokit();
  const [owner, repo] = repository.split('/');
  const modelLabel = await getLlmLabel(selection.model_name, selection.agent_alias);
  if (!modelLabel) throw new Error(`Model selector is missing for queued issue #${issueNumber}`);
  const githubIssue = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', { owner, repo, issue_number: issueNumber });
  const labels = githubIssue.data.labels.map(label => typeof label === 'string' ? label : label.name);
  const stale = labels.filter((label): label is string => !!label && (
    (label.startsWith('base-') && label !== epicLabel)
    || (label.startsWith('llm-') && label !== modelLabel) || (!autoMerge && label === 'auto-merge')));
  if (params.canConfigure && !await params.canConfigure()) throw new Error('Queue setup ownership was lost');
  const synced = await core.safeUpdateLabels({ octokit, owner, repo, issueNumber,
    logger: core.logger.withCorrelation(`epic-setup-${draftId}`) }, stale,
  [...(epicLabel ? [epicLabel] : []), modelLabel, ...(autoMerge ? ['auto-merge'] : [])]);
  if (!synced.success) throw new Error(`Failed to configure queued issue #${issueNumber}: ${synced.errors.join('; ')}`);
}

/**
 * Queues every pending issue behind the issues already in flight, without starting anything now.
 * The running issues head the queue, so each pending issue starts when the one before it finishes.
 * An active queue that does not yet own every pending issue is extended in place.
 */
export async function enqueueRemainingBehindRunning(params: {
  draftId: string;
  repository: string;
  useEpic: boolean;
  autoMerge: boolean;
  contextConfig: Record<string, unknown> | null;
}): Promise<{ queued: number[]; alreadyQueued: boolean }> {
  const { createEpicExecutionQueue, getEpicExecutionQueue, getPlanIssuesByDraft, isInProgressStatus, PlanIssueStatus } = core;
  const { draftId, repository, useEpic, autoMerge, contextConfig } = params;
  if (!useEpic && !autoMerge) {
    throw new EpicQueueRequestError('Individual tasks only chain automatically when auto-merge is enabled.');
  }
  // Successors of an epic must target the branch the running head established.
  const epicLabel = typeof contextConfig?.epicLabel === 'string' ? contextConfig.epicLabel : undefined;
  if (useEpic && !epicLabel) {
    throw new EpicQueueRequestError('The running issues are not part of an epic yet; wait for them to finish before queueing the epic.');
  }
  const issues = await getPlanIssuesByDraft(draftId);
  const byId = (left: core.PlanIssue, right: core.PlanIssue) => left.id - right.id;
  const pending = issues.filter(issue => issue.status === PlanIssueStatus.PENDING).sort(byId);
  if (!pending.length) throw new EpicQueueRequestError('There are no pending issues to queue.');

  const existing = await getEpicExecutionQueue(draftId);
  if (existing?.status === 'active') {
    if (existing.parallel || !existing.ready) throw new EpicQueueRequestError('An execution is already being set up for this plan.');
    const owned = new Set(existing.issues.slice(existing.cursor));
    const missing = pending.filter(issue => !owned.has(issue.issue_number));
    if (!missing.length) return { queued: pending.map(issue => issue.issue_number), alreadyQueued: true };
    await appendToActiveQueue({ queue: existing, issues: missing, epicLabel: existing.useEpic ? epicLabel : undefined, contextConfig });
    return { queued: pending.map(issue => issue.issue_number), alreadyQueued: false };
  }

  const running = issues.filter(issue => isInProgressStatus(issue.status)).sort(byId);
  if (!running.length) throw new EpicQueueRequestError('Nothing is running; implement the first pending issue to start the queue.');
  let queue: core.EpicExecutionQueue;
  try {
    // The in-flight head is never dispatched by the queue: it advances when that issue finishes.
    queue = await createEpicExecutionQueue({ draftId, repository, issues: [...running, ...pending].map(issue => issue.issue_number),
      advanceOn: 'terminal', autoMerge, useEpic, ready: false });
  } catch (error) {
    if ((error as Error).message.includes('active epic execution queue')) throw new EpicQueueRequestError((error as Error).message);
    throw error;
  }
  try {
    await configureQueuedSuccessors({ draftId, executionId: queue.executionId, repository, issues: pending, epicLabel: useEpic ? epicLabel : undefined,
      autoMerge, contextConfig });
  } catch (error) {
    // Nothing was dispatched, so a failed setup can be withdrawn and requested again.
    await core.cancelEpicExecutionQueue(draftId, queue.executionId);
    throw error;
  }
  // Starts nothing while the head runs; a head that finished meanwhile advances to the first pending issue.
  await core.readyEpicExecutionQueue(draftId, queue.executionId);
  return { queued: pending.map(issue => issue.issue_number), alreadyQueued: false };
}

async function appendToActiveQueue(params: {
  queue: core.EpicExecutionQueue; issues: core.PlanIssue[]; epicLabel?: string; contextConfig: Record<string, unknown> | null;
}): Promise<void> {
  const { queue, epicLabel } = params;
  const octokit = await core.getAuthenticatedOctokit();
  const owned = async () => {
    const current = await core.getEpicExecutionQueue(queue.draftId);
    return current?.executionId === queue.executionId && current.status === 'active';
  };
  const successors = await persistEffectiveUltrafixSettings({ draftId: queue.draftId, issues: params.issues, contextConfig: params.contextConfig });
  for (const issue of successors) {
    const selection = issue.agent_alias && issue.model_name ? issue : await core.resolvePlanIssueDefaultSelection(issue);
    if (!await owned()) throw new EpicQueueRequestError('The plan execution changed; refresh and queue again.');
    await core.updatePlanIssue(queue.draftId, issue.issue_number, { agent_alias: selection.agent_alias, model_name: selection.model_name });
    await syncQueuedEpicIssueSelectors({ draftId: queue.draftId, repository: queue.repository, issueNumber: issue.issue_number,
      epicLabel, autoMerge: queue.autoMerge, selection, octokit, canConfigure: owned });
  }
  // Compare-and-swap on the issue list so a concurrent advance or completion is not overwritten.
  const appended = await core.db('epic_execution_queues')
    .where({ draft_id: queue.draftId, execution_id: queue.executionId, status: 'active', issues: JSON.stringify(queue.issues) })
    .update({ issues: JSON.stringify([...queue.issues, ...params.issues.map(issue => issue.issue_number)]), updated_at: Date.now() });
  if (!appended) throw new EpicQueueRequestError('The plan execution changed; refresh and queue again.');
}
