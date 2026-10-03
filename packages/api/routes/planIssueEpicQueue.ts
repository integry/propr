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
  try {
    // Like the retired UI chain, a closed or failed issue does not hold the remaining epic.
    await createEpicExecutionQueue({ draftId, repository, issues: pending.map(issue => issue.issue_number),
      advanceOn: 'terminal', autoMerge, ready: false, headStartedAt: Date.now() });
  } catch (error) {
    if ((error as Error).message.includes('active epic execution queue')) throw new EpicQueueRequestError((error as Error).message);
    throw error;
  }
  // A rejected implementation can already have published labels or queued work.
  // Keep recovery and finalization owed when the external outcome is uncertain.
  const result = await params.implement();
  // The head establishes the epic branch. Configure successors without starting them,
  // preserving each issue's selected model and effective ultrafix settings.
  const draft = await db('task_drafts').where({ draft_id: draftId }).first('context_config');
  const context = typeof draft.context_config === 'string' ? JSON.parse(draft.context_config) : draft.context_config;
  if (typeof context?.epicLabel !== 'string') throw new Error('Epic branch selector is missing for queued issues');
  await configureQueuedSuccessors({ draftId, repository, issues: pending.slice(1), epicLabel: context.epicLabel,
    autoMerge, contextConfig: params.contextConfig });
  await readyEpicExecutionQueue(draftId);
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
  // Without an epic branch to establish, successors are configured before the queue can advance.
  await configureQueuedSuccessors({ draftId, repository, issues: successors, autoMerge: true, contextConfig: params.contextConfig });
  try {
    await createEpicExecutionQueue({ draftId, repository, issues: [issueNumber, ...successors.map(issue => issue.issue_number)],
      advanceOn: 'terminal', autoMerge: true, useEpic: false, headStartedAt: Date.now() });
  } catch (error) {
    if (!(error as Error).message.includes('active epic execution queue')) throw error;
    return params.implement();
  }
  return params.implement();
}

/** Persist each successor's model and ultrafix settings, then sync selectors without a processing label. */
async function configureQueuedSuccessors(params: {
  draftId: string; repository: string; issues: core.PlanIssue[]; epicLabel?: string; autoMerge: boolean;
  contextConfig: Record<string, unknown> | null;
}): Promise<void> {
  const { draftId, repository, epicLabel, autoMerge } = params;
  const octokit = await core.getAuthenticatedOctokit();
  const successors = await persistEffectiveUltrafixSettings({ draftId, issues: params.issues, contextConfig: params.contextConfig });
  for (const issue of successors) {
    const selection = issue.agent_alias && issue.model_name ? issue : await core.resolvePlanIssueDefaultSelection(issue);
    await core.updatePlanIssue(draftId, issue.issue_number, { agent_alias: selection.agent_alias, model_name: selection.model_name });
    await syncQueuedEpicIssueSelectors({ draftId, repository, issueNumber: issue.issue_number,
      epicLabel, autoMerge, selection, octokit });
  }
}

/** Synchronize selectors without publishing the processing label. */
export async function syncQueuedEpicIssueSelectors(params: {
  draftId: string; repository: string; issueNumber: number; epicLabel?: string; autoMerge: boolean;
  selection: { agent_alias: string | null; model_name: string | null };
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
  const synced = await core.safeUpdateLabels({ octokit, owner, repo, issueNumber,
    logger: core.logger.withCorrelation(`epic-setup-${draftId}`) }, stale,
  [...(epicLabel ? [epicLabel] : []), modelLabel, ...(autoMerge ? ['auto-merge'] : [])]);
  if (!synced.success) throw new Error(`Failed to configure queued issue #${issueNumber}: ${synced.errors.join('; ')}`);
}
