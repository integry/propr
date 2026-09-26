import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import knex from 'knex';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { up } from '../src/db/migrations/20260922000000_add_task_submissions.js';
import { up as identityMigration } from '../src/db/migrations/20260922010000_preserve_task_submission_identity.js';
import { closeConnection } from '../src/db/connection.js';
import { associateSubmissionTask, insertTaskSubmission, resumeTaskSubmission, findIssueSubmission, materializeSubmissionAttachments, submissionAssetPath } from '../src/services/taskSubmissionService.js';
import { handleDispatchWithDeps } from '../../../src/jobs/issueJobDispatcher.js';
import { resolveTaskSubmissionRetry } from '../src/services/taskSubmissionRetry.js';
import type { IssueJobData } from '@propr/core';
import type { Job } from 'bullmq';

after(closeConnection);
const input = { user_id: 'alice', submission_key: 'request-1', payload_hash: 'hash', repository: 'owner/repo', payload: '{}', attachments: '[]' };
// File-backed fixtures prove cross-process exclusion, not durability. Every
// autocommit would otherwise fsync the journal and the database on the shared
// rootless CI host's disk, and those synchronous waits are the only part of
// the cross-process test that neither CPU contention nor the child handshake
// bounds: run 36055786425 blocked it for 40s against a 20s budget while the
// rest of the unit ran at its usual speed. Locking and visibility are
// unaffected by skipping fsync.
function skipFsync(connection: { pragma: (statement: string) => unknown }, done: (error: Error | null, connection?: unknown) => void) {
  try {
    connection.pragma('synchronous = OFF');
    done(null, connection);
  } catch (error) {
    done(error as Error);
  }
}
async function fixture(filename = ':memory:') {
  const database = knex({ client: 'better-sqlite3', connection: { filename }, useNullAsDefault: true, pool: { afterCreate: skipFsync } });
  await up(database);
  await identityMigration(database);
  return database;
}

test('concurrent submissions, response loss, dispatch retry and a late webhook converge on one issue and implementation', async () => {
  const database = await fixture();
  try {
    const rows = await Promise.all(Array.from({ length: 8 }, () => insertTaskSubmission(database, input)));
    assert.equal(new Set(rows.map(row => row.id)).size, 1);
    const row = rows[0];
    let creates = 0;
    let exists = false;
    let failDispatch = true;
    const children = new Map<string, IssueJobData>();
    const queuedOptions: Array<{ removeOnComplete: boolean }> = [];
    const events = [{ id: 1, event: 'labeled', created_at: '2026-09-22T10:00:00Z', label: { name: 'AI' }, actor: { id: 123 } as { id: number } | undefined }];
    const deps = {
      resolveSubmissionRetry: (submission: Parameters<typeof resolveTaskSubmissionRetry>[0]) => resolveTaskSubmissionRetry(submission, database,
        async () => ({ request: async () => ({ data: events }) }) as never, async () => ['AI']),
      findSubmission: (issue: IssueJobData) => findIssueSubmission(issue, database),
      recordDispatch: async (id: string, eventId?: string) => { await database('task_submissions').where({ id }).update({ dispatch_complete: true, retry_event_id: eventId }); },
      recordDispatchFailure: async () => undefined,
      getAuthenticatedOctokit: async () => ({ request: async () => ({ data: { labels: [{ name: 'AI' }, { name: 'llm-chosen' }, { name: 'base-release' }] } }) }),
      withRetry: async (operation: () => Promise<unknown>) => operation(), retryConfigs: { githubApi: {} },
      validateRepositoryInfo: async () => ({ isValid: true, repoData: { defaultBranch: 'main' } }),
      resolveLlmLabel: async () => ({ agentAlias: 'issue-only-agent', model: 'chosen-model' }),
      getAllCustomLabels: async () => [], getDefaultModel: () => 'wrong-model',
      issueQueue: { add: async (_name: string, data: IssueJobData, options: { jobId: string; removeOnComplete: boolean }) => {
        children.set(options.jobId, data); queuedOptions.push(options);
      } },
    } as unknown as Parameters<typeof handleDispatchWithDeps>[1];
    const dispatch = () => handleDispatchWithDeps({ id: 'parent', name: 'processGitHubIssue', data: { repoOwner: 'owner', repoName: 'repo', number: 17, userId: 'bot', correlationId: 'webhook' } } as Job<IssueJobData>, deps);
    const services = {
      createIssue: async () => { creates++; exists = true; throw new Error('Lost GitHub response after creation'); },
      reconcileIssue: async () => exists ? { number: 17, url: 'https://github.com/owner/repo/issues/17' } : null,
      dispatch: async () => {
        if (failDispatch) throw new Error('Queue unavailable');
        // Direct enqueue and webhook race through the SAME production dispatcher.
        await Promise.all([dispatch(), dispatch()]);
      },
    };
    await resumeTaskSubmission(database, row.id, services);
    const failed = await resumeTaskSubmission(database, row.id, services);
    assert.equal(failed.issue_number, 17);
    assert.equal(failed.state, 'failed');
    assert.equal(creates, 1);
    failDispatch = false;
    await Promise.all([resumeTaskSubmission(database, row.id, services), resumeTaskSubmission(database, row.id, services)]);
    assert.equal(children.size, 1);
    const child = [...children.values()][0];
    assert.equal(child.userId, 'alice');
    assert.equal(child.correlationId, row.id);
    assert.equal(child.baseBranch, 'release');
    assert.equal(child.agentAlias, 'issue-only-agent');
    assert.equal(child.modelName, 'chosen-model');
    assert.equal(child.isChildJob, true);
    assert.ok(queuedOptions.every(options => !options.removeOnComplete));
    assert.equal((await database('task_submissions').first()).retry_event_id, '1');
    // Completed jobs may disappear; the durable receipt still suppresses a late webhook.
    children.clear();
    assert.equal((await dispatch()).status, 'skipped');
    assert.equal(children.size, 0);
    await database.schema.createTable('task_history', table => {
      table.increments('history_id'); table.string('task_id'); table.string('state'); table.timestamp('timestamp');
    });
    await associateSubmissionTask(database, row.id, 'initial-task');
    await database('task_history').insert({ task_id: 'initial-task', state: 'completed', timestamp: '2026-09-22T10:00:00Z' });
    // The initial label and completion share a second: redelivery is still skipped.
    assert.equal((await dispatch()).status, 'skipped');
    for (const [index, actor] of [{ id: 456 }, undefined].entries()) {
      const eventId = index + 2;
      // A relabel after completion can have the same truncated timestamp,
      // including a timestamp earlier than the terminal milliseconds.
      await database('task_history').update({ timestamp: index ? '2026-09-22T10:00:00.789Z' : '2026-09-22T10:00:00Z' });
      events.push({ ...events[0], id: eventId, actor });
      assert.equal((await dispatch()).status, 'dispatched');
      const [childId, retryChild] = [...children.entries()].at(-1)!;
      assert.equal(retryChild.userId, 'alice');
      assert.equal(retryChild.correlationId, `${row.id}-${eventId}`);
      assert.ok(childId.endsWith(`-trigger-${eventId}`));
      assert.equal((await database('task_submissions').first()).retry_event_id, String(eventId));
      assert.equal((await dispatch()).status, 'skipped');
    }
    assert.equal((await resumeTaskSubmission(database, row.id, services)).state, 'queued');
    assert.equal(creates, 1);
    await assert.rejects(insertTaskSubmission(database, { ...input, payload_hash: 'different' }), /different content/);
    const intentional = await insertTaskSubmission(database, { ...input, submission_key: 'new-request' });
    assert.notEqual(intentional.id, row.id);
  } finally { await database.destroy(); }
});

test('an ambiguous creation without a visible issue stays recoverable and never repeats creation', async () => {
  const database = await fixture();
  try {
    const row = await insertTaskSubmission(database, input);
    let creates = 0;
    const services = {
      createIssue: async () => { creates++; throw new Error('timeout'); },
      reconcileIssue: async () => null,
      dispatch: async () => { assert.fail('must not dispatch'); },
    };
    await Promise.all(Array.from({ length: 5 }, () => resumeTaskSubmission(database, row.id, services)));
    await resumeTaskSubmission(database, row.id, services);
    assert.equal(creates, 1);
    assert.equal((await database('task_submissions').first()).state, 'creating');
  } finally { await database.destroy(); }
});

test('durable attachment bytes reach the ordinary issue worktree without a goal or planner draft', async () => {
  const database = await fixture();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'submission-assets-'));
  try {
    const attachment = { id: 'file-id', extension: '.txt', originalName: 'expected.txt', mimeType: 'text/plain', content: Buffer.from('Expected invoice: 22/09/2026').toString('base64') };
    const row = await insertTaskSubmission(database, { ...input, attachments: JSON.stringify([attachment]) });
    await database('task_submissions').where({ id: row.id }).update({ issue_number: 17 });
    await materializeSubmissionAttachments({ repoOwner: 'owner', repoName: 'repo', number: 17 }, root, database);
    assert.equal(await fs.readFile(path.join(root, submissionAssetPath(attachment, row.id)), 'utf8'), 'Expected invoice: 22/09/2026');
    assert.equal(await database.schema.hasTable('goals'), false);
    assert.equal(await database.schema.hasTable('task_drafts'), false);
  } finally { await fs.remove(root); await database.destroy(); }
});

test('a deliberate label retry after terminal work is distinct from delayed initial delivery', async () => {
  const { resolveTaskSubmissionRetry } = await import('../src/services/taskSubmissionRetry.js');
  const database = await fixture();
  try {
    await database.schema.createTable('task_history', table => { table.increments('history_id'); table.string('task_id'); table.string('state'); table.timestamp('timestamp').defaultTo(database.fn.now()); });
    const row = await insertTaskSubmission(database, { ...input, payload: JSON.stringify({ trigger: 'AI' }) });
    await database('task_submissions').where({ id: row.id }).update({ issue_number: 17, task_id: 'initial-task', dispatch_complete: true });
    await database('task_history').insert({ task_id: 'initial-task', state: 'failed', timestamp: '2026-09-22T10:00:00Z' });
    let eventId = 1;
    let timestamp = '2026-09-22T09:59:00Z';
    let label = 'AI';
    let labels = ['AI', 'implement'];
    const octokit = async () => ({ request: async () => ({ data: [{ id: eventId, event: 'labeled', created_at: timestamp, label: { name: label }, actor: { id: 123 } }] }) }) as never;
    const read = async () => (await database('task_submissions').first())!;
    assert.equal(await resolveTaskSubmissionRetry(await read(), database, octokit, async () => labels), null);
    eventId = 2; timestamp = '2026-09-22T10:01:00Z';
    assert.deepEqual(await resolveTaskSubmissionRetry(await read(), database, octokit, async () => labels), { eventId: '2' });
    await associateSubmissionTask(database, row.id, 'retry-task');
    assert.equal((await read()).task_id, 'initial-task');
    assert.equal((await read()).latest_task_id, 'retry-task');
    await database('task_history').insert({ task_id: 'retry-task', state: 'processing', timestamp: '2026-09-22T10:01:30Z' });
    await database('task_submissions').where({ id: row.id }).update({ retry_event_id: '2' });
    assert.equal(await resolveTaskSubmissionRetry(await read(), database, octokit, async () => labels), null);
    eventId = 3; timestamp = '2026-09-22T10:02:00Z';
    assert.equal(await resolveTaskSubmissionRetry(await read(), database, octokit, async () => labels), null);
    await database('task_history').insert({ task_id: 'retry-task', state: 'completed', timestamp: '2026-09-22T10:01:30Z' });
    assert.deepEqual(await resolveTaskSubmissionRetry(await read(), database, octokit, async () => labels), { eventId: '3' });
    label = 'implement';
    assert.deepEqual(await resolveTaskSubmissionRetry(await read(), database, octokit, async () => labels), { eventId: '3' });
    labels = ['replacement']; label = 'replacement';
    assert.deepEqual(await resolveTaskSubmissionRetry(await read(), database, octokit, async () => labels), { eventId: '3' });
    await database('task_submissions').where({ id: row.id }).update({ retry_event_id: '3' });
    assert.equal(await resolveTaskSubmissionRetry(await read(), database, octokit, async () => labels), null);
    eventId = 4; label = 'unrelated';
    assert.equal(await resolveTaskSubmissionRetry(await read(), database, octokit, async () => labels), null);
    label = 'AI';
    assert.equal(await resolveTaskSubmissionRetry(await read(), database, octokit, async () => labels), null);
  } finally { await database.destroy(); }
});

test('a definitive GitHub rejection can retry creation with the same identity', async () => {
  const database = await fixture();
  try {
    const row = await insertTaskSubmission(database, input);
    let attempts = 0;
    const services = {
      createIssue: async () => {
        attempts++;
        if (attempts === 1) throw Object.assign(new Error('Installation cannot write issues'), { status: 403 });
        return { number: 18, url: 'https://github.com/owner/repo/issues/18' };
      },
      reconcileIssue: async () => null,
      dispatch: async () => undefined,
    };
    assert.equal((await resumeTaskSubmission(database, row.id, services)).state, 'prepared');
    const success = await resumeTaskSubmission(database, row.id, services);
    assert.equal(success.issue_number, 18);
    assert.equal(success.state, 'queued');
    assert.equal(attempts, 2);
  } finally { await database.destroy(); }
});


test('a durable dispatch claim excludes overlapping resumes and completed replays', async () => {
  const database = await fixture();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let dispatches = 0;
  try {
    const row = await insertTaskSubmission(database, input);
    await database('task_submissions').where({ id: row.id }).update({ state: 'issue_created', issue_number: 17 });
    const services = {
      createIssue: async () => { throw new Error('must not create'); },
      reconcileIssue: async () => null,
      dispatch: async () => { dispatches++; entered(); await held; },
    };
    const first = resumeTaskSubmission(database, row.id, services);
    await started;
    assert.ok((await database('task_submissions').first()).dispatch_claim);
    await Promise.all(Array.from({ length: 8 }, () => resumeTaskSubmission(database, row.id, services)));
    assert.equal(dispatches, 1);
    // The child can finish before the original API caller returns.
    await associateSubmissionTask(database, row.id, 'finished-task');
    await database('task_submissions').where({ id: row.id }).update({ dispatch_complete: true, state: 'queued' });
    release();
    await first;
    await resumeTaskSubmission(database, row.id, services);
    assert.equal(dispatches, 1);
    assert.equal((await database('task_submissions').first()).dispatch_claim, null);
  } finally { release(); await database.destroy(); }
});


test('retry timestamps use SQLite dates and UTC SQL defaults, and invalid dates fail closed', async () => {
  const { resolveTaskSubmissionRetry } = await import('../src/services/taskSubmissionRetry.js');
  const database = await fixture();
  const previousTZ = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  try {
    await database.schema.createTable('task_history', table => {
      table.increments('history_id'); table.string('task_id'); table.string('state');
      table.timestamp('timestamp').defaultTo(database.fn.now());
    });
    const row = { ...await insertTaskSubmission(database, input), task_id: 'task', issue_number: 17, dispatch_complete: true };
    let timestamp = '';
    const octokit = async () => ({ request: async () => ({ data: [
      { id: 2, event: 'labeled', created_at: timestamp, label: { name: 'AI' } },
    ] }) }) as never;
    const resolve = () => resolveTaskSubmissionRetry(row, database, octokit, async () => ['AI']);
    await database('task_history').insert({ task_id: 'task', state: 'completed' });
    const sqlTimestamp = (await database('task_history').first()).timestamp;
    assert.match(sqlTimestamp, /^\d{4}-\d{2}-\d{2} /);
    const terminal = Date.parse(sqlTimestamp.replace(' ', 'T') + 'Z');
    for (const value of [database.fn.now(), new Date(terminal), new Date(terminal).toISOString(), '2026-09-22T12:00:00+02:00']) {
      await database('task_history').update({ timestamp: value });
      const time = typeof value === 'string' ? Date.parse(value) : terminal;
      timestamp = new Date(time - 1000).toISOString();
      assert.equal(await resolve(), null);
      timestamp = new Date(time + 60_000).toISOString();
      assert.deepEqual(await resolve(), { eventId: '2' });
    }
    for (const value of [null, 'invalid']) {
      await database('task_history').update({ timestamp: value });
      assert.equal(await resolve(), null);
    }
    await database('task_history').update({ timestamp: new Date(terminal) });
    timestamp = 'invalid';
    assert.equal(await resolve(), null);
    timestamp = new Date(terminal + 60_000).toISOString();
    for (const value of [new Date(terminal), new Date(NaN), Infinity, NaN]) {
      database.client.config.postProcessResponse = result => ({ ...result, timestamp: value });
      assert.deepEqual(await resolve(), Number.isFinite(Number(value)) ? { eventId: '2' } : null);
    }
  } finally {
    if (previousTZ === undefined) delete process.env.TZ; else process.env.TZ = previousTZ;
    await database.destroy();
  }
});

test('a terminated dispatch owner releases exclusion so concurrent retries resume its existing issue', { timeout: 20_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'submission-recovery-'));
  const filename = path.join(root, 'submissions.sqlite');
  const database = await fixture(filename);
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const row = await insertTaskSubmission(database, input);
    await database('task_submissions').where({ id: row.id }).update({ state: 'issue_created', issue_number: 17 });
    child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import knex from 'knex';
      import { resumeTaskSubmission } from './packages/core/src/services/taskSubmissionService.ts';
      const database = knex({ client: 'better-sqlite3', connection: { filename: process.env.SUBMISSION_TEST_DB }, useNullAsDefault: true,
        pool: { afterCreate: (connection, done) => { connection.pragma('synchronous = OFF'); done(null, connection); } } });
      await resumeTaskSubmission(database, process.env.SUBMISSION_TEST_ID, {
        createIssue: async () => { throw new Error('must not create'); },
        reconcileIssue: async () => null,
        dispatch: async () => {
          process.send('claimed');
          await new Promise(() => { setInterval(() => {}, 1000); });
        },
      });
    `], { env: { ...process.env, SUBMISSION_TEST_DB: filename, SUBMISSION_TEST_ID: row.id }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    await once(child, 'message', { signal: AbortSignal.timeout(10_000) });
    const interrupted = await database('task_submissions').first();
    assert.ok(interrupted.dispatch_claim);
    let dispatches = 0;
    const services = {
      createIssue: async () => { assert.fail('must reuse the existing issue'); },
      reconcileIssue: async () => { assert.fail('issue identity is already known'); },
      dispatch: async (resumed: typeof row, recovering: boolean) => {
        assert.equal(resumed.issue_number, 17);
        assert.equal(resumed.dispatch_claim, interrupted.dispatch_claim);
        assert.equal(recovering, true);
        dispatches++;
      },
    };
    // Another process cannot steal a live attempt, regardless of its duration.
    await resumeTaskSubmission(database, row.id, services);
    assert.equal(dispatches, 0);
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    await Promise.all(Array.from({ length: 4 }, () => resumeTaskSubmission(database, row.id, services)));
    assert.equal(dispatches, 1);
    const recovered = await database('task_submissions').first();
    assert.equal(recovered.state, 'queued');
    assert.equal(recovered.dispatch_claim, null);
  } finally {
    child?.kill('SIGKILL');
    await database.destroy();
    await fs.remove(root);
  }
});
