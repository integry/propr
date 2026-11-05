import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import TaskDetails from './index';
import type { FollowupTarget } from './types';

// The task info the history API returned, and the task ID it was read for.
const loaded = vi.hoisted(() => ({ info: {} as Record<string, unknown> }));
const postTaskFollowup = vi.hoisted(() => vi.fn(async () => ({ success: true, state: 'queued' })));

vi.mock('../../api/proprApi', async importOriginal => ({ ...await importOriginal<typeof import('../../api/proprApi')>(), postTaskFollowup }));
vi.mock('./hooks', () => ({
  useTaskData: () => ({
    loading: false, error: null,
    history: [{ id: 1, status: 'completed', timestamp: '2026-10-17T12:00:00Z', metadata: {} }],
    taskInfo: { title: 'Implement the export', ...loaded.info },
    liveDetails: { todos: [], events: [] },
    usageMetricRecords: [], previewMedia: [],
    stoppingExecution: false, stopFailed: false, deletingTask: false,
    handleStopExecution: vi.fn(), handleDeleteTask: vi.fn(),
  }),
  usePromptData: () => ({ fetchPrompt: vi.fn(), selectedPrompt: null, loadingPrompt: false, closePrompt: vi.fn() }),
  useLogFilesData: () => ({ fetchLogFilesData: vi.fn(), logFiles: null, searchMatches: [], closeLogFiles: vi.fn() }),
}));
vi.mock('./useThinkingLog', () => ({
  useThinkingLog: () => ({ eventsCollapsed: true, collapseEvents: vi.fn(), toggleEventsCollapse: vi.fn(), thinkingLogWithTimestamps: [] }),
}));
vi.mock('./useHistoryData', () => ({
  getHistoryDerivedData: () => ({ currentStatus: 'completed', isTaskActive: false, modelName: null, prInfo: null, historyItemWithPaths: null }),
}));
vi.mock('./useDerivedTaskData', () => ({
  useTotalDuration: () => null, useCommitInfo: () => null, useConsumedReviewCommentIds: () => new Set(), useTokenUsage: () => null,
}));
vi.mock('../ui/useToast', () => ({ useToast: () => ({ addToast: vi.fn() }) }));
vi.mock('./ActionBar', () => ({
  default: ({ onFollowUp }: { onFollowUp?: () => void }) => onFollowUp ? <button type="button" onClick={onFollowUp}>Follow Up</button> : null,
}));
vi.mock('../../api/taskStatsApi', () => ({
  getPullRequestScores: vi.fn(async (repository: string, prNumber: number) => ({ repository, pr_number: prNumber, outcome: null, merged_at: null, closed_at: null, scores: [] })),
}));
// Children have their own suites; this one is about what the follow-up dialog names and posts.
vi.mock('./ThinkingLog', () => ({ default: () => null }));
vi.mock('./ExecutionEventLog', () => ({ default: () => null }));
vi.mock('./ResultOverview', () => ({ default: () => null }));
vi.mock('./PromptModal', () => ({ default: () => null }));
vi.mock('./LogFilesModal', () => ({ default: () => null }));
vi.mock('./ContextStrip', () => ({ default: () => null, ConsumptionGroup: () => null, MobileGitContext: () => null, MobilePeopleRuntime: () => null }));
vi.mock('./TaskHeader', async importOriginal => ({ ...await importOriginal<typeof import('./TaskHeader')>(), default: () => null }));
vi.mock('./useTaskHeadSummary', async importOriginal => ({ ...await importOriginal<typeof import('./useTaskHeadSummary')>(), useTaskHeadSummary: () => null }));
vi.mock('./ProgressBar', () => ({ default: () => null }));
vi.mock('./LeftPaneBody', () => ({ default: () => null }));
vi.mock('./TaskVisualPreviews', () => ({ default: () => null }));

afterEach(() => {
  vi.clearAllMocks();
  loaded.info = {};
});

const repo = { repoOwner: 'owner', repoName: 'repository' };
const target = (taskId: string, kind: FollowupTarget['kind'], number: number): FollowupTarget => ({ taskId, repository: 'owner/repository', kind, number });

async function openFollowup(taskId: string) {
  render(<MemoryRouter><TaskDetails taskId={taskId} embedded /></MemoryRouter>);
  // A PR task offers follow-ups once its PR is known to be unmerged.
  await act(async () => {});
  fireEvent.click(screen.getAllByRole('button', { name: 'Follow Up' })[0]);
  const dialog = await screen.findByRole('dialog', { name: 'Follow Up on Task' });
  const post = screen.getByRole('button', { name: 'Post Comment' });
  return { dialog, post };
}

describe('the follow-up dialog names the thread its submission posts to', () => {
  it.each([
    ['an issue implementation that created a PR names that PR', 'issue-27-run', { type: 'issue', number: 27, followupTarget: target('issue-27-run', 'pull_request', 28) }, 'PR owner/repository#28'],
    ['a failed issue implementation without a PR names its issue', 'issue-29-run', { type: 'issue', number: 29, followupTarget: target('issue-29-run', 'issue', 29) }, 'Issue owner/repository#29'],
    ['a PR-comment task names its PR', 'pr-comment-28', { type: 'pr-comment', number: 28, followupTarget: target('pr-comment-28', 'pull_request', 28) }, 'PR owner/repository#28'],
  ])('%s and submits that task ID', async (_name, taskId, info, destination) => {
    loaded.info = { ...repo, ...info };
    const { dialog, post } = await openFollowup(taskId);
    expect(dialog).toHaveAccessibleDescription(`Post a comment to ${destination}`);
    await act(async () => { fireEvent.click(post); });
    expect(postTaskFollowup).toHaveBeenCalledTimes(1);
    expect(postTaskFollowup).toHaveBeenCalledWith(taskId, expect.any(String));
  });

  it('an older run does not borrow the destination resolved for another run, and does not post', async () => {
    // Task info still held from the newer run that created PR #28.
    loaded.info = { ...repo, type: 'issue', number: 27, followupTarget: target('issue-27-newer-run', 'pull_request', 28) };
    const { dialog, post } = await openFollowup('issue-27-older-run');
    expect(dialog).toHaveAccessibleDescription(/thread for this follow-up is not available/);
    expect(dialog).not.toHaveTextContent('#28');
    expect(dialog).not.toHaveTextContent('#27');
    expect(post).toBeDisabled();
    expect(post).toHaveAccessibleDescription(/not available/);
    fireEvent.click(post);
    expect(postTaskFollowup).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['without a repository', { ...target('issue-31-run', 'issue', 31), repository: 'owner' }],
    ['with no thread number', { ...target('issue-31-run', 'issue', 31), number: 0 }],
  ])('a destination %s invents no thread from the task number', async (_name, followupTarget) => {
    loaded.info = { ...repo, type: 'issue', number: 31, followupTarget };
    const { dialog, post } = await openFollowup('issue-31-run');
    expect(dialog).not.toHaveTextContent('#31');
    expect(post).toBeDisabled();
  });
});
