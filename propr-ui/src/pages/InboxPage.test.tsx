/* eslint-disable max-lines */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { notificationSchema, type Notification } from '@propr/shared';
import { ToastProvider } from '../components/ui/Toast';
import InboxPage from './InboxPage';
import {
  dismissAllNotifications,
  dismissNotification,
  listNotifications,
  markNotificationRead,
} from '../api/notificationApi';
import { postTaskFollowup } from '../api/proprApi';

const commitUnreadCount = vi.fn();
const refreshUnreadCount = vi.fn(async () => undefined);
const demoState = { isDemoMode: false };
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
  dismissAllNotifications: vi.fn(),
  dismissNotification: vi.fn(),
  markNotificationRead: vi.fn(),
}));
vi.mock('../api/proprApi', () => ({
  postTaskFollowup: vi.fn(),
}));
vi.mock('../contexts/DemoModeContext', () => ({ useDemoMode: () => demoState }));

function item(
  id: string,
  title: string,
  readAt: string | null = null,
  overrides: Record<string, unknown> = {},
): Notification {
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
    actions: ['dismiss'],
    ...overrides,
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
    vi.mocked(dismissAllNotifications).mockReset();
    vi.mocked(dismissNotification).mockReset();
    vi.mocked(markNotificationRead).mockReset();
    vi.mocked(postTaskFollowup).mockReset();
    commitUnreadCount.mockReset();
    refreshUnreadCount.mockClear();
    demoState.isDemoMode = false;
  });

  test('renders activity as one newest-first list with only System kept apart and collapsed', async () => {
    const at = (minutes: number) => new Date(Date.parse('2026-08-24T12:00:00.000Z') + minutes * 60_000).toISOString();
    const failed = item('event-failed', 'Guard empty recap metadata', null, {
      occurredAt: at(0), createdAt: at(0),
      target: { type: 'task', repository: 'integry/propr', taskId: 'task-failed', issueNumber: 12 },
    });
    const plan = item('event-plan', 'Improve Inbox notifications', null, {
      kind: 'plan',
      severity: 'info',
      target: { type: 'plan', repository: 'integry/propr', draftId: 'draft-1' },
      occurredAt: at(2), createdAt: at(2),
    });
    const review = item('event-review', 'Add swipe dismissal', '2026-08-24T12:10:00.000Z', {
      kind: 'review',
      severity: 'success',
      target: { type: 'review', repository: 'integry/propr', prNumber: 81, taskId: 'task-review' },
      occurredAt: at(1), createdAt: at(1),
    });
    const system = item('event-system', 'System failure', null, {
      kind: 'system_failure',
      severity: 'error',
      target: { type: 'system_failure', component: 'dispatcher' },
      occurredAt: at(3), createdAt: at(3),
    });
    vi.mocked(listNotifications).mockResolvedValue({
      notifications: [system, plan, review, failed],
      unreadCount: 3,
      nextCursor: null,
    });

    renderInbox();

    await screen.findByRole('heading', { level: 3, name: 'Improve Inbox notifications' });
    expect(screen.getAllByRole('heading', { level: 2 }).map(heading => heading.textContent)).toEqual(['System1']);
    expect(screen.getAllByRole('article').map(article => article.getAttribute('aria-label'))).toEqual([
      'Improve Inbox notifications',
      'Add swipe dismissal',
      'Guard empty recap metadata',
    ]);
    const reviewCard = screen.getByRole('article', { name: 'Add swipe dismissal' });
    expect(reviewCard).toHaveTextContent('Review completed');
    expect(screen.getByTitle('Pull request #81')).toHaveTextContent('PR #81');
    expect(screen.getByTitle('Issue #12')).toHaveTextContent('Issue #12');
    for (const article of screen.getAllByRole('article')) {
      expect(article.className).toContain('bg-white');
      expect(article.className).not.toMatch(/bg-(teal|red|amber|emerald)-/);
    }
    expect(screen.queryByRole('heading', { level: 3, name: 'System failure' })).not.toBeInTheDocument();

    const systemToggle = screen.getByRole('button', { name: /System/ });
    expect(systemToggle).toHaveAttribute('aria-expanded', 'false');
    expect(document.getElementById(systemToggle.getAttribute('aria-controls')!)).not.toBeVisible();
    const lastActivity = screen.getByRole('article', { name: 'Guard empty recap metadata' });
    expect(lastActivity.compareDocumentPosition(systemToggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(systemToggle);
    expect(document.getElementById(systemToggle.getAttribute('aria-controls')!)).toBeVisible();
    const systemCard = screen.getByRole('article', { name: 'System failure' });
    expect(systemCard.closest('section')).toHaveAccessibleName('System');
    expect(within(systemCard).queryByRole('heading')).not.toBeInTheDocument();
  });

  test('keeps cards free of generic buttons apart from the always-visible dismiss control', async () => {
    const notification = item('event-stalled', 'Stalled task', null, {
      severity: 'warning',
      target: { type: 'task', repository: 'integry/propr', taskId: 'task-event-stalled', prNumber: 1724 },
      actions: ['stop', 'follow_up', 'open_pr', 'dismiss'],
      action: {
        type: 'external_link', label: 'Open pull request', href: 'https://github.com/integry/propr/pull/1724',
      },
    });
    vi.mocked(listNotifications).mockResolvedValue({ notifications: [notification], unreadCount: 1, nextCursor: null });
    renderInbox();

    const card = await screen.findByRole('article', { name: 'Stalled task' });
    expect(Array.from(card.querySelectorAll('button')).map(button => button.getAttribute('aria-label')))
      .toEqual(['Dismiss Stalled task']);
    expect(screen.getByRole('link', { name: /Stalled task/ })).toHaveAttribute('href', '/tasks/task-event-stalled');
  });

  test('sends /fix from a completed review to its pull request and clears the card', async () => {
    const notification = item('event-review', 'Review completed for PR #1724', null, {
      kind: 'review',
      severity: 'success',
      target: { type: 'review', repository: 'integry/propr', prNumber: 1724, taskId: 'task-review' },
      actions: ['follow_up', 'open_pr', 'dismiss'],
    });
    const request = deferred<Awaited<ReturnType<typeof postTaskFollowup>>>();
    vi.mocked(listNotifications).mockResolvedValue({ notifications: [notification], unreadCount: 1, nextCursor: null });
    vi.mocked(postTaskFollowup).mockReturnValue(request.promise);
    vi.mocked(dismissNotification).mockResolvedValue({ notification, unreadCount: 0 });
    renderInbox();

    const fix = await screen.findByRole('button', { name: 'Send /fix to PR #1724' });
    expect(screen.queryByRole('button', { name: /Send \/review/ })).not.toBeInTheDocument();
    fireEvent.click(fix);
    fireEvent.click(fix);
    expect(postTaskFollowup).toHaveBeenCalledTimes(1);
    expect(postTaskFollowup).toHaveBeenCalledWith('task-review', '/fix', 'pull_request');

    await act(async () => request.resolve({ success: true, message: 'Posted' }));
    expect(await screen.findByText('Sent /fix to PR #1724.')).toBeInTheDocument();
    await waitFor(() => expect(dismissNotification).toHaveBeenCalledWith('event-review'));
    expect(screen.queryByRole('article', { name: 'Review completed for PR #1724' })).not.toBeInTheDocument();
  });

  test('offers /review and /ultrafix after a PR run and opens the pull request on click', async () => {
    const notification = item('event-pr', 'Fix run completed for PR #1724', null, {
      kind: 'pull_request',
      severity: 'info',
      target: { type: 'pull_request', repository: 'integry/propr', prNumber: 1724 },
      metadata: { completedImplementationTaskId: 'task-fix', completionType: 'fix' },
      actions: ['follow_up', 'open_pr', 'dismiss'],
      action: {
        type: 'external_link', label: 'Open pull request', href: 'https://github.com/integry/propr/pull/1724',
      },
    });
    vi.mocked(listNotifications).mockResolvedValue({ notifications: [notification], unreadCount: 1, nextCursor: null });
    vi.mocked(postTaskFollowup).mockRejectedValue(new Error('GitHub unavailable'));
    renderInbox();

    const link = await screen.findByRole('link', { name: /Fix run completed for PR #1724/ });
    expect(link).toHaveAttribute('href', 'https://github.com/integry/propr/pull/1724');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByRole('button', { name: 'Send /review to PR #1724' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Send /ultrafix to PR #1724' }));

    await waitFor(() => expect(postTaskFollowup).toHaveBeenCalledWith('task-fix', '/ultrafix', 'pull_request'));
    expect(await screen.findByText(/Couldn't send \/ultrafix to PR #1724.*GitHub unavailable/)).toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'Fix run completed for PR #1724' })).toBeInTheDocument();
    expect(dismissNotification).not.toHaveBeenCalled();
  });

  test('expands a system notification in place instead of navigating', async () => {
    const notification = item('event-system', 'System component unhealthy: redis', null, {
      kind: 'system_failure',
      target: { type: 'system_failure', component: 'redis' },
    });
    vi.mocked(listNotifications).mockResolvedValue({ notifications: [notification], unreadCount: 1, nextCursor: null });
    vi.mocked(markNotificationRead).mockResolvedValue({ notification, unreadCount: 0 });
    renderInbox();

    fireEvent.click(await screen.findByRole('button', { name: /System/ }));
    const card = screen.getByRole('button', { name: /System component unhealthy: redis/, expanded: false });
    fireEvent.click(card);
    expect(card).toHaveAttribute('aria-expanded', 'true');
    expect(markNotificationRead).toHaveBeenCalledWith('event-system');
  });

  test('optimistically dismisses and restores an item advertising dismiss when the request fails', async () => {
    const notification = item('event-1', 'Task one failed', null, { actions: ['dismiss'] });
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

  test('dismisses silently without an undo toast', async () => {
    const notification = item('event-silent', 'Kick this out');
    vi.mocked(listNotifications).mockResolvedValue({ notifications: [notification], unreadCount: 1, nextCursor: null });
    vi.mocked(dismissNotification).mockResolvedValue({
      notification: notificationSchema.parse({
        ...notification,
        dismissedAt: '2026-08-24T12:01:00.000Z',
      }),
      unreadCount: 0,
    });
    renderInbox();

    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss Kick this out' }));
    expect(screen.queryByText('Kick this out')).not.toBeInTheDocument();
    await waitFor(() => expect(commitUnreadCount).toHaveBeenCalledWith(0));
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
    expect(screen.queryByText(/dismissed/i)).not.toBeInTheDocument();
  });

  test('does not reinsert a dismissed notification when an older refresh finishes afterward', async () => {
    const notification = item('event-refresh-race', 'Stay dismissed');
    const staleRefresh = deferred<Awaited<ReturnType<typeof listNotifications>>>();
    vi.mocked(listNotifications)
      .mockResolvedValueOnce({ notifications: [notification], unreadCount: 1, nextCursor: null })
      .mockReturnValueOnce(staleRefresh.promise);
    vi.mocked(dismissNotification).mockResolvedValue({
      notification: notificationSchema.parse({
        ...notification,
        dismissedAt: '2026-08-24T12:01:00.000Z',
      }),
      unreadCount: 0,
    });
    renderInbox();

    await screen.findByText('Stay dismissed');
    fireEvent.focus(window);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Stay dismissed' }));
    await waitFor(() => expect(dismissNotification).toHaveBeenCalledWith('event-refresh-race'));

    await act(async () => staleRefresh.resolve({ notifications: [notification], unreadCount: 1, nextCursor: null }));
    expect(screen.queryByText('Stay dismissed')).not.toBeInTheDocument();
  });

  test('swipes a card out in either direction past the threshold without extra affordances', async () => {
    const first = item('event-swipe-right', 'Swipe right');
    const second = item('event-swipe-left', 'Swipe left');
    const short = item('event-swipe-short', 'Short swipe');
    vi.mocked(listNotifications).mockResolvedValue({ notifications: [first, second, short], unreadCount: 3, nextCursor: null });
    vi.mocked(dismissNotification).mockImplementation(async id => ({
      notification: [first, second].find(candidate => candidate.id === id)!,
      unreadCount: 1,
    }));
    renderInbox();

    const swipe = async (name: string, toX: number) => {
      const surface = (await screen.findByRole('article', { name })).parentElement!;
      fireEvent.pointerDown(surface, { pointerId: 1, pointerType: 'touch', clientX: 150, clientY: 20 });
      fireEvent.pointerMove(surface, { pointerId: 1, pointerType: 'touch', clientX: toX, clientY: 22 });
      expect(surface.textContent).not.toMatch(/Release|Dismiss/);
      fireEvent.pointerUp(surface, { pointerId: 1, pointerType: 'touch', clientX: toX, clientY: 22 });
    };

    await swipe('Swipe right', 270);
    await swipe('Swipe left', 30);
    await swipe('Short swipe', 200);

    expect(screen.queryByText('Swipe right')).not.toBeInTheDocument();
    expect(screen.queryByText('Swipe left')).not.toBeInTheDocument();
    expect(screen.getByText('Short swipe')).toBeInTheDocument();
    await waitFor(() => expect(dismissNotification).toHaveBeenCalledTimes(2));
    expect(dismissNotification).not.toHaveBeenCalledWith('event-swipe-short');
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });

  test('confirms and clears all notifications, including unloaded pages', async () => {
    const first = item('event-1', 'First task');
    const second = item('event-2', 'Second task');
    vi.mocked(listNotifications).mockResolvedValue({
      notifications: [first, second],
      unreadCount: 8,
      nextCursor: 'cursor-with-more-items',
    });
    const clearRequest = deferred<Awaited<ReturnType<typeof dismissAllNotifications>>>();
    vi.mocked(dismissAllNotifications).mockReturnValue(clearRequest.promise);
    renderInbox();

    const clearAll = await screen.findByRole('button', { name: 'Clear all' });
    fireEvent.click(clearAll);
    expect(screen.getByRole('dialog', { name: 'Clear all notifications?' })).toHaveTextContent(/including ones not loaded yet/);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(dismissAllNotifications).not.toHaveBeenCalled();

    fireEvent.click(clearAll);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(dismissAllNotifications).not.toHaveBeenCalled();

    fireEvent.click(clearAll);
    fireEvent.click(screen.getByRole('button', { name: 'Clear Inbox' }));
    expect(dismissAllNotifications).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(clearAll).toBeDisabled());
    await act(async () => clearRequest.resolve({ unreadCount: 0 }));

    expect(await screen.findByText('You’re all caught up')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
    expect(screen.getByText('All notifications cleared.')).toBeInTheDocument();
    expect(commitUnreadCount).toHaveBeenCalledWith(0);
    expect(refreshUnreadCount).toHaveBeenCalledTimes(1);
  });

  test('keeps notifications visible when clearing the Inbox fails', async () => {
    const notification = item('event-1', 'Task remains visible');
    vi.mocked(listNotifications).mockResolvedValue({
      notifications: [notification], unreadCount: 1, nextCursor: null,
    });
    vi.mocked(dismissAllNotifications).mockRejectedValue(new Error('Network unavailable'));
    renderInbox();

    fireEvent.click(await screen.findByRole('button', { name: 'Clear all' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear Inbox' }));

    expect(await screen.findByText(/Couldn't clear the Inbox.*Network unavailable/)).toBeInTheDocument();
    expect(screen.getByText('Task remains visible')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear all' })).toBeEnabled();
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
      createdAt: '2026-08-24T12:05:00.000Z',
      action: { type: 'external_link', label: 'Open pull request', href: 'https://github.com/integry/propr/pull/1937' },
    });
    const staleRefresh = deferred<Awaited<ReturnType<typeof listNotifications>>>();
    vi.mocked(listNotifications)
      .mockResolvedValueOnce({ notifications: [notification], unreadCount: 1, nextCursor: null })
      .mockReturnValueOnce(staleRefresh.promise);
    vi.mocked(markNotificationRead).mockResolvedValue({
      notification: notificationSchema.parse({
        ...notification,
        readAt: '2026-08-24T12:06:00.000Z',
      }),
      unreadCount: 0,
    });
    renderInbox();

    await screen.findByText('Read race notification');
    commitUnreadCount.mockClear();
    fireEvent.focus(window);
    await waitFor(() => expect(listNotifications).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('link', { name: /Read race notification/ }));
    await waitFor(() => expect(markNotificationRead).toHaveBeenCalledWith('event-read-race'));
    await act(async () => staleRefresh.resolve({ notifications: [notification], unreadCount: 9, nextCursor: null }));

    await waitFor(() => expect(screen.queryByRole('img', { name: /^Unread/ })).not.toBeInTheDocument());
    expect(commitUnreadCount).not.toHaveBeenCalledWith(9);
  });

  test('keeps the header minimal and refreshes automatically without dropping loaded pages', async () => {
    const first = item('event-first', 'First page item', null, { occurredAt: '2026-08-24T12:02:00.000Z', createdAt: '2026-08-24T12:02:00.000Z' });
    const older = item('event-older', 'Older page item', null, { occurredAt: '2026-08-24T11:00:00.000Z', createdAt: '2026-08-24T11:00:00.000Z' });
    const newest = item('event-newest', 'Newest item', null, { occurredAt: '2026-08-24T12:30:00.000Z', createdAt: '2026-08-24T12:30:00.000Z' });
    vi.mocked(listNotifications)
      .mockResolvedValueOnce({ notifications: [first], unreadCount: 1, nextCursor: 'cursor-1' })
      .mockResolvedValueOnce({ notifications: [older], unreadCount: 2, nextCursor: null })
      .mockResolvedValueOnce({ notifications: [newest, first], unreadCount: 3, nextCursor: 'cursor-new' });
    renderInbox();

    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    await screen.findByText('Older page item');
    expect(screen.queryByRole('button', { name: /Refresh/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear all' })).toHaveTextContent('Clear all');
    expect(screen.queryByText(/in one place/)).not.toBeInTheDocument();

    fireEvent.focus(window);
    await screen.findByText('Newest item');
    expect(screen.getAllByRole('article').map(article => article.getAttribute('aria-label'))).toEqual([
      'Newest item',
      'First page item',
      'Older page item',
    ]);
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  test('drops loaded cards the server dismissed when refreshing after load more', async () => {
    const at = (minute: number) => `2026-08-24T12:${String(minute).padStart(2, '0')}:00.000Z`;
    const kept = item('event-kept', 'Still active', null, { occurredAt: at(30), createdAt: at(30) });
    const closed = item('event-closed', 'PR closed elsewhere', null, { occurredAt: at(20), createdAt: at(20) });
    const boundary = item('event-boundary', 'Page boundary', null, { occurredAt: at(10), createdAt: at(10) });
    const older = item('event-older', 'Older page item', null, { occurredAt: at(1), createdAt: at(1) });
    vi.mocked(listNotifications)
      .mockResolvedValueOnce({ notifications: [kept, closed, boundary], unreadCount: 4, nextCursor: 'cursor-1' })
      .mockResolvedValueOnce({ notifications: [older], unreadCount: 4, nextCursor: 'cursor-2' })
      .mockResolvedValueOnce({ notifications: [kept, boundary], unreadCount: 3, nextCursor: 'cursor-new' })
      .mockResolvedValueOnce({ notifications: [kept], unreadCount: 1, nextCursor: null });
    renderInbox();

    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    await screen.findByText('Older page item');
    fireEvent.focus(window);
    await waitFor(() => expect(screen.queryByText('PR closed elsewhere')).not.toBeInTheDocument());
    expect(screen.getAllByRole('article').map(article => article.getAttribute('aria-label'))).toEqual([
      'Still active',
      'Page boundary',
      'Older page item',
    ]);
    expect(screen.getByRole('button', { name: 'Load more' })).toBeInTheDocument();

    fireEvent.focus(window);
    await waitFor(() => expect(screen.getAllByRole('article')).toHaveLength(1));
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  test('refreshes in the background without disabling Clear all or hiding the error', async () => {
    const notification = item('event-1', 'Loaded item');
    const refreshRequest = deferred<Awaited<ReturnType<typeof listNotifications>>>();
    vi.mocked(listNotifications)
      .mockResolvedValueOnce({ notifications: [notification], unreadCount: 1, nextCursor: 'cursor-1' })
      .mockRejectedValueOnce(new Error('Page failed'))
      .mockReturnValueOnce(refreshRequest.promise);
    renderInbox();

    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Page failed');
    fireEvent.focus(window);
    expect(screen.getByRole('button', { name: 'Clear all' })).toBeEnabled();
    expect(screen.getByRole('alert')).toHaveTextContent('Page failed');
    await act(async () => refreshRequest.resolve({ notifications: [notification], unreadCount: 1, nextCursor: 'cursor-1' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
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
    fireEvent.focus(window);
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

  test('looks past a first page of only system notifications until activity appears', async () => {
    const indexing = (id: string) => item(id, `Indexed ${id}`, null, {
      kind: 'indexing',
      severity: 'info',
      target: { type: 'indexing', repository: 'integry/propr' },
    });
    const activity = item('event-task', 'Actual activity');
    vi.mocked(listNotifications)
      .mockResolvedValueOnce({ notifications: [indexing('index-1'), indexing('index-2')], unreadCount: 99, nextCursor: 'cursor-1' })
      .mockResolvedValueOnce({ notifications: [indexing('index-3')], unreadCount: 99, nextCursor: 'cursor-2' })
      .mockResolvedValueOnce({ notifications: [activity], unreadCount: 100, nextCursor: 'cursor-3' });
    renderInbox();

    expect(await screen.findByRole('article', { name: 'Actual activity' })).toBeInTheDocument();
    expect(listNotifications).toHaveBeenCalledTimes(3);
    expect(listNotifications).toHaveBeenNthCalledWith(1, { limit: 25 });
    expect(listNotifications).toHaveBeenNthCalledWith(2, { cursor: 'cursor-1', limit: 25 });
    expect(listNotifications).toHaveBeenNthCalledWith(3, { cursor: 'cursor-2', limit: 25 });
    expect(screen.getByRole('button', { name: /System/ })).toHaveTextContent('3');
    expect(commitUnreadCount).toHaveBeenLastCalledWith(100);
    expect(screen.getByRole('button', { name: 'Load more' })).toBeInTheDocument();
  });

  test('keeps loading more past consecutive system-only pages until activity appears', async () => {
    const failure = (id: string) => item(id, `Failure ${id}`, null, {
      kind: 'system_failure',
      target: { type: 'system_failure', component: 'dispatcher' },
    });
    vi.mocked(listNotifications)
      .mockResolvedValueOnce({ notifications: [item('event-first', 'First task')], unreadCount: 5, nextCursor: 'cursor-1' })
      .mockResolvedValueOnce({ notifications: [failure('failure-1')], unreadCount: 5, nextCursor: 'cursor-2' })
      .mockResolvedValueOnce({ notifications: [failure('failure-2')], unreadCount: 5, nextCursor: 'cursor-3' })
      .mockResolvedValueOnce({ notifications: [item('event-older', 'Older task')], unreadCount: 6, nextCursor: 'cursor-4' });
    renderInbox();

    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('article', { name: 'Older task' })).toBeInTheDocument();
    expect(listNotifications).toHaveBeenCalledTimes(4);
    expect(listNotifications).toHaveBeenLastCalledWith({ cursor: 'cursor-3', limit: 25 });
    expect(commitUnreadCount).toHaveBeenLastCalledWith(6);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Load more' })).toBeEnabled());

    vi.mocked(listNotifications).mockResolvedValueOnce({ notifications: [], unreadCount: 6, nextCursor: null });
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(listNotifications).toHaveBeenLastCalledWith({ cursor: 'cursor-4', limit: 25 }));
  });

  test('keeps loading more past overlapping activity that is already loaded', async () => {
    const failure = (id: string) => item(id, `Failure ${id}`, null, {
      kind: 'system_failure',
      target: { type: 'system_failure', component: 'dispatcher' },
    });
    const first = item('event-first', 'First task');
    vi.mocked(listNotifications)
      .mockResolvedValueOnce({ notifications: [first], unreadCount: 5, nextCursor: 'cursor-1' })
      .mockResolvedValueOnce({ notifications: [first, failure('failure-1')], unreadCount: 5, nextCursor: 'cursor-2' })
      .mockResolvedValueOnce({ notifications: [item('event-older', 'Older task')], unreadCount: 6, nextCursor: 'cursor-3' });
    renderInbox();

    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('article', { name: 'Older task' })).toBeInTheDocument();
    expect(listNotifications).toHaveBeenCalledTimes(3);
    expect(listNotifications).toHaveBeenLastCalledWith({ cursor: 'cursor-2', limit: 25 });
    expect(screen.getAllByRole('article', { name: 'First task' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: /System/ })).toHaveTextContent('1');
  });

  test('stops looking ahead after four pages of only system notifications', async () => {
    let page = 0;
    vi.mocked(listNotifications).mockImplementation(async () => {
      page += 1;
      return {
        notifications: [item(`failure-${page}`, `Failure ${page}`, null, {
          kind: 'system_failure',
          target: { type: 'system_failure', component: 'dispatcher' },
        })],
        unreadCount: 99,
        nextCursor: `cursor-${page}`,
      };
    });
    renderInbox();

    const loadMore = await screen.findByRole('button', { name: 'Load more' });
    expect(listNotifications).toHaveBeenCalledTimes(4);
    expect(screen.getByRole('button', { name: /System/ })).toHaveTextContent('4');

    fireEvent.click(loadMore);
    await waitFor(() => expect(listNotifications).toHaveBeenCalledTimes(8));
    await waitFor(() => expect(screen.getByRole('button', { name: /System/ })).toHaveTextContent('8'));
    expect(listNotifications).toHaveBeenLastCalledWith({ cursor: 'cursor-7', limit: 25 });
    expect(screen.getByRole('button', { name: 'Load more' })).toBeEnabled();
  });

  test('keeps pages already read when a lookahead page fails and retries it manually', async () => {
    const failure = (id: string) => item(id, `Failure ${id}`, null, {
      kind: 'system_failure',
      target: { type: 'system_failure', component: 'dispatcher' },
    });
    vi.mocked(listNotifications)
      .mockResolvedValueOnce({ notifications: [failure('failure-1')], unreadCount: 9, nextCursor: 'cursor-1' })
      .mockResolvedValueOnce({ notifications: [failure('failure-2')], unreadCount: 9, nextCursor: 'cursor-2' })
      .mockRejectedValueOnce(new Error('Lookahead failed'));
    renderInbox();

    expect(await screen.findByRole('alert')).toHaveTextContent('Lookahead failed');
    expect(screen.getByRole('button', { name: /System/ })).toHaveTextContent('2');
    expect(commitUnreadCount).toHaveBeenLastCalledWith(9);

    vi.mocked(listNotifications).mockResolvedValueOnce({
      notifications: [item('event-older', 'Older task')],
      unreadCount: 10,
      nextCursor: null,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('article', { name: 'Older task' })).toBeInTheDocument();
    expect(listNotifications).toHaveBeenLastCalledWith({ cursor: 'cursor-2', limit: 25 });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('keeps load-more pages already read when a later lookahead page fails', async () => {
    const failure = (id: string) => item(id, `Failure ${id}`, null, {
      kind: 'system_failure',
      target: { type: 'system_failure', component: 'dispatcher' },
    });
    vi.mocked(listNotifications)
      .mockResolvedValueOnce({ notifications: [item('event-first', 'First task')], unreadCount: 5, nextCursor: 'cursor-1' })
      .mockResolvedValueOnce({ notifications: [failure('failure-1')], unreadCount: 5, nextCursor: 'cursor-2' })
      .mockRejectedValueOnce(new Error('Lookahead failed'));
    renderInbox();

    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Lookahead failed');
    expect(screen.getByRole('button', { name: /System/ })).toHaveTextContent('1');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Load more' })).toBeEnabled());

    vi.mocked(listNotifications).mockResolvedValueOnce({ notifications: [], unreadCount: 5, nextCursor: null });
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(listNotifications).toHaveBeenLastCalledWith({ cursor: 'cursor-2', limit: 25 }));
  });

  test('keeps looking ahead past activity hidden by a pending dismissal', async () => {
    const indexing = (id: string) => item(id, `Indexed ${id}`, null, {
      kind: 'indexing',
      severity: 'info',
      target: { type: 'indexing', repository: 'integry/propr' },
    });
    const dismissed = item('event-dismissed', 'Dismissed task');
    const dismissal = deferred<Awaited<ReturnType<typeof dismissNotification>>>();
    vi.mocked(dismissNotification).mockReturnValueOnce(dismissal.promise);
    vi.mocked(listNotifications)
      .mockResolvedValueOnce({ notifications: [dismissed, indexing('index-1')], unreadCount: 2, nextCursor: 'cursor-1' })
      .mockResolvedValueOnce({ notifications: [dismissed, indexing('index-1')], unreadCount: 2, nextCursor: 'cursor-1' })
      .mockResolvedValueOnce({ notifications: [item('event-visible', 'Visible task')], unreadCount: 2, nextCursor: null });
    renderInbox();

    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss Dismissed task' }));
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Dismissed task' })).not.toBeInTheDocument());
    fireEvent.focus(window);

    expect(await screen.findByRole('article', { name: 'Visible task' })).toBeInTheDocument();
    expect(listNotifications).toHaveBeenCalledTimes(3);
    expect(listNotifications).toHaveBeenLastCalledWith({ cursor: 'cursor-1', limit: 25 });
    expect(screen.queryByRole('article', { name: 'Dismissed task' })).not.toBeInTheDocument();
    await act(async () => dismissal.resolve({ unreadCount: 1 } as Awaited<ReturnType<typeof dismissNotification>>));
  });

  test('advances the cursor when a refresh looks ahead past the loaded pages', async () => {
    const at = (minute: number) => `2026-08-24T12:${String(minute).padStart(2, '0')}:00.000Z`;
    const indexing = (id: string, minute: number) => item(id, `Indexed ${id}`, null, {
      kind: 'indexing',
      severity: 'info',
      target: { type: 'indexing', repository: 'integry/propr' },
      occurredAt: at(minute),
      createdAt: at(minute),
    });
    const activity = item('event-task', 'Only activity', null, { occurredAt: at(40), createdAt: at(40) });
    vi.mocked(dismissNotification).mockResolvedValueOnce(
      { unreadCount: 0 } as Awaited<ReturnType<typeof dismissNotification>>,
    );
    vi.mocked(listNotifications)
      .mockResolvedValueOnce({ notifications: [indexing('index-1', 50)], unreadCount: 2, nextCursor: 'cursor-1' })
      .mockResolvedValueOnce({ notifications: [activity], unreadCount: 2, nextCursor: 'cursor-2' })
      .mockResolvedValueOnce({ notifications: [indexing('index-1', 50)], unreadCount: 1, nextCursor: 'cursor-1' })
      .mockResolvedValueOnce({ notifications: [activity], unreadCount: 1, nextCursor: 'cursor-2' })
      .mockResolvedValueOnce({ notifications: [indexing('index-3', 30)], unreadCount: 1, nextCursor: 'cursor-3' })
      .mockResolvedValueOnce({ notifications: [indexing('index-4', 20)], unreadCount: 1, nextCursor: 'cursor-4' });
    renderInbox();

    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss Only activity' }));
    await waitFor(() => expect(dismissNotification).toHaveBeenCalledWith('event-task'));
    await waitFor(() => expect(refreshUnreadCount).toHaveBeenCalled());
    fireEvent.focus(window);

    await waitFor(() => expect(listNotifications).toHaveBeenCalledTimes(6));
    await waitFor(() => expect(screen.getByRole('button', { name: /System/ })).toHaveTextContent('3'));
    expect(listNotifications).toHaveBeenLastCalledWith({ cursor: 'cursor-3', limit: 25 });

    vi.mocked(listNotifications).mockResolvedValueOnce({ notifications: [], unreadCount: 1, nextCursor: null });
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(listNotifications).toHaveBeenCalledTimes(7));
    expect(listNotifications).toHaveBeenLastCalledWith({ cursor: 'cursor-4', limit: 25 });
  });

  test('keeps demo Inbox navigation read-only and hides dismissal', async () => {
    demoState.isDemoMode = true;
    const notification = item('event-demo', 'Demo notification');
    vi.mocked(listNotifications).mockResolvedValue({ notifications: [notification], unreadCount: 1, nextCursor: null });
    renderInbox();

    expect(await screen.findByText('Demo notification')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Dismiss Demo notification' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: /Demo notification/ }));

    expect(await screen.findByText('Task details')).toBeInTheDocument();
    expect(markNotificationRead).not.toHaveBeenCalled();
    expect(dismissNotification).not.toHaveBeenCalled();
  });
});
