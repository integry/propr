/**
 * A disk-pressure refusal must be diagnosable after the fact: the error, its
 * message (all that survives a queue round-trip), the deferral log, the final
 * failure (and so the issue comment, see issueDiskPressureRefusal.test.ts) all state the measured filesystem, the free
 * bytes, the reserve, the other claims (sum and count) and the job's own
 * reservation; each refusal also lists the claims it counted.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

const logged: Array<{ level: string; fields: Record<string, unknown>; message: string }> = [];
const log = {
  info() {}, debug() {},
  warn(fields: Record<string, unknown>, message: string) { logged.push({ level: 'warn', fields, message }); },
  error(fields: Record<string, unknown>, message: string) { logged.push({ level: 'error', fields, message }); },
  withCorrelation: () => log,
};
await mock.module('../src/utils/logger.js', { defaultExport: log });
const { StorageLifecycle } = await import('../src/storage/lifecycle.js');
const {
  WorktreeDiskPressureError, formatBytes, formatWorktreeDiskPressure, isWorktreeDiskPressureError, worktreeDiskPressureDetails,
} = await import('../src/storage/diskPressure.js');
const { deferIssueJobOnDiskPressure } = await import('../src/queue/issueDiskPressureDeferral.js');

const GIB = 1024 ** 3;
const MEASUREMENT = {
  filesystem: '/tmp/git-processor', freeBytes: Math.round(6.2 * GIB), reserveBytes: 2 * GIB,
  reservedBytes: 4 * GIB, claimCount: 4, taskBytes: GIB,
};
const EXPECTED = 'filesystem /tmp/git-processor: free 6.2 GiB < required 7.0 GiB = reserve 2.0 GiB + 4 other claims × 1.0 GiB + this job 1.0 GiB';

test('recovering details from a hostile message stays linear', () => {
  const prefix = 'Worktree disk pressure: admission reserve unavailable; data retained ';
  const started = Date.now();
  assert.equal(worktreeDiskPressureDetails(new Error(`${prefix}${'(filesystem '.repeat(100_000)}`)), null);
  assert.equal(worktreeDiskPressureDetails(new Error(`${prefix}(filesystem a this job ${'( this job '.repeat(100_000)})`)), null);
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started}ms`);
  // A path with parentheses still round-trips.
  const odd = formatWorktreeDiskPressure({ ...MEASUREMENT, filesystem: '/mnt/data (ssd)' });
  assert.equal(worktreeDiskPressureDetails(new Error(`${prefix}(${odd})`)), odd);
});

test('the refusal message states every measured number in readable units', () => {
  assert.equal(formatWorktreeDiskPressure(MEASUREMENT), EXPECTED);
  const error = new WorktreeDiskPressureError(MEASUREMENT);
  assert.deepEqual(error.measurement, MEASUREMENT);
  assert.equal(error.message, `Worktree disk pressure: admission reserve unavailable; data retained (${EXPECTED})`);
  assert.equal(isWorktreeDiskPressureError(error), true);
  // After a queue round-trip only the message is left; the details come back from it.
  assert.equal(worktreeDiskPressureDetails(new Error(error.message)), EXPECTED);
  assert.equal(worktreeDiskPressureDetails(new WorktreeDiskPressureError()), null);
  // Uneven claims are summed rather than multiplied.
  assert.match(formatWorktreeDiskPressure({ ...MEASUREMENT, reservedBytes: 3 * GIB + 1, claimCount: 2 }), /\+ 2 other claims totalling 3\.0 GiB \+/);
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536 * 1024), '1.5 MiB');
});

test('admission measures the filesystem, separates the job\'s own claim and lists every counted claim', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'disk-pressure-details-'));
  const warnings: string[] = [];
  const warn = mock.method(console, 'warn', (message: string) => { warnings.push(message); });
  try {
    const storage = new StorageLifecycle(path.join(root, 'lifecycle'));
    await storage.initialize();
    const stat = await fs.statfs(root);
    const free = stat.bavail * stat.bsize;
    // A live worker's claim (this process) that reserves more than is free: the "leaked claim" shape.
    const leaked = path.join(root, 'lifecycle', 'readers', 'leaked');
    await fs.writeFile(leaked, JSON.stringify({ reservedBytes: free, owner: { host: os.hostname(), pid: process.pid, startedAt: 0 } }));
    await fs.utimes(leaked, new Date(Date.now() - 3 * 3600_000), new Date(Date.now() - 3 * 3600_000));
    await fs.writeFile(path.join(root, 'lifecycle', 'readers', 'unreserved'), JSON.stringify({ owner: { host: 'h', pid: 1, startedAt: 0 } }));
    const missing = path.join(root, 'worktrees', 'not-yet-created');

    let thrown: InstanceType<typeof WorktreeDiskPressureError> | undefined;
    await storage.use(async () => 'ran', { filesystem: missing, reserveBytes: 2 * GIB, taskBytes: 7 }).catch(error => { thrown = error; });
    assert.ok(thrown instanceof WorktreeDiskPressureError);
    const measurement = thrown.measurement!;
    assert.equal(measurement.filesystem, root, 'the nearest existing ancestor is what was measured');
    assert.ok(Math.abs(measurement.freeBytes - free) < 64 * 1024 * 1024, 'freeBytes is bavail * bsize');
    assert.equal(measurement.reserveBytes, 2 * GIB);
    assert.equal(measurement.taskBytes, 7);
    assert.equal(measurement.reservedBytes, free, 'only the other claim is summed');
    assert.equal(measurement.claimCount, 1);
    assert.ok(thrown.message.includes(`(filesystem ${root}: free `), thrown.message);
    assert.ok(thrown.message.includes(`= reserve 2.0 GiB + 1 other claim × ${formatBytes(free)} + this job 7 B)`), thrown.message);

    assert.equal(warnings.length, 1, 'one warning per refusal');
    const [warning] = warnings;
    assert.ok(warning.includes(formatWorktreeDiskPressure(measurement)), warning);
    assert.match(warning, /2 claims counted:/);
    assert.match(warning, new RegExp(`leaked: [^\\n]+, owner ${os.hostname()} pid ${process.pid}, age 3h 0\\dm`));
    assert.match(warning, /\(this job\): 7 B, owner [^\n]+ pid \d+, age \d+s/);
    assert.equal(warning.includes('unreserved'), false, 'claims that reserve nothing are not counted');
  } finally {
    warn.mock.restore();
    await fs.rm(root, { recursive: true, force: true });
  }
});

function fakeJob(data: Record<string, unknown>) {
  const job = {
    id: 'issue-acme-repo-7', name: 'processGitHubIssue', token: 'lock',
    data: { repoOwner: 'acme', repoName: 'repo', number: 7, ...data } as Record<string, unknown>,
    async moveToDelayed() {},
    async updateData(next: unknown) { job.data = next as Record<string, unknown>; },
  };
  return job;
}

test('the deferral log, the final failure and the issue comment carry the measurement', async () => {
  const refuse = async () => { throw new WorktreeDiskPressureError(MEASUREMENT); };
  logged.length = 0;
  const job = fakeJob({});
  await assert.rejects(deferIssueJobOnDiskPressure(job, refuse, { now: () => 1_000_000, maxWaitMs: 3600_000 }), { name: 'DelayedError' });
  const waiting = logged.find(entry => entry.message.startsWith('Issue job refused for disk pressure: waiting for free disk space'))!;
  assert.equal(waiting.message, `Issue job refused for disk pressure: waiting for free disk space (${EXPECTED})`);
  assert.deepEqual(waiting.fields.diskPressure, MEASUREMENT);
  assert.equal(job.data.diskPressureDetails, EXPECTED, 'kept on the job for the final report');

  logged.length = 0;
  let final: Error | undefined;
  await deferIssueJobOnDiskPressure(job, refuse, { now: () => 1_000_000 + 3600_000, maxWaitMs: 3600_000 }).catch(error => { final = error; });
  assert.equal(final?.name, 'UnrecoverableError');
  assert.ok(final!.message.endsWith(`; data retained (${EXPECTED})`), final!.message);
  assert.equal(worktreeDiskPressureDetails(new Error(final!.message)), EXPECTED, 'recoverable after the queue round-trip');
  const ranOut = logged.find(entry => entry.level === 'error')!;
  assert.ok(ranOut.message.endsWith(`(${EXPECTED})`));
  assert.deepEqual(ranOut.fields.diskPressure, MEASUREMENT);
});
