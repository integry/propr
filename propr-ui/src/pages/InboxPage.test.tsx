import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
const refreshUnreadCount = vi.fn(async () => undefined);
vi.mock('../contexts/NotificationCenterContext', () => ({
  useNotificationCenter: () => ({
    unreadCount: 3,
    commitUnreadCount,
    refreshUnreadCount,
    isActiveIdentity: () => true,
  }),
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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
    refreshUnreadCount.mockClear();
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
    expect(refreshUnreadCount).toHaveBeenCalledTimes(1);
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
    await waitFor(() => expect(refreshUnreadCount).toHaveBeenCalledTimes(1));
  });

  test('shows a read failure toast after an internal detail link unmounts the Inbox', async () => {
    const notification = item('event-read-failure', 'Read failure notification');
    const readRequest = deferred<Awaited<ReturnType<typeof markNotificationRead>>>();
    vi.mocked(listNotifications).mockResolvedValue({ notifications: [notification], unreadCount: 1, nextCursor: null });
    vi.mocked(markNotificationRead).mockReturnValue(readRequest.promise);
    renderInbox();

    fireEvent.click(await screen.findByRole('link', { name: /Read failure notification/ }));
    expect(await screen.findByText('Task details')).toBeInTheDocument();
    await act(async () => readRequest.reject(new Error('Read state unavailable')));

    expect(await screen.findByText(/Couldn't mark the notification read.*Read state unavailable/)).toBeInTheDocument();
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

  test('keeps cursor pagination available after dismissing every loaded item', async () => {
    const first = item('event-1', 'First task');
    const second = item('event-2', 'Second task');
    vi.mocked(listNotifications)
      .mockResolvedValueOnce({ notifications: [first, second], unreadCount: 2, nextCursor: 'cursor-1' })
      .mockResolvedValueOnce({ notifications: [], unreadCount: 0, nextCursor: null });
    vi.mocked(dismissNotification).mockImplementation(async id => ({
      notification: id === first.id ? first : second,
      unreadCount: id === first.id ? 1 : 0,
    }));
    renderInbox();

    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss First task' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Second task' }));
    const loadMore = await screen.findByRole('button', { name: 'Load more' });
    expect(screen.queryByText('You’re all caught up')).not.toBeInTheDocument();

    fireEvent.click(loadMore);
    await waitFor(() => expect(listNotifications).toHaveBeenLastCalledWith({ cursor: 'cursor-1', limit: 25 }));
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
    expect(commitUnreadCount).not.toHaveBeenCalledWith(1);
  });

  test('restores an intent-dismissed item when the request fails after the list arrives', async () => {
    const notification = item('event-race', 'Restore this notification');
    const listRequest = deferred<Awaited<ReturnType<typeof listNotifications>>>();
    const dismissRequest = deferred<Awaited<ReturnType<typeof dismissNotification>>>();
    vi.mocked(listNotifications).mockReturnValue(listRequest.promise);
    vi.mocked(dismissNotification).mockReturnValue(dismissRequest.promise);
    renderInbox('/inbox?intent=dismiss&notification=event-race');

    await waitFor(() => expect(dismissNotification).toHaveBeenCalledWith('event-race'));
    await act(async () => listRequest.resolve({ notifications: [notification], unreadCount: 1, nextCursor: null }));
    expect(await screen.findByText('You’re all caught up')).toBeInTheDocument();
    await act(async () => dismissRequest.reject(new Error('Dismiss failed')));

    expect(await screen.findByText('Restore this notification')).toBeInTheDocument();
    expect(screen.getByText(/Couldn't dismiss the notification/)).toBeInTheDocument();
  });

  test('reconciles an older refresh response with a completed read mutation', async () => {
    const notification = notificationSchema.parse({
      ...item('event-read-race', 'Read race notification'),
      action: { type: 'external_link', label: 'Open pull request', href: 'https://github.com/integry/propr/pull/1937' },
    });
    const staleRefresh = deferred<Awaited<ReturnType<typeof listNotifications>>>();
    vi.mocked(listNotifications)
      .mockResolvedValueOnce({ notifications: [notification], unreadCount: 1, nextCursor: null })
      .mockReturnValueOnce(staleRefresh.promise);
    vi.mocked(markNotificationRead).mockResolvedValue({
      notification: notificationSchema.parse({
        ...notification,
        readAt: '2026-08-24T12:01:00.000Z',
      }),
      unreadCount: 0,
    });
    renderInbox();

    await screen.findByText('Read race notification');
    commitUnreadCount.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Inbox' }));
    await waitFor(() => expect(listNotifications).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('link', { name: /Read race notification/ }));
    await waitFor(() => expect(markNotificationRead).toHaveBeenCalledWith('event-read-race'));
    await act(async () => staleRefresh.resolve({ notifications: [notification], unreadCount: 9, nextCursor: null }));

    await waitFor(() => expect(screen.queryByText('Unread')).not.toBeInTheDocument());
    expect(commitUnreadCount).not.toHaveBeenCalledWith(9);
  });

  test('ignores an error from load-more after a refresh supersedes it', async () => {
    const first = item('event-first', 'First page item');
    const refreshed = item('event-refreshed', 'Refreshed item');
    const final = item('event-final', 'New cursor item');
    const loadMoreRequest = deferred<Awaited<ReturnType<typeof listNotifications>>>();
    const newLoadMoreRequest = deferred<Awaited<ReturnType<typeof listNotifications>>>();
    vi.mocked(listNotifications)
      .mockResolvedValueOnce({ notifications: [first], unreadCount: 1, nextCursor: 'cursor-1' })
      .mockReturnValueOnce(loadMoreRequest.promise)
      .mockResolvedValueOnce({ notifications: [refreshed], unreadCount: 2, nextCursor: 'cursor-2' })
      .mockReturnValueOnce(newLoadMoreRequest.promise);
    renderInbox();

    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Inbox' }));
    expect(await screen.findByText('Refreshed item')).toBeInTheDocument();
    const refreshedLoadMore = screen.getByRole('button', { name: 'Load more' });
    expect(refreshedLoadMore).toBeEnabled();
    fireEvent.click(refreshedLoadMore);
    expect(await screen.findByRole('button', { name: 'Loading…' })).toBeDisabled();
    await act(async () => loadMoreRequest.reject(new Error('Superseded page failed')));

    expect(screen.queryByText(/Superseded page failed/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Loading…' })).toBeDisabled();
    await act(async () => newLoadMoreRequest.resolve({ notifications: [final], unreadCount: 2, nextCursor: null }));
    expect(await screen.findByText('New cursor item')).toBeInTheDocument();
    expect(listNotifications).toHaveBeenLastCalledWith({ cursor: 'cursor-2', limit: 25 });
  });
});
