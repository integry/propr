import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { notificationSchema } from '@propr/shared';
import { getTasks, postTaskFollowup } from '../../api/proprApi';
import { resetFollowupSubmissions } from '../Inbox/followupSubmissions';
import { ToastProvider } from '../ui/Toast';
import LatestRunCommands from './LatestRunCommands';
import { readTaskRuns } from './readTaskRuns';
import { latestRunFollowup, notificationRunFollowup } from './runFollowup';
// The API's task projection test asserts `GET /api/tasks` returns exactly these runs.
import projectedTasks from './reviewOutcomeTasks.fixture.json';

vi.mock('../../api/proprApi', () => ({ postTaskReview: vi.fn(), postTaskFollowup: vi.fn(), getTasks: vi.fn() }));

type ProjectedTask = (typeof projectedTasks)[number];
const projected = (id: string): ProjectedTask => projectedTasks.find(task => task.id === id)!;

/** `GET /api/tasks?groupBy=task&task=…` answering with the projected review as its task's only run. */
const serveProjection = (...overrides: Partial<ProjectedTask>[]) => vi.mocked(getTasks).mockImplementation(async options => ({
  tasks: projectedTasks.filter(entry => typeof options === 'object' && entry.id === options.task).map(entry => Object.assign({}, entry, ...overrides)),
}) as never);

/** A run whose summary reads as a clean recap: a titled task, so the subtitle is the run's summary. */
const recapSummary: Partial<ProjectedTask> = { title: 'Document the review flow', subtitle: 'Score 9/10 · 0 issues found' };

const reviewNotification = (task: ProjectedTask, body: string) => notificationSchema.parse({
  id: `notification-${task.id}`, deduplicationKey: task.id, kind: 'review', severity: 'success',
  target: { type: 'review', repository: task.repository, prNumber: task.prNumber, taskId: task.id },
  title: 'Review', body, actions: ['follow_up', 'dismiss'],
  occurredAt: task.createdAt, createdAt: task.createdAt, readAt: null, dismissedAt: null,
});

describe('follow-up commands read from the API task projection', () => {
  afterEach(() => {
    vi.clearAllMocks();
    resetFollowupSubmissions();
  });

  test('the projected clean 9/10 review carries no recap, only its recorded outcome', async () => {
    serveProjection();
    const runs = await readTaskRuns('review-clean');
    expect(runs).toHaveLength(1);
    expect(runs![0].summary).not.toMatch(/issues? found|Score/);
    expect(runs![0].task).toMatchObject({ score: 9, reviewOutcome: 'clean', commandMode: 'review' });
  });

  test.each([
    ['review-clean', null],
    ['review-findings', ['/fix']],
    ['review-failed', ['/fix']],
    // An outcome the API could not confirm is not read as clean from its score.
    ['review-legacy', ['/fix']],
    ['review-unknown', ['/fix']],
  ])('%s offers %j', async (id, commands) => {
    serveProjection();
    const followup = latestRunFollowup(await readTaskRuns(id), id);
    expect(followup?.commands ?? null).toEqual(commands);
    if (followup) expect(followup).toMatchObject({ taskId: id, prNumber: projected(id).prNumber });
  });

  test('a projection from a server that predates the outcome keeps /fix', async () => {
    serveProjection({ reviewOutcome: undefined });
    expect(latestRunFollowup(await readTaskRuns('review-clean'), 'review-clean')?.commands).toEqual(['/fix']);
  });

  test('an outcome the API reports as unknown keeps /fix even when the run summary reads as a clean recap', async () => {
    // The API answers null for this recap when no reviewer success was recorded (review-legacy).
    serveProjection(recapSummary);
    const runs = await readTaskRuns('review-legacy');
    expect(runs![0]).toMatchObject({ summary: 'Score 9/10 · 0 issues found', task: { score: 9, reviewOutcome: null } });
    expect(latestRunFollowup(runs, 'review-legacy')?.commands).toEqual(['/fix']);
    const card = reviewNotification(projected('review-legacy'), 'GPT-6 Astra finished reviewing the pull request.');
    expect(notificationRunFollowup(card, runs)?.commands).toEqual(['/fix']);
    render(<ToastProvider><LatestRunCommands runs={runs!} taskId="review-legacy" /></ToastProvider>);
    expect(screen.getByRole('button', { name: 'Send /fix to PR #36' })).toBeInTheDocument();
  });

  test('a server that predates the outcome still reads a clean recap summary as clean', async () => {
    serveProjection(recapSummary, { reviewOutcome: undefined });
    expect(latestRunFollowup(await readTaskRuns('review-legacy'), 'review-legacy')).toBeNull();
  });

  test('the task header offers no /fix for the clean review and sends nothing', async () => {
    serveProjection();
    const runs = await readTaskRuns('review-clean');
    render(<ToastProvider><LatestRunCommands runs={runs!} taskId="review-clean" /></ToastProvider>);
    expect(screen.queryByRole('button', { name: /^Send/ })).not.toBeInTheDocument();
    expect(postTaskFollowup).not.toHaveBeenCalled();
  });

  test('the task header keeps /fix for findings and sends it only after the projection is read again', async () => {
    serveProjection();
    const runs = await readTaskRuns('review-findings');
    vi.mocked(postTaskFollowup).mockResolvedValue({ success: true, state: 'queued' });
    render(<ToastProvider><LatestRunCommands runs={runs!} taskId="review-findings" /></ToastProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Send /fix to PR #34' }));
    await waitFor(() => expect(postTaskFollowup).toHaveBeenCalledWith('review-findings', '/fix', 'pull_request'));
    expect(getTasks).toHaveBeenCalledTimes(2);
  });

  test('a fresh read that finds the review clean withdraws a /fix the stale runs offered', async () => {
    serveProjection({ reviewOutcome: null });
    const runs = await readTaskRuns('review-clean');
    render(<ToastProvider><LatestRunCommands runs={runs!} taskId="review-clean" /></ToastProvider>);
    serveProjection();
    fireEvent.click(screen.getByRole('button', { name: 'Send /fix to PR #33' }));
    expect(await screen.findByText(/\/fix was not sent/)).toBeInTheDocument();
    expect(postTaskFollowup).not.toHaveBeenCalled();
  });

  test('the Inbox reads the same outcome: its review card offers /fix only where the task does', async () => {
    serveProjection();
    const clean = projected('review-clean');
    // The card body is the review's own text, not a recap the task projection could be matched against.
    const card = (task: ProjectedTask) => reviewNotification(task, 'GPT-6 Astra finished reviewing the pull request.');
    expect(notificationRunFollowup(card(clean), await readTaskRuns(clean.id))).toBeNull();
    for (const id of ['review-findings', 'review-failed', 'review-legacy']) {
      expect(notificationRunFollowup(card(projected(id)), await readTaskRuns(id))?.commands).toEqual(['/fix']);
    }
  });
});
