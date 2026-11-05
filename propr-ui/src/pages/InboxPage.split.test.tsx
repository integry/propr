/* eslint-disable max-lines */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { notificationSchema, type ActivityUpdatePayload, type Notification } from '@propr/shared';
import { ToastProvider } from '../components/ui/Toast';
import InboxPage from './InboxPage';
import { dismissNotification, listNotifications, markNotificationRead } from '../api/notificationApi';
import { getFileChanges } from '../api/fileChangesApi';
import { getTaskHistory, getTasks, postTaskFollowup } from '../api/proprApi';
import { resetFollowupSubmissions } from '../components/Inbox/followupSubmissions';
import { MAX_SELECTION_LOOKUP_READS } from './Inbox/useInboxTriage';

vi.mock('../contexts/NotificationCenterContext', () => ({
  useNotificationCenter: () => ({
    unreadCount: 3,
    commitUnreadCount: vi.fn(),
    refreshUnreadCount: vi.fn(async () => undefined),
    isActiveIdentity: () => true,
  }),
}));
vi.mock('../api/notificationApi', () => ({
  listNotifications: vi.fn(),
  dismissAllNotifications: vi.fn(),
  dismissNotification: vi.fn(),
  markNotificationRead: vi.fn(),
}));
vi.mock('../api/fileChangesApi', () => ({ getFileChanges: vi.fn() }));
vi.mock('../api/proprApi', () => ({ postTaskFollowup: vi.fn(), getTasks: vi.fn(), getTaskHistory: vi.fn() }));
vi.mock('../contexts/DemoModeContext', () => ({ useDemoMode: () => ({ isDemoMode: false }) }));
const activitySocket = vi.hoisted(() => {
  const callbacks = new Set<(payload: ActivityUpdatePayload) => void>();
  return {
    callbacks,
    onActivityUpdate: (callback: (payload: ActivityUpdatePayload) => void) => {
      callbacks.add(callback);
      return () => { callbacks.delete(callback); };
    },
    subscribeToActivity: () => undefined,
    unsubscribeFromActivity: () => undefined,
  };
});
vi.mock('../contexts/useSocket', () => ({
  useSocket: () => ({ isConnected: true, onNotificationUpdate: () => () => undefined }),
  useOptionalSocket: () => activitySocket,
}));

/** Delivers an `activity:update` for a task the way the server publishes it. */
async function pushTaskActivity(change: ActivityUpdatePayload['change'], repository: string) {
  await act(async () => {
    activitySocket.callbacks.forEach(callback => callback({
      eventType: 'activity:update', domain: 'task', change, repository, subjectId: 'task-3058', occurredAt: at(0),
    } as ActivityUpdatePayload));
  });
}
// The verdict card must never be the task workbench; if anything mounts it, this says so.
vi.mock('../components/TaskDetails', () => ({
  default: () => <div data-testid="task-details">TaskDetails</div>,
}));

const at = (minutes: number) => new Date(Date.parse('2026-10-13T10:00:00.000Z') - minutes * 60_000).toISOString();

function item(id: string, minutes: number, overrides: Record<string, unknown>): Notification {
  return notificationSchema.parse({
    id,
    deduplicationKey: `${id}-key`,
    severity: 'success',
    title: id,
    body: '',
    occurredAt: at(minutes),
    createdAt: at(minutes),
    readAt: at(0),
    dismissedAt: null,
    actions: ['follow_up', 'open_pr', 'dismiss'],
    ...overrides,
  });
}

const review = item('review-3057', 18, {
  kind: 'review',
  target: { type: 'review', repository: 'integry/propr', prNumber: 3057, taskId: 'task-3057' },
  title: 'Draft validation: integrate Linux fixes',
  body: 'Score 6/10 · 2 issues found: packages/cli/test/model.test.ts:42 Uncaught layout expectation; Clear expiry feedback',
  action: { type: 'external_link', label: 'Open pull request', href: 'https://github.com/integry/propr/pull/3057' },
});
const ready = item('ready-3063', 20, {
  kind: 'pull_request', severity: 'info',
  target: { type: 'pull_request', repository: 'integry/propr', prNumber: 3063 },
  metadata: { completedImplementationTaskId: 'task-3063' },
  title: 'Mobile footer and menu redesign',
  body: '1 preview available',
});
const failed = item('failed-3049', 28, {
  kind: 'task', severity: 'error',
  target: { type: 'task', repository: 'integry/propr', taskId: 'task-3049', issueNumber: 3049 },
  title: 'GraphQL denied issue creation',
  body: 'Work did not complete.',
  actions: ['dismiss'],
});
const queue = [review, ready, failed];

// Each notification's run is its task's newest, so its commands are offered.
const newestRuns: Record<string, Record<string, unknown>> = {
  'task-3057': { title: 'Review PR #3057: Draft validation', prNumber: 3057 },
  'task-3063': { title: 'Implement PR #3063: Mobile footer', prNumber: 3063 },
  'task-3049': { title: 'Implement issue #3049', issueNumber: 3049 },
};
const taskRun = (id: string, minutes: number, fields: Record<string, unknown> = {}) => ({
  id, repository: 'integry/propr', status: 'completed', createdAt: at(minutes), commitHash: null, ...fields,
});

const Location = () => <output data-testid="location">{useLocation().search}</output>;
const search = () => new URLSearchParams(screen.getByTestId('location').textContent ?? '');

function renderInbox(entry = '/inbox') {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/inbox" element={<><InboxPage /><Location /></>} />
          <Route path="/tasks/:id" element={<div>Task page</div>} />
          <Route path="/studio/:draftId" element={<div>Plan studio</div>} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  );
}

function mockViewport(wide: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: wide, media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  }));
}

const row = (title: string) => within(screen.getByRole('article', { name: title })).getByRole('link', { name: title });
const pane = () => screen.queryByRole('region', { name: 'Triage verdict' });

describe('Inbox triage console', () => {
  beforeEach(() => {
    vi.mocked(getTasks).mockImplementation(async options => {
      const id = (options as { task: string }).task;
      return { tasks: [taskRun(id, 1, newestRuns[id])] } as never;
    });
    vi.mocked(listNotifications).mockResolvedValue({ notifications: queue, unreadCount: 0, nextCursor: null });
    vi.mocked(getTaskHistory).mockResolvedValue({ history: [] });
    vi.mocked(dismissNotification).mockImplementation(async id => ({
      notification: { ...queue.find(entry => entry.id === id)!, dismissedAt: at(0) } as Notification, unreadCount: 0,
    }));
    vi.mocked(getFileChanges).mockResolvedValue({
      taskId: 'task-3057', lastUpdated: at(0),
      files: [{
        path: 'packages/cli/test/model.test.ts', status: 'modified', linesAdded: 1, linesRemoved: 1,
        diff: "--- a/x\n+++ b/x\n@@ -42 +42 @@\n-expect(model).toBe('default');\n+expect(model).toBe('claude-opus-5.5');",
      }],
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    resetFollowupSubmissions();
  });

  test('keeps the queue full width until a row is selected', async () => {
    mockViewport(true);
    renderInbox();
    await screen.findByRole('article', { name: review.title });
    expect(screen.getByTestId('inbox-split-workspace')).toBeInTheDocument();
    expect(pane()).not.toBeInTheDocument();
  });

  test('a click opens the verdict beside the queue and writes ?notification= without a list read', async () => {
    mockViewport(true);
    renderInbox('/inbox?repository=integry%2Fpropr');
    await screen.findByRole('article', { name: review.title });
    expect(listNotifications).toHaveBeenCalledTimes(1);
    fireEvent.click(row(review.title));

    expect(search().get('notification')).toBe(review.id);
    expect(search().get('repository')).toBe('integry/propr');
    expect(row(review.title)).toHaveAttribute('aria-current', 'true');
    const card = within(pane()!);
    expect(card.getByRole('heading', { name: /Review verdict: 2 findings \(Score 6\/10\)/ })).toBeInTheDocument();
    expect(card.getByText('packages/cli/test/model.test.ts:42')).toBeInTheDocument();
    expect(card.getByText('Uncaught layout expectation')).toBeInTheDocument();
    expect(card.getByText('Clear expiry feedback')).toBeInTheDocument();
    expect(card.queryByText(/more findings? in Tasks/)).not.toBeInTheDocument();
    expect(card.getByRole('link', { name: 'PR #3057 on GitHub' })).toHaveAttribute('href', 'https://github.com/integry/propr/pull/3057');
    expect(card.getByRole('link', { name: /Inspect in Tasks/ })).toHaveAttribute('href', '/tasks/task-3057');
    expect(await card.findByRole('button', { name: 'Send /fix to PR #3057' })).toBeInTheDocument();
    expect(await card.findByText(/claude-opus-5\.5/)).toBeInTheDocument();
    expect(getFileChanges).toHaveBeenCalledTimes(1);
    expect(getFileChanges).toHaveBeenCalledWith('task-3057');
    expect(screen.queryByTestId('task-details')).not.toBeInTheDocument();
    expect(listNotifications).toHaveBeenCalledTimes(1);
  });

  test('a plan opens its destination directly, and a selection the queue never holds is dropped from the URL', async () => {
    mockViewport(true);
    const plan = item('plan-1', 30, {
      kind: 'plan', target: { type: 'plan', repository: 'integry/propr', draftId: 'draft-1' },
      title: 'Improve the Inbox', body: 'Ready for review with 4 planned tasks.', actions: ['dismiss'],
    });
    vi.mocked(listNotifications).mockResolvedValue({ notifications: [...queue, plan], unreadCount: 0, nextCursor: null });
    renderInbox('/inbox?notification=plan-1&repository=integry%2Fpropr');
    await screen.findByRole('article', { name: plan.title });
    await waitFor(() => expect(search().get('notification')).toBeNull());
    expect(search().get('repository')).toBe('integry/propr');
    expect(pane()).not.toBeInTheDocument();

    const link = row(plan.title);
    expect(link).toHaveAttribute('href', '/studio/draft-1');
    fireEvent.click(link);
    expect(await screen.findByText('Plan studio')).toBeInTheDocument();
    expect(getFileChanges).not.toHaveBeenCalled();
  });

  test('a task row stays a real link: a modified click is left to the browser, a plain one opens the verdict', async () => {
    mockViewport(true);
    renderInbox();
    await screen.findByRole('article', { name: review.title });
    const link = row(review.title);
    expect(link).toHaveAttribute('href', '/tasks/task-3057');
    // The browser opens a modified click in a new tab: nothing prevents it, and no verdict opens here.
    expect(fireEvent.click(link, { ctrlKey: true })).toBe(true);
    expect(search().get('notification')).toBeNull();
    expect(pane()).not.toBeInTheDocument();
    fireEvent.click(link);
    expect(search().get('notification')).toBe(review.id);
  });

  test('the verdict heading counts every issue the recap reports, not just the titles it lists', async () => {
    mockViewport(true);
    const truncated = item('review-2519', 32, {
      kind: 'review', target: { type: 'review', repository: 'integry/propr', prNumber: 2519, taskId: 'task-2519' },
      title: 'Retry webhook deliveries', body: 'Score 3/10 · 4 issues found: Retries never back off; Delivery ids are reused',
    });
    vi.mocked(listNotifications).mockResolvedValue({ notifications: [...queue, truncated], unreadCount: 0, nextCursor: null });
    renderInbox('/inbox?notification=review-2519');
    const card = within(await screen.findByRole('region', { name: 'Triage verdict' }));
    expect(card.getByRole('heading', { name: 'Review verdict: 4 findings (Score 3/10)' })).toBeInTheDocument();
    expect(card.getAllByRole('listitem')).toHaveLength(2);
    expect(card.getByText('2 more findings in Tasks')).toBeInTheDocument();
  });

  test("the verdict shows the run's full summary from its history, then every visual preview", async () => {
    mockViewport(true);
    const asset = (id: string) => `https://github.com/user-attachments/assets/${id}`;
    vi.mocked(getTaskHistory).mockResolvedValue({
      history: [
        { state: 'claude_execution', metadata: {} },
        { state: 'completed', metadata: { prResult: {
          notificationRecap: 'Redesigned the mobile footer…',
          notificationSummary: 'Redesigned the mobile footer and menu.\n\n- The footer keeps its links on one row\n- The menu closes on Escape',
        } } },
      ],
      previewMedia: [
        { type: 'image', title: 'Footer at Mobile 390px', url: asset('footer') },
        { type: 'image', title: 'Menu at Desktop 1440px', url: asset('menu') },
      ],
    });
    renderInbox(`/inbox?notification=${ready.id}`);
    const card = within(await screen.findByRole('region', { name: 'Triage verdict' }));
    const summary = await card.findByTestId('triage-summary');
    expect(getTaskHistory).toHaveBeenCalledWith('task-3063');
    expect(card.getByRole('heading', { name: 'Summary' })).toBeInTheDocument();
    expect(within(summary).getByText('The footer keeps its links on one row')).toBeInTheDocument();
    expect(within(summary).getByText('The menu closes on Escape')).toBeInTheDocument();
    expect(card.queryByText('1 preview available')).not.toBeInTheDocument();
    const previews = card.getByRole('heading', { name: /Visual evidence/ });
    expect(previews).toHaveTextContent('(2 captures)');
    // The summary reads first, the previews after it.
    expect(summary.compareDocumentPosition(previews) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("a review's full summary replaces the abridged findings; runs without one keep the notification's verdict", async () => {
    mockViewport(true);
    vi.mocked(getTaskHistory).mockImplementation(async taskId => ({
      history: taskId === 'task-3057'
        ? [{ state: 'completed', metadata: { notificationSummary: '## Overall Evaluation\n\nThe layout test asserts the wrong default model.' } }]
        : [],
    }));
    renderInbox(`/inbox?notification=${review.id}`);
    const card = within(await screen.findByRole('region', { name: 'Triage verdict' }));
    expect(await card.findByRole('heading', { name: 'Review summary' })).toBeInTheDocument();
    expect(card.getByText('The layout test asserts the wrong default model.')).toBeInTheDocument();
    expect(card.queryByRole('heading', { name: /Review verdict/ })).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'j' });
    await waitFor(() => expect(getTaskHistory).toHaveBeenCalledWith('task-3063'));
    const next = within(pane()!);
    expect(next.getByText('1 preview available')).toBeInTheDocument();
    expect(next.queryByTestId('triage-summary')).not.toBeInTheDocument();
  });

  test('a failed diff read still shows the verdict and the buttons', async () => {
    mockViewport(true);
    vi.mocked(getFileChanges).mockRejectedValue(new Error('unavailable'));
    renderInbox(`/inbox?notification=${review.id}`);
    const card = within(await screen.findByRole('region', { name: 'Triage verdict' }));
    await waitFor(() => expect(getFileChanges).toHaveBeenCalled());
    expect(card.getByText('Uncaught layout expectation')).toBeInTheDocument();
    expect(card.getByRole('link', { name: /Inspect in Tasks/ })).toBeInTheDocument();
    expect(card.queryByText(/Visual diff/)).not.toBeInTheDocument();
  });

  test('j/k and the arrows step through the queue, Esc closes the pane, and fields keep their keys', async () => {
    mockViewport(true);
    // Flush the loaded queue's effects before sending keys: a row can appear
    // before the effect that registers the window keydown listener has run.
    await act(async () => {
      renderInbox();
    });
    await screen.findByRole('article', { name: review.title });
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(pane()).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'j' });
    // Keyboard navigation commits the URL in a React Router transition.
    await waitFor(() => expect(search().get('notification')).toBe(review.id));
    fireEvent.keyDown(window, { key: 'j' });
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    await waitFor(() => expect(search().get('notification')).toBe(failed.id));
    fireEvent.keyDown(window, { key: 'j' });
    expect(search().get('notification')).toBe(failed.id);
    fireEvent.keyDown(window, { key: 'k' });
    fireEvent.keyDown(window, { key: 'ArrowUp' });
    await waitFor(() => expect(search().get('notification')).toBe(review.id));

    const field = document.createElement('input');
    document.body.appendChild(field);
    fireEvent.keyDown(field, { key: 'j' });
    expect(search().get('notification')).toBe(review.id);
    field.remove();

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(search().get('notification')).toBeNull());
    expect(pane()).not.toBeInTheDocument();
  });

  test('dismissing opens the next item, the last one opens the previous, and an empty queue closes the pane', async () => {
    mockViewport(true);
    renderInbox(`/inbox?notification=${ready.id}`);
    await screen.findByRole('article', { name: ready.title });
    fireEvent.click(within(pane()!).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(search().get('notification')).toBe(failed.id));
    expect(screen.queryByRole('article', { name: ready.title })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: `Dismiss ${failed.title}` }));
    await waitFor(() => expect(search().get('notification')).toBe(review.id));

    fireEvent.keyDown(window, { key: 'x' });
    await waitFor(() => expect(pane()).not.toBeInTheDocument());
    expect(search().get('notification')).toBeNull();
    expect(screen.getByText('You’re all caught up')).toBeInTheDocument();
    expect(listNotifications).toHaveBeenCalledTimes(1);
  });

  test('sending a follow-up command dismisses the card and opens the next item', async () => {
    mockViewport(true);
    vi.mocked(postTaskFollowup).mockResolvedValue(undefined as never);
    renderInbox(`/inbox?notification=${review.id}`);
    await screen.findByRole('article', { name: review.title });
    const fix = await within(pane()!).findByRole('button', { name: 'Send /fix to PR #3057' });
    await act(async () => {
      fireEvent.click(fix);
    });
    expect(postTaskFollowup).toHaveBeenCalledWith('task-3057', '/fix', 'pull_request');
    await waitFor(() => expect(search().get('notification')).toBe(ready.id));
    expect(dismissNotification).toHaveBeenCalledWith(review.id);
  });

  test('a command in flight stays claimed when the selection moves away and back', async () => {
    mockViewport(true);
    let resolve: () => void = () => undefined;
    vi.mocked(postTaskFollowup).mockReturnValue(new Promise(done => { resolve = () => done({ success: true, message: 'Posted' }); }));
    renderInbox(`/inbox?notification=${review.id}`);
    await screen.findByRole('article', { name: review.title });
    fireEvent.click(await within(pane()!).findByRole('button', { name: 'Send /fix to PR #3057' }));
    await waitFor(() => expect(postTaskFollowup).toHaveBeenCalledTimes(1));

    fireEvent.click(row(ready.title));
    expect(search().get('notification')).toBe(ready.id);
    fireEvent.click(row(review.title));
    const fix = await within(pane()!).findByRole('button', { name: 'Send /fix to PR #3057' });
    expect(fix).toBeDisabled();
    fireEvent.click(fix);
    expect(postTaskFollowup).toHaveBeenCalledTimes(1);

    await act(async () => resolve());
    await waitFor(() => expect(dismissNotification).toHaveBeenCalledWith(review.id));
    expect(postTaskFollowup).toHaveBeenCalledTimes(1);
  });

  test('a dismissal that fails reopens the item it was made on', async () => {
    mockViewport(true);
    let reject: (error: Error) => void = () => undefined;
    vi.mocked(dismissNotification).mockReturnValue(new Promise((_, fail) => { reject = fail; }));
    renderInbox(`/inbox?notification=${review.id}`);
    await screen.findByRole('article', { name: review.title });
    fireEvent.click(within(pane()!).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(search().get('notification')).toBe(ready.id));

    await act(async () => reject(new Error('offline')));
    await screen.findByRole('article', { name: review.title });
    await waitFor(() => expect(search().get('notification')).toBe(review.id));
    expect(within(pane()!).getByRole('heading', { name: review.title })).toBeInTheDocument();
  });

  test('arrow keys pressed inside the verdict scroll it instead of stepping the queue', async () => {
    mockViewport(true);
    renderInbox(`/inbox?notification=${review.id}`);
    await screen.findByRole('article', { name: review.title });
    const inspect = within(pane()!).getByRole('link', { name: /Inspect in Tasks/ });
    // The queue listener attaches in an effect that can land after the article renders; k on the
    // first item is claimed without moving, so it shows the listener is live before ArrowDown is checked.
    await waitFor(() => expect(fireEvent.keyDown(inspect, { key: 'k' })).toBe(false));
    expect(search().get('notification')).toBe(review.id);
    expect(fireEvent.keyDown(inspect, { key: 'ArrowDown' })).toBe(true);
    expect(search().get('notification')).toBe(review.id);
    expect(fireEvent.keyDown(inspect, { key: 'j' })).toBe(false);
    // React Router commits URL changes in a transition, which can settle after keyDown returns.
    await waitFor(() => expect(search().get('notification')).toBe(ready.id));
    expect(within(pane()!).getByRole('heading', { name: ready.title })).toBeInTheDocument();
  });

  test("a review's diff falls back to the run it reviewed when the review itself committed nothing", async () => {
    mockViewport(true);
    vi.mocked(getFileChanges).mockImplementation(async taskId => (taskId === 'task-3057'
      ? { taskId, lastUpdated: at(0), files: [] }
      : {
        taskId, lastUpdated: at(0),
        files: [{ path: 'src/a.ts', status: 'modified', linesAdded: 1, linesRemoved: 0, diff: '@@ -1 +1,2 @@\n+const reviewed = true;' }],
      }));
    vi.mocked(getTasks).mockResolvedValue({ tasks: [
      { id: 'task-3057', repository: 'integry/propr', prNumber: 3057, status: 'completed', createdAt: at(1), commitHash: null },
      { id: 'task-3056', repository: 'integry/propr', prNumber: 3057, status: 'completed', createdAt: at(5), commitHash: null },
      { id: 'task-3055', repository: 'integry/propr', prNumber: 3057, status: 'completed', createdAt: at(9), commitHash: 'abc1234' },
    ] } as never);
    renderInbox(`/inbox?notification=${review.id}`);
    const card = within(await screen.findByRole('region', { name: 'Triage verdict' }));
    expect(await card.findByText(/const reviewed = true;/)).toBeInTheDocument();
    expect(getTasks).toHaveBeenCalledWith({ groupBy: 'task', task: 'task-3057', limit: 1, offset: 0 });
    expect(vi.mocked(getFileChanges).mock.calls.map(([taskId]) => taskId)).toEqual(['task-3057', 'task-3055']);
  });

  test('a review verdict offers /fix only while the review is still its task\'s newest run', async () => {
    mockViewport(true);
    vi.mocked(getTasks).mockResolvedValue({ tasks: [
      taskRun('task-3058', 2, { title: 'Fix PR #3057: Draft validation', prNumber: 3057 }),
      taskRun('task-3057', 18, newestRuns['task-3057']),
    ] } as never);
    renderInbox(`/inbox?notification=${review.id}`);
    const card = within(await screen.findByRole('region', { name: 'Triage verdict' }));
    await waitFor(() => expect(getTasks).toHaveBeenCalledWith({ groupBy: 'task', task: 'task-3057', limit: 1, offset: 0 }));
    // A fix has run since the review, so /fix would replay it against code that has moved on.
    await act(async () => undefined);
    expect(card.queryByRole('button', { name: /^Send \// })).not.toBeInTheDocument();
    expect(card.getByRole('link', { name: /Inspect in Tasks/ })).toHaveAttribute('href', '/tasks/task-3057');
  });

  test('a verdict sends nothing once a run started elsewhere supersedes it after it opened', async () => {
    mockViewport(true);
    renderInbox(`/inbox?notification=${review.id}`);
    const card = within(await screen.findByRole('region', { name: 'Triage verdict' }));
    const fix = await card.findByRole('button', { name: 'Send /fix to PR #3057' });
    vi.mocked(getTasks).mockResolvedValue({ tasks: [
      taskRun('task-3058', 2, { title: 'Fix PR #3057: Draft validation', prNumber: 3057 }),
      taskRun('task-3057', 18, newestRuns['task-3057']),
    ] } as never);

    await act(async () => {
      fireEvent.click(fix);
    });
    expect(await screen.findByText('/fix was not sent: newer work on PR #3057 has superseded this run.')).toBeInTheDocument();
    expect(postTaskFollowup).not.toHaveBeenCalled();
    expect(dismissNotification).not.toHaveBeenCalled();
    // The read that refused the command also withdraws it.
    expect(card.queryByRole('button', { name: /^Send \// })).not.toBeInTheDocument();
    expect(search().get('notification')).toBe(review.id);
  });

  test("a task started in the verdict's repository reads its runs again and withdraws superseded commands", async () => {
    mockViewport(true);
    renderInbox(`/inbox?notification=${review.id}`);
    const card = within(await screen.findByRole('region', { name: 'Triage verdict' }));
    await card.findByRole('button', { name: 'Send /fix to PR #3057' });
    const reads = vi.mocked(getTasks).mock.calls.length;
    vi.mocked(getTasks).mockResolvedValue({ tasks: [
      taskRun('task-3058', 0, { title: 'Fix PR #3057: Draft validation', prNumber: 3057 }),
      taskRun('task-3057', 18, newestRuns['task-3057']),
    ] } as never);

    await pushTaskActivity('created', 'integry/other');
    await pushTaskActivity('progress', 'integry/propr');
    expect(getTasks).toHaveBeenCalledTimes(reads);
    expect(card.getByRole('button', { name: 'Send /fix to PR #3057' })).toBeInTheDocument();

    await pushTaskActivity('created', 'integry/propr');
    await waitFor(() => expect(card.queryByRole('button', { name: /^Send \// })).not.toBeInTheDocument());
    expect(getTasks).toHaveBeenCalledTimes(reads + 1);
  });

  test("a review's diff falls back to the run it reviewed when its own changes cannot be read", async () => {
    mockViewport(true);
    vi.mocked(getFileChanges).mockImplementation(async taskId => {
      if (taskId === 'task-3057') throw new Error('Not found');
      return {
        taskId, lastUpdated: at(0),
        files: [{ path: 'src/a.ts', status: 'modified', linesAdded: 1, linesRemoved: 0, diff: '@@ -1 +1,2 @@\n+const reviewed = true;' }],
      };
    });
    vi.mocked(getTasks).mockResolvedValue({ tasks: [
      { id: 'task-3057', repository: 'integry/propr', prNumber: 3057, status: 'completed', createdAt: at(1), commitHash: null },
      { id: 'task-3055', repository: 'integry/propr', prNumber: 3057, status: 'completed', createdAt: at(9), commitHash: 'abc1234' },
    ] } as never);
    renderInbox(`/inbox?notification=${review.id}`);
    const card = within(await screen.findByRole('region', { name: 'Triage verdict' }));
    expect(await card.findByText(/const reviewed = true;/)).toBeInTheDocument();
    expect(vi.mocked(getFileChanges).mock.calls.map(([taskId]) => taskId)).toEqual(['task-3057', 'task-3055']);
  });

  test('the verdict offers no commands while its task\'s runs cannot be read', async () => {
    mockViewport(true);
    vi.mocked(getTasks).mockRejectedValue(new Error('unavailable'));
    renderInbox(`/inbox?notification=${review.id}`);
    const card = within(await screen.findByRole('region', { name: 'Triage verdict' }));
    expect(await card.findByText(/claude-opus-5\.5/)).toBeInTheDocument();
    expect(card.queryByRole('button', { name: /^Send \// })).not.toBeInTheDocument();
  });

  test('a selection on a page not loaded yet is looked for instead of being dropped', async () => {
    mockViewport(true);
    const older = item('review-2990', 600, {
      kind: 'review', target: { type: 'review', repository: 'integry/propr', prNumber: 2990, taskId: 'task-2990' },
      title: 'Older review on the third page', body: 'Score 5/10 · 1 issue found: Guard the cursor',
    });
    const middle = item('failed-2995', 300, {
      kind: 'task', severity: 'error',
      target: { type: 'task', repository: 'integry/propr', taskId: 'task-2995', issueNumber: 2995 },
      title: 'Second page failure', body: 'Work did not complete.', actions: ['dismiss'],
    });
    vi.mocked(listNotifications).mockImplementation(async ({ cursor } = {}) => {
      if (!cursor) return { notifications: queue, unreadCount: 0, nextCursor: 'page-2' };
      if (cursor === 'page-2') return { notifications: [middle], unreadCount: 0, nextCursor: 'page-3' };
      return { notifications: [older], unreadCount: 0, nextCursor: null };
    });
    renderInbox(`/inbox?notification=${older.id}&repository=integry%2Fpropr`);
    const card = within(await screen.findByRole('region', { name: 'Triage verdict' }));
    expect(card.getByRole('heading', { name: older.title })).toBeInTheDocument();
    expect(search().get('notification')).toBe(older.id);
    expect(search().get('repository')).toBe('integry/propr');
    expect(vi.mocked(listNotifications).mock.calls.map(([options]) => options?.cursor ?? null)).toEqual([null, 'page-2', 'page-3']);
  });

  test('a selection is dropped only once every page has been read without finding it', async () => {
    mockViewport(true);
    vi.mocked(listNotifications).mockImplementation(async ({ cursor } = {}) => (cursor
      ? { notifications: [], unreadCount: 0, nextCursor: null }
      : { notifications: queue, unreadCount: 0, nextCursor: 'page-2' }));
    renderInbox('/inbox?notification=dismissed-elsewhere');
    await screen.findByRole('article', { name: review.title });
    await waitFor(() => expect(search().get('notification')).toBeNull());
    expect(listNotifications).toHaveBeenCalledTimes(2);
    expect(pane()).not.toBeInTheDocument();
  });

  test('a selection the bounded lookup does not reach is dropped with a notice', async () => {
    mockViewport(true);
    vi.mocked(listNotifications).mockImplementation(async ({ cursor } = {}) => (cursor
      ? { notifications: [], unreadCount: 0, nextCursor: `${cursor}-next` }
      : { notifications: queue, unreadCount: 0, nextCursor: 'page-2' }));
    renderInbox('/inbox?notification=far-back');
    await screen.findByRole('article', { name: review.title });
    expect(await screen.findByText('That notification isn’t in the loaded Inbox. Load more to look further back.')).toBeInTheDocument();
    // The notice can render before the router's URL transition has committed.
    await waitFor(() => expect(search().get('notification')).toBeNull());
    expect(pane()).not.toBeInTheDocument();
    // Each Load more follows empty pages on its own; the lookup stops after its bounded number of them.
    const reads = vi.mocked(listNotifications).mock.calls.length;
    expect(reads).toBeGreaterThan(MAX_SELECTION_LOOKUP_READS);
    await act(async () => undefined);
    expect(listNotifications).toHaveBeenCalledTimes(reads);
    expect(screen.getAllByText('That notification isn’t in the loaded Inbox. Load more to look further back.')).toHaveLength(1);
  });

  test('a selection is kept while the page that would hold it fails to load', async () => {
    mockViewport(true);
    vi.mocked(listNotifications).mockImplementation(async ({ cursor } = {}) => {
      if (cursor) throw new Error('offline');
      return { notifications: queue, unreadCount: 0, nextCursor: 'page-2' };
    });
    renderInbox('/inbox?notification=review-2990');
    await screen.findByRole('article', { name: review.title });
    await waitFor(() => expect(listNotifications).toHaveBeenCalledTimes(2));
    await act(async () => undefined);
    expect(search().get('notification')).toBe('review-2990');
    expect(listNotifications).toHaveBeenCalledTimes(2);
  });

  test('reopening an unread item after its read failed tries the read again, once per opening', async () => {
    mockViewport(true);
    const unread = { ...review, readAt: null } as Notification;
    vi.mocked(listNotifications).mockResolvedValue({ notifications: [unread, ready, failed], unreadCount: 1, nextCursor: null });
    vi.mocked(markNotificationRead).mockRejectedValue(new Error('offline'));
    renderInbox();
    await screen.findByRole('article', { name: review.title });
    fireEvent.click(row(review.title));
    await waitFor(() => expect(markNotificationRead).toHaveBeenCalledTimes(1));
    // The failed read rolls the item back to unread without retrying in a loop.
    await act(async () => undefined);
    expect(markNotificationRead).toHaveBeenCalledTimes(1);

    vi.mocked(markNotificationRead).mockResolvedValue({ notification: { ...unread, readAt: at(0) }, unreadCount: 0 } as never);
    fireEvent.click(row(ready.title));
    fireEvent.click(row(review.title));
    await waitFor(() => expect(markNotificationRead).toHaveBeenCalledTimes(2));

    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(row(review.title));
    await act(async () => undefined);
    expect(markNotificationRead).toHaveBeenCalledTimes(2);
  });

  test('narrow viewports keep the single column and rows navigate', async () => {
    mockViewport(false);
    renderInbox(`/inbox?notification=${review.id}`);
    await screen.findByRole('article', { name: review.title });
    expect(screen.queryByTestId('inbox-split-workspace')).not.toBeInTheDocument();
    expect(pane()).not.toBeInTheDocument();
    const link = within(screen.getByRole('article', { name: failed.title })).getByRole('link', { name: failed.title });
    expect(link).toHaveAttribute('href', '/tasks/task-3049');
    fireEvent.keyDown(window, { key: 'j' });
    expect(pane()).not.toBeInTheDocument();
    fireEvent.click(link);
    expect(await screen.findByText('Task page')).toBeInTheDocument();
  });
});
