import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { notificationSchema } from '@propr/shared';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { postTaskFollowup } from '../../api/proprApi';
import { ToastProvider } from '../ui/Toast';
import { notificationFollowupCommand } from '../../pages/inboxUtils';
import type { TaskRunEntry } from '../TaskList/rowModel';
import NotificationActions from './NotificationActions';
import { resetFollowupSubmissions } from './followupSubmissions';

vi.mock('../../api/proprApi', () => ({
  postTaskFollowup: vi.fn(),
}));

function notification(overrides: Record<string, unknown>) {
  return notificationSchema.parse({
    id: 'event-1',
    deduplicationKey: 'key-1',
    kind: 'task',
    severity: 'success',
    target: { type: 'task', repository: 'integry/propr', taskId: 'task-1', issueNumber: 7 },
    title: 'Task',
    body: 'Task lifecycle update.',
    occurredAt: '2026-08-24T12:00:00.000Z',
    createdAt: '2026-08-24T12:00:00.000Z',
    readAt: null,
    dismissedAt: null,
    actions: ['follow_up', 'stop', 'open_pr', 'dismiss'],
    ...overrides,
  });
}

const review = notification({
  kind: 'review',
  title: 'Review completed for PR #12',
  target: { type: 'review', repository: 'integry/propr', prNumber: 12, taskId: 'task-review' },
});

/** The task's runs when the notification's run is the newest, so its commands are offered. */
const newestRun = (id: string, type: string | null): TaskRunEntry[] => [{
  number: 1, type, summary: '', outcome: 'passed',
  task: { id, status: 'completed', createdAt: '2026-08-24T12:00:00.000Z', prNumber: 12 },
}];

describe('Notification follow-up commands', () => {
  beforeEach(() => {
    vi.mocked(postTaskFollowup).mockReset();
    resetFollowupSubmissions();
  });

  test('offers commands only for finished reviews and pull-request runs', () => {
    expect(notificationFollowupCommand(notification({}))).toBeNull();
    expect(notificationFollowupCommand(review)?.commands).toEqual(['/fix']);
    expect(notificationFollowupCommand(notification({ ...review, actions: ['dismiss'] }))).toBeNull();
    // A clean review has nothing to fix; a failed reviewer still leaves /fix available.
    expect(notificationFollowupCommand(notification({ ...review, body: 'Score 9/10 · 0 issues found' }))).toBeNull();
    expect(notificationFollowupCommand(notification({
      ...review, body: 'Score 9/10 · 0 issues found · 1 reviewer failed',
    }))?.commands).toEqual(['/fix']);
    expect(notificationFollowupCommand(notification({ ...review, body: 'Score 6/10 · 2 issues found: A; B' }))?.commands)
      .toEqual(['/fix']);
    expect(notificationFollowupCommand(notification({
      kind: 'pull_request',
      severity: 'info',
      target: { type: 'pull_request', repository: 'integry/propr', prNumber: 12 },
      metadata: { completedImplementationTaskId: 'task-implementation' },
    }))).toEqual({ taskId: 'task-implementation', prNumber: 12, commands: ['/review', '/ultrafix'] });
    expect(notificationFollowupCommand(notification({
      kind: 'pull_request',
      severity: 'info',
      target: { type: 'pull_request', repository: 'integry/propr', prNumber: 12 },
    }))).toBeNull();
  });

  test('sends the command to the pull request and hands the finished card back for removal', async () => {
    vi.mocked(postTaskFollowup).mockResolvedValue({ success: true, message: 'Posted' });
    const onCommandSent = vi.fn().mockResolvedValue(undefined);
    render(
      <ToastProvider>
        <NotificationActions notification={review} runs={newestRun('task-review', 'review')} readRuns={async () => newestRun('task-review', 'review')} mutationsEnabled onCommandSent={onCommandSent} />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Send /fix to PR #12' }));

    await waitFor(() => expect(onCommandSent).toHaveBeenCalledTimes(1));
    expect(postTaskFollowup).toHaveBeenCalledWith('task-review', '/fix', 'pull_request');
    expect(screen.getByText('Sent /fix to PR #12.')).toBeInTheDocument();
  });

  test('keeps the first command inline and sends the others from the overflow menu', async () => {
    vi.mocked(postTaskFollowup).mockResolvedValue({ success: true, message: 'Posted' });
    const onCommandSent = vi.fn().mockResolvedValue(undefined);
    const pullRequest = notification({
      kind: 'pull_request',
      severity: 'info',
      target: { type: 'pull_request', repository: 'integry/propr', prNumber: 12 },
      metadata: { completedImplementationTaskId: 'task-implementation' },
    });
    render(
      <ToastProvider>
        <NotificationActions
          notification={pullRequest}
          runs={newestRun('task-implementation', null)}
          readRuns={async () => newestRun('task-implementation', null)}
          mutationsEnabled
          onCommandSent={onCommandSent}
        />
      </ToastProvider>,
    );

    const more = screen.getByRole('button', { name: 'More commands for PR #12' });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(more);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Send /ultrafix to PR #12' }));

    await waitFor(() => expect(onCommandSent).toHaveBeenCalledTimes(1));
    expect(postTaskFollowup).toHaveBeenCalledWith('task-implementation', '/ultrafix', 'pull_request');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  test('renders nothing until the runs are read, or once a newer run supersedes the notification\'s', () => {
    const { rerender } = render(
      <ToastProvider>
        <NotificationActions notification={review} runs={null} readRuns={async () => null} mutationsEnabled onCommandSent={vi.fn()} />
      </ToastProvider>,
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    const [reviewRun] = newestRun('task-review', 'review');
    const [fixRun] = newestRun('task-fix', 'fix');
    rerender(
      <ToastProvider>
        <NotificationActions notification={review} runs={[reviewRun, { ...fixRun, number: 2 }]} readRuns={async () => null} mutationsEnabled onCommandSent={vi.fn()} />
      </ToastProvider>,
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  test('sends nothing when a fresh read finds a newer run, and keeps the card', async () => {
    const onCommandSent = vi.fn();
    const [reviewRun] = newestRun('task-review', 'review');
    const [fixRun] = newestRun('task-fix', 'fix');
    render(
      <ToastProvider>
        <NotificationActions
          notification={review}
          runs={[reviewRun]}
          readRuns={async () => [reviewRun, { ...fixRun, number: 2 }]}
          mutationsEnabled
          onCommandSent={onCommandSent}
        />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Send /fix to PR #12' }));
    expect(await screen.findByText('/fix was not sent: newer work on PR #12 has superseded this run.')).toBeInTheDocument();
    expect(postTaskFollowup).not.toHaveBeenCalled();
    expect(onCommandSent).not.toHaveBeenCalled();
  });

  test('keeps the card when the server could not confirm the command was queued', async () => {
    vi.mocked(postTaskFollowup).mockResolvedValue({ success: false, state: 'unknown', jobId: 'job-1', message: 'Inspect this job before retrying.' });
    const onCommandSent = vi.fn();
    render(
      <ToastProvider>
        <NotificationActions notification={review} runs={newestRun('task-review', 'review')} readRuns={async () => newestRun('task-review', 'review')} mutationsEnabled onCommandSent={onCommandSent} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Send /fix to PR #12' }));
    expect(await screen.findByText('/fix for PR #12 may not have been queued. Inspect this job before retrying. (job job-1)')).toBeInTheDocument();
    expect(onCommandSent).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Send /fix to PR #12' })).toBeEnabled();
  });

  test('renders nothing in read-only mode', () => {
    render(
      <ToastProvider>
        <NotificationActions notification={review} runs={newestRun('task-review', 'review')} readRuns={async () => null} mutationsEnabled={false} onCommandSent={vi.fn()} />
      </ToastProvider>,
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
