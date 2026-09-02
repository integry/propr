import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { notificationSchema } from '@propr/shared';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { postTaskFollowup, stopTaskExecution } from '../../api/proprApi';
import { ToastProvider } from '../ui/Toast';
import NotificationActions from './NotificationActions';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../api/proprApi', () => ({
  postTaskFollowup: vi.fn(),
  stopTaskExecution: vi.fn(),
}));

function notification(title: string, actions: string[]) {
  return notificationSchema.parse({
    id: `event-${title}`,
    deduplicationKey: `key-${title}`,
    kind: 'task',
    severity: 'success',
    target: { type: 'task', repository: 'integry/propr', taskId: `task-${title}` },
    title,
    body: 'Task lifecycle update.',
    occurredAt: '2026-08-24T12:00:00.000Z',
    createdAt: '2026-08-24T12:00:00.000Z',
    readAt: null,
    dismissedAt: null,
    actions,
  });
}

function renderActions(actions: string[], onChanged: () => Promise<void>) {
  render(
    <ToastProvider>
      <NotificationActions
        notification={notification('Task', actions)}
        mutationsEnabled
        onDismiss={vi.fn()}
        onChanged={onChanged}
      />
    </ToastProvider>,
  );
}

describe('Notification actions reconciliation', () => {
  beforeEach(() => {
    vi.mocked(postTaskFollowup).mockReset();
    vi.mocked(stopTaskExecution).mockReset();
  });

  test('keeps a posted follow-up successful when Inbox reconciliation fails', async () => {
    vi.mocked(postTaskFollowup).mockResolvedValue({ success: true, message: 'Posted' });
    const onChanged = vi.fn().mockRejectedValue(new Error('Refresh unavailable'));
    renderActions(['follow_up', 'dismiss'], onChanged);

    fireEvent.click(screen.getByRole('button', { name: 'Follow up on Task' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Comment' }), {
      target: { value: 'Please add a regression test.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Post Comment' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(postTaskFollowup).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Follow-up posted successfully.')).toBeInTheDocument();
    expect(await screen.findByText(/Follow-up was posted, but the Inbox couldn't refresh/))
      .toBeInTheDocument();
    expect(screen.queryByText(/Couldn't post the follow-up/)).not.toBeInTheDocument();
  });

  test('does not report a successful stop as failed when Inbox reconciliation fails', async () => {
    vi.mocked(stopTaskExecution).mockResolvedValue({
      success: true,
      message: 'Stopping',
      containerStopped: true,
    });
    const onChanged = vi.fn().mockRejectedValue(new Error('Refresh unavailable'));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderActions(['stop', 'dismiss'], onChanged);

    fireEvent.click(screen.getByRole('button', { name: 'Stop Task' }));

    expect(await screen.findByText('Stop requested successfully.')).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/Stop was requested, but the Inbox couldn't refresh/))
      .toBeInTheDocument();
    expect(screen.queryByText(/Couldn't stop the task/)).not.toBeInTheDocument();
    confirm.mockRestore();
  });

  test('offers plan-specific refine and confirmation-gated approval destinations', () => {
    const plan = notificationSchema.parse({
      ...notification('Plan ready', []),
      kind: 'plan',
      target: { type: 'plan', repository: 'integry/propr', draftId: 'draft/one' },
      actions: ['refine', 'approve_execute', 'dismiss'],
    });
    render(
      <MemoryRouter>
        <ToastProvider>
          <NotificationActions
            notification={plan}
            mutationsEnabled
            onDismiss={vi.fn()}
            onChanged={vi.fn()}
          />
        </ToastProvider>
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: 'Refine Plan ready' }))
      .toHaveAttribute('href', '/studio/draft%2Fone?intent=refine');
    expect(screen.getByRole('link', { name: 'Approve or execute Plan ready' }))
      .toHaveAttribute('href', '/studio/draft%2Fone?intent=approve_execute');
  });
});
