import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { notificationSchema, type Notification } from '@propr/shared';
import { ToastProvider } from '../components/ui/Toast';
import InboxPage from './InboxPage';
import {
  dismissNotification,
  listNotifications,
  markNotificationRead,
} from '../api/notificationApi';

const commitUnreadCount = vi.fn();
vi.mock('../contexts/NotificationCenterContext', () => ({
  useNotificationCenter: () => ({ unreadCount: 3, commitUnreadCount, refreshUnreadCount: vi.fn() }),
}));
vi.mock('../api/notificationApi', () => ({
  listNotifications: vi.fn(),
  dismissNotification: vi.fn(),
  markNotificationRead: vi.fn(),
}));

function item(id: string, title: string, readAt: string | null = null): Notification {
  return notificationSchema.parse({
    id,
    deduplicationKey: `${id}-key`,
    kind: 'task',
    severity: 'error',
    target: { type: 'task', repository: 'integry/propr', taskId: `task-${id}` },
    title,
    body: 'Work did not complete.',
    occurredAt: '2026-08-24T12:00:00.000Z',
    createdAt: '2026-08-24T12:00:00.000Z',
    readAt,
    dismissedAt: null,
  });
}

const Location = () => <div data-testid="location">{useLocation().search}</div>;

function renderInbox(entry = '/inbox') {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/inbox" element={<><InboxPage /><Location /></>} />
          <Route path="/tasks/:id" element={<div>Task details</div>} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  );
}

describe('Inbox page', () => {
  beforeEach(() => {
    vi.mocked(listNotifications).mockReset();
    vi.mocked(dismissNotification).mockReset();
    vi.mocked(markNotificationRead).mockReset();
    commitUnreadCount.mockReset();
  });

  test('optimistically dismisses and restores an item when the request fails', async () => {
    const notification = item('event-1', 'Task one failed');
    vi.mocked(listNotifications).mockResolvedValue({ notifications: [notification], unreadCount: 1, nextCursor: null });
    vi.mocked(dismissNotification).mockRejectedValue(new Error('Network unavailable'));
    renderInbox();

    expect(await screen.findByText('Task one failed')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Task one failed' }));
    expect(screen.queryByText('Task one failed')).not.toBeInTheDocument();
    expect(await screen.findByText('Task one failed')).toBeInTheDocument();
    expect(screen.getByText(/Couldn't dismiss the notification/)).toBeInTheDocument();
  });

  test('marks an unread card read while following its deep link', async () => {
    const notification = item('event-1', 'Open this task');
    vi.mocked(listNotifications).mockResolvedValue({ notifications: [notification], unreadCount: 1, nextCursor: null });
    vi.mocked(markNotificationRead).mockResolvedValue({
      notification: item('event-1', 'Open this task', '2026-08-24T12:01:00.000Z'),
      unreadCount: 0,
    });
    renderInbox();

    fireEvent.click(await screen.findByRole('link', { name: /Open this task/ }));
    expect(await screen.findByText('Task details')).toBeInTheDocument();
    expect(markNotificationRead).toHaveBeenCalledWith('event-1');
    await waitFor(() => expect(commitUnreadCount).toHaveBeenCalledWith(0));
  });

  test('merges cursor pages without duplicating notifications', async () => {
    const first = item('event-1', 'First task');
    const second = item('event-2', 'Second task');
    vi.mocked(listNotifications)
      .mockResolvedValueOnce({ notifications: [first], unreadCount: 2, nextCursor: 'cursor-1' })
      .mockResolvedValueOnce({ notifications: [first, second], unreadCount: 2, nextCursor: null });
    renderInbox();

    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Second task')).toBeInTheDocument();
    expect(screen.getAllByText('First task')).toHaveLength(1);
  });

  test('consumes a service-worker dismissal intent', async () => {
    vi.mocked(listNotifications).mockResolvedValue({ notifications: [], unreadCount: 1, nextCursor: null });
    vi.mocked(dismissNotification).mockResolvedValue({
      notification: item('event-9', 'Dismissed task', '2026-08-24T12:01:00.000Z'),
      unreadCount: 0,
    });
    renderInbox('/inbox?flow=kept&intent=dismiss&notification=event-9');

    await waitFor(() => expect(dismissNotification).toHaveBeenCalledWith('event-9'));
    expect(screen.getByTestId('location')).toHaveTextContent('?flow=kept');
  });

  test('does not reinsert an intent-dismissed item from an older page response', async () => {
    const notification = item('event-race', 'Already dismissed');
    let resolveList!: (value: Awaited<ReturnType<typeof listNotifications>>) => void;
    vi.mocked(listNotifications).mockReturnValue(new Promise(resolve => { resolveList = resolve; }));
    vi.mocked(dismissNotification).mockResolvedValue({ notification, unreadCount: 0 });
    renderInbox('/inbox?intent=dismiss&notification=event-race');

    await waitFor(() => expect(dismissNotification).toHaveBeenCalledWith('event-race'));
    resolveList({ notifications: [notification], unreadCount: 1, nextCursor: null });
    expect(await screen.findByText('You’re all caught up')).toBeInTheDocument();
    expect(screen.queryByText('Already dismissed')).not.toBeInTheDocument();
  });
});
