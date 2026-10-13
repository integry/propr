import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { getTasks, postTaskFollowup } from '../../api/proprApi';
import { resetFollowupSubmissions } from '../Inbox/followupSubmissions';
import { ToastProvider } from '../ui/Toast';
import type { TaskRunEntry } from '../TaskList/rowModel';
import type { Task } from '../TaskList/types';
import LatestRunCommands from './LatestRunCommands';
import { notificationSchema } from '@propr/shared';
import { latestRunFollowup, notificationRunFollowup } from './runFollowup';

vi.mock('../../api/proprApi', () => ({ postTaskFollowup: vi.fn(), getTasks: vi.fn() }));

function run(number: number, type: string | null, task: Partial<Task> = {}): TaskRunEntry {
  return {
    number,
    type,
    summary: '',
    outcome: 'passed',
    task: { id: `run-${number}`, status: 'completed', createdAt: '2026-10-13T10:00:00.000Z', prNumber: 3065, ...task },
  };
}

const implementation = run(1, null);
const review = run(2, 'review', { score: 6 });

describe('latestRunFollowup', () => {
  test('offers /fix on a newest review with findings and /review, /ultrafix on a newest finished run', () => {
    expect(latestRunFollowup([implementation, review], 'run-2')).toEqual({ taskId: 'run-2', prNumber: 3065, commands: ['/fix'] });
    expect(latestRunFollowup([implementation], 'run-1')).toEqual({ taskId: 'run-1', prNumber: 3065, commands: ['/review', '/ultrafix'] });
  });

  test('offers nothing on an earlier run, so a command cannot be replayed from it', () => {
    expect(latestRunFollowup([implementation, review], 'run-1')).toBeNull();
    expect(latestRunFollowup([review, run(3, 'fix', { status: 'processing' })], 'run-2')).toBeNull();
  });

  test('offers nothing before the runs are read, while the run works, after it failed or merged, or without a PR', () => {
    expect(latestRunFollowup(undefined, 'run-1')).toBeNull();
    expect(latestRunFollowup([run(1, null, { status: 'processing' })], 'run-1')).toBeNull();
    expect(latestRunFollowup([run(1, null, { status: 'failed' })], 'run-1')).toBeNull();
    expect(latestRunFollowup([run(1, null, { planIssueStatus: 'merged' })], 'run-1')).toBeNull();
    expect(latestRunFollowup([run(1, null, { prNumber: null })], 'run-1')).toBeNull();
  });

  test('offers nothing on a clean review', () => {
    expect(latestRunFollowup([run(1, 'review', { score: 10 })], 'run-1')).toBeNull();
    expect(latestRunFollowup([{ ...run(1, 'review', { score: 9 }), summary: 'Score 9/10 · 0 issues found' }], 'run-1')).toBeNull();
  });

  test('reads a review summary as the Inbox reads its recap: a failed reviewer leaves something to fix', () => {
    const recap = 'Scores 9/10, 8/10 · 0 issues found · 1 reviewer failed';
    expect(latestRunFollowup([{ ...run(1, 'review', { score: 9 }), summary: recap }], 'run-1')?.commands).toEqual(['/fix']);
  });

  test('a perfect score does not outweigh a failed reviewer or findings in the recap', () => {
    const failedReviewer = { ...run(1, 'review', { score: 10 }), summary: 'Score 10/10 · 0 issues found · 1 reviewer failed' };
    const findings = { ...run(1, 'review', { score: 10 }), summary: 'Score 10/10 · 1 issue found: Guard the cursor' };
    expect(latestRunFollowup([failedReviewer], 'run-1')?.commands).toEqual(['/fix']);
    expect(latestRunFollowup([findings], 'run-1')?.commands).toEqual(['/fix']);
  });
});

describe('notificationRunFollowup', () => {
  const reviewNotification = notificationSchema.parse({
    id: 'review-1', deduplicationKey: 'review-1', kind: 'review', severity: 'success',
    target: { type: 'review', repository: 'integry/propr', prNumber: 3065, taskId: 'run-2' },
    title: 'Review', body: 'Score 6/10 · 1 issue found: Guard the cursor', actions: ['follow_up', 'dismiss'],
    occurredAt: '2026-10-13T10:00:00.000Z', createdAt: '2026-10-13T10:00:00.000Z', readAt: null, dismissedAt: null,
  });

  test('offers the notification its commands while its run is the newest', () => {
    expect(notificationRunFollowup(reviewNotification, [implementation, review])).toEqual({ taskId: 'run-2', prNumber: 3065, commands: ['/fix'] });
  });

  test('takes its commands from the notification, not from the run type read from its title', () => {
    const untypedReview = run(2, null, { score: 6 });
    expect(notificationRunFollowup(reviewNotification, [implementation, untypedReview])?.commands).toEqual(['/fix']);
  });

  test('applies the Tasks review rule to the run: a perfect score with a failed reviewer still offers /fix', () => {
    const failed = { ...reviewNotification, body: 'Score 10/10 · 0 issues found · 1 reviewer failed' } as typeof reviewNotification;
    const head = { ...run(2, 'review', { score: 10 }), summary: failed.body };
    expect(notificationRunFollowup(failed, [implementation, head])?.commands).toEqual(['/fix']);
    expect(notificationRunFollowup(reviewNotification, [implementation, { ...run(2, 'review', { score: 10 }), summary: 'Score 10/10 · 0 issues found' }]))
      .toBeNull();
  });

  test('offers nothing once a newer run supersedes it, before the runs are read, or for a clean recap', () => {
    expect(notificationRunFollowup(reviewNotification, [implementation, review, run(3, 'fix')])).toBeNull();
    expect(notificationRunFollowup(reviewNotification, null)).toBeNull();
    expect(notificationRunFollowup({ ...reviewNotification, body: 'Score 9/10 · 0 issues found' }, [implementation, review])).toBeNull();
  });
});

describe('LatestRunCommands', () => {
  afterEach(() => {
    vi.clearAllMocks();
    resetFollowupSubmissions();
  });

  const renderCommands = (taskId: string) => render(
    <ToastProvider><LatestRunCommands runs={[implementation, review]} taskId={taskId} /></ToastProvider>,
  );
  /** The task as a fresh read finds it: the given runs, oldest first. */
  const taskReads = (...tasks: Partial<Task>[]) => vi.mocked(getTasks).mockResolvedValue({
    tasks: tasks.map((task, index) => ({ repository: 'integry/propr', status: 'completed', prNumber: 3065, ...task,
      createdAt: new Date(Date.parse('2026-10-13T10:00:00.000Z') + index * 60_000).toISOString() })).reverse(),
  } as never);
  const stillNewest = () => taskReads({ id: 'run-1', title: 'Implement PR #3065' }, { id: 'run-2', title: 'Review PR #3065', score: 6 });

  test('the newest run sends its command once; reopening it keeps the command sent', async () => {
    stillNewest();
    let resolve: () => void = () => undefined;
    vi.mocked(postTaskFollowup).mockReturnValue(new Promise(done => { resolve = () => done({ success: true, message: 'Posted' }); }));
    const { unmount } = renderCommands('run-2');
    const fix = screen.getByRole('button', { name: 'Send /fix to PR #3065' });
    fireEvent.click(fix);
    fireEvent.click(fix);
    await waitFor(() => expect(postTaskFollowup).toHaveBeenCalledTimes(1));
    expect(getTasks).toHaveBeenCalledTimes(1);
    expect(postTaskFollowup).toHaveBeenCalledWith('run-2', '/fix', 'pull_request');
    await act(async () => resolve());
    expect(await screen.findByText('Sent /fix to PR #3065.')).toBeInTheDocument();
    unmount();

    renderCommands('run-2');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send /fix to PR #3065' })).toBeDisabled());
  });

  test('an earlier run shows no commands', () => {
    renderCommands('run-1');
    expect(screen.queryByRole('button', { name: /^Send/ })).not.toBeInTheDocument();
  });

  test('a run newer work superseded since the runs were shown sends nothing', async () => {
    taskReads({ id: 'run-1', title: 'Implement PR #3065' }, { id: 'run-2', title: 'Review PR #3065', score: 6 }, { id: 'run-3', title: 'Fix PR #3065' });
    renderCommands('run-2');
    fireEvent.click(screen.getByRole('button', { name: 'Send /fix to PR #3065' }));
    expect(await screen.findByText('/fix was not sent: newer work on PR #3065 has superseded this run.')).toBeInTheDocument();
    expect(getTasks).toHaveBeenCalledWith({ groupBy: 'task', task: 'run-2', limit: 1, offset: 0 });
    expect(postTaskFollowup).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Send /fix to PR #3065' })).toBeEnabled();
  });

  test('a run whose task cannot be read again sends nothing', async () => {
    vi.mocked(getTasks).mockRejectedValue(new Error('unavailable'));
    renderCommands('run-2');
    fireEvent.click(screen.getByRole('button', { name: 'Send /fix to PR #3065' }));
    expect(await screen.findByText("Couldn't confirm /fix still applies to PR #3065. unavailable")).toBeInTheDocument();
    expect(postTaskFollowup).not.toHaveBeenCalled();
  });

  test('a command the server could not confirm queued stays retryable and shows its handles', async () => {
    stillNewest();
    vi.mocked(postTaskFollowup).mockResolvedValueOnce({
      success: false, state: 'unknown', posted: true, commentId: 42, jobId: 'job-7',
      message: 'Comment posted, but queue submission could not be confirmed. Inspect this job before retrying.',
    });
    renderCommands('run-2');
    fireEvent.click(screen.getByRole('button', { name: 'Send /fix to PR #3065' }));
    expect(await screen.findByText(
      '/fix for PR #3065 may not have been queued. Comment posted, but queue submission could not be confirmed. Inspect this job before retrying. (comment 42, job job-7)',
    )).toBeInTheDocument();
    expect(screen.queryByText('Sent /fix to PR #3065.')).not.toBeInTheDocument();
    const fix = screen.getByRole('button', { name: 'Send /fix to PR #3065' });
    expect(fix).toBeEnabled();
    expect(fix).toHaveAttribute('title', expect.stringContaining('comment 42, job job-7'));

    vi.mocked(postTaskFollowup).mockResolvedValueOnce({ success: true, state: 'queued' });
    fireEvent.click(fix);
    expect(await screen.findByText('Sent /fix to PR #3065.')).toBeInTheDocument();
    expect(postTaskFollowup).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'Send /fix to PR #3065' })).toBeDisabled();
  });
});
