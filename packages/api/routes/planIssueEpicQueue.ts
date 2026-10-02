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
    cancelEpicExecutionQueue,
    createEpicExecutionQueue,
    db,
    getAuthenticatedOctokit,
    getEpicExecutionQueue,
    getPlanIssuesByDraft,
    isInProgressStatus,
    PlanIssueStatus,
    readyEpicExecutionQueue,
    resolvePlanIssueDefaultSelection,
    updatePlanIssue,
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
    await createEpicExecutionQueue({ draftId, repository, issues: pending.map(issue => issue.issue_number),
      autoMerge, ready: false, headStartedAt: Date.now() });
  } catch (error) {
    if ((error as Error).message.includes('active epic execution queue')) throw new EpicQueueRequestError((error as Error).message);
    throw error;
  }
  let result: unknown;
  try {
    result = await params.implement();
  } catch (error) {
    await cancelEpicExecutionQueue(draftId);
    throw error;
  }
  // The head establishes the epic branch. Configure successors without starting them,
  // preserving each issue's selected model and effective ultrafix settings.
  const draft = await db('task_drafts').where({ draft_id: draftId }).first('context_config');
  const context = typeof draft.context_config === 'string' ? JSON.parse(draft.context_config) : draft.context_config;
  if (typeof context?.epicLabel !== 'string') throw new Error('Epic branch selector is missing for queued issues');
  const octokit = await getAuthenticatedOctokit();
  const successors = await persistEffectiveUltrafixSettings({ draftId, issues: pending.slice(1), contextConfig: params.contextConfig });
  for (const issue of successors) {
    const selection = issue.agent_alias && issue.model_name ? issue : await resolvePlanIssueDefaultSelection(issue);
    await updatePlanIssue(draftId, issue.issue_number, { agent_alias: selection.agent_alias, model_name: selection.model_name });
    await syncQueuedEpicIssueSelectors({ draftId, repository, issueNumber: issue.issue_number,
      epicLabel: context.epicLabel, autoMerge, selection, octokit });
  }
  await readyEpicExecutionQueue(draftId);
  return result;
}

/** Synchronize selectors without publishing the processing label. */
export async function syncQueuedEpicIssueSelectors(params: {
  draftId: string; repository: string; issueNumber: number; epicLabel: string; autoMerge: boolean;
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
  [epicLabel, modelLabel, ...(autoMerge ? ['auto-merge'] : [])]);
  if (!synced.success) throw new Error(`Failed to configure queued issue #${issueNumber}: ${synced.errors.join('; ')}`);
}
