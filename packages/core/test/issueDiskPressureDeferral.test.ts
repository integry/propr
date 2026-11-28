/**
 * An issue job refused at worker admission for disk pressure waits for free
 * space on the same BullMQ job (delayed, attempts unchanged) on a backoff of
 * minutes, bounded by WORKTREE_DISK_PRESSURE_MAX_WAIT_MS, and fails for good,
 * without retries, only once that wait has run out.
 */
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const log = { info() {}, warn() {}, error() {}, debug() {}, withCorrelation: () => log };
await mock.module('../src/utils/logger.js', { defaultExport: log });
// The dispatch row is unwritable here; jobs without an `issueDispatchId` never touch it.
await mock.module('../src/db/connection.js', { namedExports: { db: () => { throw new Error('SQLITE_IOERR: disk I/O error'); } } });
const { decideIssueDiskPressure, deferIssueJobOnDiskPressure, recordIssueJobAdmitted, exhaustedIssueDiskPressureMessage, isFinalJobFailure, issueDiskPressureMaxWaitMs,
  ISSUE_DISK_PRESSURE_RETRY_DELAYS_MS } = await import('../src/queue/issueDiskPressureDeferral.js');
const { WorktreeDiskPressureError, isWorktreeDiskPressureError } = await import('../src/storage/lifecycle.js');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function fakeJob(data: Record<string, unknown> = {}, name = 'processGitHubIssue') {
  const calls = { delayedUntil: [] as number[], tokens: [] as Array<string | undefined>, data: [] as unknown[] };
  const job = {
    id: 'issue-acme-repo-7', name, token: 'lock-token', data: { repoOwner: 'acme', repoName: 'repo', number: 7, ...data } as Record<string, unknown>,
    async moveToDelayed(timestamp: number, token?: string) { calls.delayedUntil.push(timestamp); calls.tokens.push(token); },
    async updateData(next: unknown) { calls.data.push(next); job.data = next as Record<string, unknown>; },
  };
  return { job, calls };
}

const refuse = async () => { throw new WorktreeDiskPressureError(); };

test('the retry schedule waits minutes, not seconds, and ends within the configured total wait', () => {
  const now = 10 * HOUR;
  let data: Record<string, number> = {};
  const delays: number[] = [];
  let clock = now;
  for (;;) {
    const decision = decideIssueDiskPressure(data, { now: clock, maxWaitMs: HOUR });
    if (decision.action === 'exhausted') {
      assert.equal(decision.since, now);
      assert.equal(decision.waitedMs, HOUR);
      break;
    }
    delays.push(decision.delayMs);
    assert.ok(decision.delayMs >= MINUTE, 'every wait is at least a minute');
    data = { diskPressureDeferrals: decision.deferrals, diskPressureSince: decision.since };
    clock = decision.retryAt;
  }
  assert.deepEqual(delays.map(ms => ms / MINUTE), [2, 5, 10, 20, 20, 3]);
  assert.equal(delays.reduce((sum, ms) => sum + ms, 0), HOUR);
  assert.deepEqual(ISSUE_DISK_PRESSURE_RETRY_DELAYS_MS.map(ms => ms / MINUTE), [2, 5, 10, 20]);
});

test('WORKTREE_DISK_PRESSURE_MAX_WAIT_MS bounds the wait; invalid values use the one-hour default', () => {
  assert.equal(issueDiskPressureMaxWaitMs({}), HOUR);
  assert.equal(issueDiskPressureMaxWaitMs({ WORKTREE_DISK_PRESSURE_MAX_WAIT_MS: '7200000' }), 2 * HOUR);
  assert.equal(issueDiskPressureMaxWaitMs({ WORKTREE_DISK_PRESSURE_MAX_WAIT_MS: '0' }), 0);
  assert.equal(issueDiskPressureMaxWaitMs({ WORKTREE_DISK_PRESSURE_MAX_WAIT_MS: '-5' }), HOUR);
  assert.equal(issueDiskPressureMaxWaitMs({ WORKTREE_DISK_PRESSURE_MAX_WAIT_MS: 'soon' }), HOUR);
});

test('an issue job refused for disk pressure is deferred on the same job, not failed', async () => {
  const { job, calls } = fakeJob({ correlationId: 'corr' });
  const now = 1_000_000;
  await assert.rejects(deferIssueJobOnDiskPressure(job, refuse, { now: () => now, maxWaitMs: HOUR }),
    (error: Error) => error.name === 'DelayedError');
  assert.deepEqual(calls.delayedUntil, [now + 2 * MINUTE]);
  assert.deepEqual(calls.tokens, ['lock-token']);
  assert.deepEqual(calls.data, [{ repoOwner: 'acme', repoName: 'repo', number: 7, correlationId: 'corr',
    diskPressureDeferrals: 1, diskPressureSince: now, diskPressureRetryAt: now + 2 * MINUTE }]);

  // The next refusal of the same wait backs off further and keeps when the wait began.
  await assert.rejects(deferIssueJobOnDiskPressure(job, refuse, { now: () => now + 2 * MINUTE, maxWaitMs: HOUR }),
    (error: Error) => error.name === 'DelayedError');
  assert.equal(calls.delayedUntil[1], now + 7 * MINUTE);
  assert.equal((job.data as { diskPressureSince: number }).diskPressureSince, now);
  assert.equal((job.data as { diskPressureDeferrals: number }).diskPressureDeferrals, 2);
});

test('a refusal after the wait ran out fails the job for good with the disk-pressure cause', async () => {
  const start = 1_000_000;
  const { job, calls } = fakeJob({ diskPressureDeferrals: 6, diskPressureSince: start });
  let thrown: Error | undefined;
  await deferIssueJobOnDiskPressure(job, refuse, { now: () => start + HOUR, maxWaitMs: HOUR }).catch(error => { thrown = error; });
  assert.ok(thrown);
  assert.equal(thrown.name, 'UnrecoverableError', 'BullMQ does not retry it in a burst');
  assert.equal(thrown.message, exhaustedIssueDiskPressureMessage(HOUR, 6));
  assert.match(thrown.message, /^Worktree disk pressure: admission reserve unavailable after waiting 60 minutes \(7 refusals\); data retained$/);
  assert.equal(isWorktreeDiskPressureError(thrown), true, 'the final failure is still recognised as disk pressure');
  assert.equal(isFinalJobFailure({ attemptsMade: 1, opts: { attempts: 3 } }, thrown), true);
  assert.deepEqual(calls.delayedUntil, []);
});

test('other jobs and other errors are untouched; a zero wait keeps the normal retries', async () => {
  const other = new Error('agent failed');
  const issue = fakeJob();
  await assert.rejects(deferIssueJobOnDiskPressure(issue.job, async () => { throw other; }), error => error === other);
  const comment = fakeJob({}, 'processPullRequestComment');
  await assert.rejects(deferIssueJobOnDiskPressure(comment.job, refuse, { maxWaitMs: HOUR }), (error: Error) => error instanceof WorktreeDiskPressureError);
  const disabled = fakeJob();
  await assert.rejects(deferIssueJobOnDiskPressure(disabled.job, refuse, { maxWaitMs: 0 }), (error: Error) => error instanceof WorktreeDiskPressureError);
  for (const { calls } of [issue, comment, disabled]) assert.deepEqual(calls.delayedUntil, []);
  assert.equal(await deferIssueJobOnDiskPressure(fakeJob().job, async () => 'done'), 'done');
});

test('a failure is final once BullMQ will not retry it', () => {
  const error = new Error('x');
  assert.equal(isFinalJobFailure({ attemptsMade: 1, opts: { attempts: 3 } }, error), false);
  assert.equal(isFinalJobFailure({ attemptsMade: 3, opts: { attempts: 3 } }, error), true);
  assert.equal(isFinalJobFailure({ attemptsMade: 1, finishedOn: 5, opts: { attempts: 3 } }, error), true);
});

test('an admitted job drops the ended wait, so a later refusal starts a new one', async () => {
  const { job, calls } = fakeJob({ correlationId: 'corr', diskPressureDeferrals: 3, diskPressureSince: 5, diskPressureRetryAt: 9 });
  await recordIssueJobAdmitted(job);
  assert.deepEqual(calls.data, [{ repoOwner: 'acme', repoName: 'repo', number: 7, correlationId: 'corr' }]);
  await recordIssueJobAdmitted(job);
  assert.equal(calls.data.length, 1, 'a job without a wait is not rewritten');
  const now = 50 * HOUR;
  await assert.rejects(deferIssueJobOnDiskPressure(job, refuse, { now: () => now, maxWaitMs: HOUR }), (error: Error) => error.name === 'DelayedError');
  assert.equal((job.data as { diskPressureSince: number }).diskPressureSince, now);
  assert.equal((job.data as { diskPressureDeferrals: number }).diskPressureDeferrals, 1);
});

test('admission fails the attempt when it cannot record started_at on the dispatch', async () => {
  // A later final refusal relies on started_at to say whether the job ever started, so it is not best effort.
  const { job, calls } = fakeJob({ issueDispatchId: 'abc' });
  await assert.rejects(recordIssueJobAdmitted(job), /SQLITE_IOERR/);
  assert.deepEqual(calls.data, []);
  // A child shares the dispatch but does not move it.
  await recordIssueJobAdmitted(fakeJob({ issueDispatchId: 'abc', isChildJob: true }).job);
});
