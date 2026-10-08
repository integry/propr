import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import knex from 'knex';
import fs from 'fs-extra';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { closeConnection, completeTodosForIssue, insertTaskSubmission } from '@propr/core';
import { up } from '../../core/src/db/migrations/20260922000000_add_task_submissions.js';
import { up as identityMigration } from '../../core/src/db/migrations/20260922010000_preserve_task_submission_identity.js';
import { up as repoTodosMigration } from '../../core/src/db/migrations/20260317000000_create_repo_todos.js';
import { up as todoIssueLinkMigration } from '../../core/src/db/migrations/20261013000000_add_todo_issue_link.js';
import { up as submissionTodosLinkedMigration } from '../../core/src/db/migrations/20261013010000_add_task_submission_todos_linked.js';
import { createTaskSubmissionRoutes, authorizeTaskSubmissionRepository, uploadSubmissionImages, submissionIssueTitle } from '../routes/taskSubmissionRoutes.js';
import { configureDemoMode } from '../demoMode.js';

after(closeConnection);
function request(body: unknown, key = 'stable-key', user: unknown = { id: 'alice', username: 'alice' }): Request {
  return { body, user, files: [], params: { key }, get: () => key } as unknown as Request;
}
function response() {
  const state: { status: number; body: Record<string, unknown> } = { status: 200, body: {} };
  const res = { status(code: number) { state.status = code; return this; }, json(body: Record<string, unknown>) { state.body = body; return this; } } as Response;
  return { res, state };
}
async function fixture() {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await up(db);
  await identityMigration(db);
  await repoTodosMigration(db);
  await todoIssueLinkMigration(db);
  await submissionTodosLinkedMigration(db);
  return db;
}

test('submission titles preserve long first lines and only shorten at the issue-title limit', () => {
  const title = 'When starting a new task it should remember the last used settings (repo and agent) and preselect them for the next task';
  assert.equal(submissionIssueTitle(`  ${title}\n\nAdditional details`), title);
  const longTitle = 'Remember the selected repository and agent settings '.repeat(8);
  const shortened = submissionIssueTitle(longTitle);
  assert.ok(shortened.length <= 256);
  assert.ok(shortened.endsWith('...'));
  assert.ok(longTitle.startsWith(`${shortened.slice(0, -3)} `));
  assert.equal(submissionIssueTitle('a'.repeat(300)), `${'a'.repeat(253)}...`);
  assert.equal(submissionIssueTitle('😀'.repeat(150)), `${'😀'.repeat(126)}...`);
  assert.equal(submissionIssueTitle('  '), 'New task');
});

test('route preserves instructions, validates before creation, publishes routing before trigger, and retries the same issue', async () => {
  configureDemoMode(false);
  const db = await fixture();
  const calls: Array<{ route: string; body: Record<string, unknown> }> = [];
  let failQueue = true;
  let queues = 0;
  const routes = createTaskSubmissionRoutes({ db, services: {
    authorize: async () => ({ id: 'repo', name: 'owner/repo', enabled: true, baseBranch: 'release' }),
    routing: async body => {
      if (body.model === 'removed-model') throw Object.assign(new Error('Selected model unavailable'), { status: 400 });
      return { agentAlias: 'issue-agent', model: 'issue-model', routingLabel: 'llm-issue-agent-model' };
    },
    getOctokit: async () => ({ request: async (route: string, body: Record<string, unknown>) => {
      calls.push({ route, body });
      if (route.endsWith('/issues')) return { data: { number: 42, html_url: 'https://github.com/owner/repo/issues/42' } };
      if (route.endsWith('/timeline')) return { data: [] };
      return { data: {} };
    } }) as never,
    processingLabels: async () => ['AI'],
    enqueue: async input => { queues++; assert.equal(input.userId, 'alice'); if (failQueue) throw new Error('Queue unavailable'); },
  } });
  try {
    const instruction = '  Fix invoice dates.\n\nKeep this exact wording.  ';
    const invalid = response();
    await routes.submit(request({ repository: 'owner/repo', instruction, model: 'removed-model' }), invalid.res);
    assert.equal(invalid.state.status, 400);
    assert.equal(calls.length, 0);
    const first = response();
    await routes.submit(request({ repository: 'owner/repo', instruction, todoIds: ['todo-1'] }), first.res);
    assert.equal(first.state.status, 202);
    assert.equal(first.state.body.state, 'failed');
    assert.equal(first.state.body.issueNumber, 42);
    const create = calls.find(call => call.route === 'POST /repos/{owner}/{repo}/issues')!;
    assert.ok(String(create.body.body).startsWith(instruction + '\n\n---'));
    assert.deepEqual(create.body.labels, []);
    assert.deepEqual(calls.filter(call => call.route.endsWith('/labels')).map(call => call.body.labels), [['llm-issue-agent-model'], ['base-release'], ['AI']]);
    assert.deepEqual(JSON.parse((await db('task_submissions').first()).payload).todoIds, ['todo-1']);
    failQueue = false;
    const retry = response();
    await routes.retry(request({}), retry.res);
    assert.equal(retry.state.body.state, 'queued');
    const duplicate = response();
    await routes.submit(request({ repository: 'owner/repo', instruction, todoIds: ['todo-1'] }), duplicate.res);
    assert.equal(duplicate.state.body.id, first.state.body.id);
    assert.equal(calls.filter(call => call.route === 'POST /repos/{owner}/{repo}/issues').length, 1);
    assert.equal(queues, 2);
    const changed = response();
    await routes.submit(request({ repository: 'owner/repo', instruction: 'changed' }), changed.res);
    assert.equal(changed.state.status, 409);
    assert.equal(await db.schema.hasTable('goals'), false);
    assert.equal(await db.schema.hasTable('task_drafts'), false);
  } finally { await db.destroy(); }
});

test('an accepted submission completes and links its to-dos once, and to-do failures never fail it', async () => {
  configureDemoMode(false);
  const db = await fixture();
  const todo = (todo_id: string, user_id = 'alice', repository = 'owner/repo') =>
    ({ todo_id, user_id, repository, content: todo_id, order_index: 0, is_completed: false, linked_draft_id: null });
  await db('repo_todos').insert([todo('todo-1'), todo('todo-bob', 'bob'), todo('todo-elsewhere', 'alice', 'owner/other')]);
  let failQueue = true;
  let failTodos = false;
  let completions = 0;
  let issues = 6;
  const routes = createTaskSubmissionRoutes({ db, services: {
    authorize: async () => ({ id: 'repo', name: 'owner/repo', enabled: true }),
    routing: async () => ({ agentAlias: 'agent', model: 'model', routingLabel: 'llm-agent-model' }),
    processingLabels: async () => ['AI'],
    enqueue: async () => { if (failQueue) throw new Error('Queue unavailable'); },
    getOctokit: async () => ({ request: async (route: string) => {
      if (route === 'POST /repos/{owner}/{repo}/issues') { issues++; return { data: { number: issues, html_url: `https://github.com/owner/repo/issues/${issues}` } }; }
      return { data: [] };
    } }) as never,
    completeTodos: async (params, database) => {
      completions++;
      if (failTodos) throw new Error('repo_todos is read-only');
      return completeTodosForIssue(params, database);
    },
  } });
  try {
    const body = { repository: 'Owner/Repo', instruction: 'Fix it', todoIds: ['todo-1', 'todo-bob', 'todo-elsewhere'] };
    const first = response();
    await routes.submit(request(body), first.res);
    assert.equal(first.state.status, 202);
    assert.equal(first.state.body.issueNumber, 7);
    const linked = await db('repo_todos').where({ todo_id: 'todo-1' }).first();
    assert.equal(Boolean(linked.is_completed), true);
    assert.equal(linked.linked_issue_repository, 'owner/repo');
    assert.equal(linked.linked_issue_number, 7);
    for (const id of ['todo-bob', 'todo-elsewhere']) {
      const untouched = await db('repo_todos').where({ todo_id: id }).first();
      assert.equal(Boolean(untouched.is_completed), false);
      assert.equal(untouched.linked_issue_number, null);
    }
    failQueue = false;
    const retry = response();
    await routes.retry(request({}), retry.res);
    assert.equal(retry.state.body.state, 'queued');
    const duplicate = response();
    await routes.submit(request(body), duplicate.res);
    assert.equal(duplicate.state.status, 200);
    assert.equal((await db('repo_todos').where({ linked_issue_number: 7 })).length, 1);

    failTodos = true;
    const unwritable = response();
    await routes.submit(request({ ...body, instruction: 'Fix it again' }, 'second-key'), unwritable.res);
    assert.equal(unwritable.state.status, 200);
    assert.equal(unwritable.state.body.state, 'queued');
    assert.equal(unwritable.state.body.issueNumber, 8);
    assert.equal(completions, 2);
    assert.equal((await db('repo_todos').where({ todo_id: 'todo-1' }).first()).linked_issue_number, 7);

    failTodos = false;
    const recovered = response();
    await routes.retry(request({}, 'second-key'), recovered.res);
    assert.equal(recovered.state.body.state, 'queued');
    assert.equal(completions, 3);
    assert.equal((await db('repo_todos').where({ todo_id: 'todo-1' }).first()).linked_issue_number, 8);
  } finally { await db.destroy(); }
});

test('replaying an older submission leaves a reopened or relaunched to-do alone', async () => {
  configureDemoMode(false);
  const db = await fixture();
  await db('repo_todos').insert({ todo_id: 'todo-1', user_id: 'alice', repository: 'owner/repo', content: 'todo-1', order_index: 0, is_completed: false, linked_draft_id: null });
  let issues = 41;
  const routes = createTaskSubmissionRoutes({ db, services: {
    authorize: async () => ({ id: 'repo', name: 'owner/repo', enabled: true }),
    routing: async () => ({ agentAlias: 'agent', model: 'model', routingLabel: 'llm-agent-model' }),
    processingLabels: async () => ['AI'],
    enqueue: async () => {},
    getOctokit: async () => ({ request: async (route: string) => {
      if (route === 'POST /repos/{owner}/{repo}/issues') { issues++; return { data: { number: issues, html_url: `https://github.com/owner/repo/issues/${issues}` } }; }
      return { data: [] };
    } }) as never,
  } });
  const todo = () => db('repo_todos').where({ todo_id: 'todo-1' }).first();
  const replayA = async () => {
    const duplicate = response();
    await routes.submit(request(launchA, 'launch-a'), duplicate.res);
    assert.equal(duplicate.state.body.issueNumber, 42);
    const retried = response();
    await routes.retry(request({}, 'launch-a'), retried.res);
    assert.equal(retried.state.body.issueNumber, 42);
  };
  const launchA = { repository: 'owner/repo', instruction: 'Fix it', todoIds: ['todo-1'] };
  try {
    const first = response();
    await routes.submit(request(launchA, 'launch-a'), first.res);
    assert.equal(first.state.body.issueNumber, 42);
    assert.equal((await todo()).linked_issue_number, 42);

    await db('repo_todos').where({ todo_id: 'todo-1' }).update({ is_completed: false });
    await replayA();
    assert.equal(Boolean((await todo()).is_completed), false);

    const launchB = response();
    await routes.submit(request({ ...launchA, instruction: 'Fix it properly' }, 'launch-b'), launchB.res);
    assert.equal(launchB.state.body.issueNumber, 43);
    await replayA();
    const relaunched = await todo();
    assert.equal(Boolean(relaunched.is_completed), true);
    assert.equal(relaunched.linked_issue_number, 43);
  } finally { await db.destroy(); }
});

test('anonymous and demo submissions create neither an issue nor a submission', async () => {
  const db = await fixture();
  try {
    const routes = createTaskSubmissionRoutes({ db, services: { getOctokit: async () => { assert.fail('No external access allowed'); } } });
    for (const user of [undefined, { id: 'alice', username: 'alice' }]) {
      configureDemoMode(true);
      const value = response();
      const req = request({ repository: 'owner/repo', instruction: 'Fix it' });
      req.user = user as Request['user'];
      await routes.submit(req, value.res);
      assert.ok([401, 403].includes(value.state.status));
    }
    assert.equal((await db('task_submissions').count('* as count').first())?.count, 0);
  } finally { configureDemoMode(false); await db.destroy(); }
});


test('read-only repository users cannot create external state', async () => {
  configureDemoMode(false);
  const db = await fixture();
  try {
    const routes = createTaskSubmissionRoutes({ db, services: {
      authorize: (req, repo) => authorizeTaskSubmissionRepository(req, repo, async () => ({ permissions: { pull: true, push: false } }) as never),
      getOctokit: async () => { assert.fail('Installation token must not be used'); },
    } });
    const value = response();
    await routes.submit(request({ repository: 'owner/repo', instruction: 'Fix it' }), value.res);
    assert.equal(value.state.status, 404);
    assert.equal((await db('task_submissions').count('* as count').first())?.count, 0);
  } finally { await db.destroy(); }
});

test('attachment processing persists worker-readable bytes before publishing the trigger', async () => {
  configureDemoMode(false);
  const db = await fixture();
  const filename = path.join(process.cwd(), 'temp_uploads', randomUUID());
  await fs.outputFile(filename, 'Expected invoice format: DD/MM/YYYY');
  let issueBody = '';
  try {
    const routes = createTaskSubmissionRoutes({ db, services: {
      authorize: async () => ({ id: 'repo', name: 'owner/repo', enabled: true }),
      routing: async () => ({ agentAlias: 'agent', model: 'model', routingLabel: 'llm-agent-model' }),
      processingLabels: async () => ['AI'], enqueue: async () => undefined,
      getOctokit: async () => ({ request: async (route: string, body: Record<string, unknown>) => {
        if (route === 'POST /repos/{owner}/{repo}/issues') {
          issueBody = String(body.body);
          const row = await db('task_submissions').first();
          const attachments = JSON.parse(row.attachments);
          assert.equal(Buffer.from(attachments[0].content, 'base64').toString(), 'Expected invoice format: DD/MM/YYYY');
          assert.ok(issueBody.includes(`.propr/assets/${row.id}/${attachments[0].id}.txt`));
          return { data: { number: 42, html_url: 'https://github.com/owner/repo/issues/42' } };
        }
        if (route.endsWith('/labels') && (body.labels as string[]).includes('AI')) {
          assert.ok(issueBody.includes('invoice.txt'));
          assert.equal((await db('task_submissions').first()).issue_number, 42);
        }
        if (route.endsWith('/timeline')) return { data: [] };
        return { data: {} };
      } }) as never,
    } });
    const req = request({ repository: 'owner/repo', instruction: 'Fix invoice dates' });
    req.files = [{ path: filename, originalname: 'invoice.txt', mimetype: 'text/plain', size: 34 }] as Request['files'];
    const value = response();
    await routes.submit(req, value.res);
    assert.equal(value.state.body.state, 'queued');
    assert.equal(await fs.pathExists(filename), false);
  } finally { await fs.remove(filename); await db.destroy(); }
});

test('submitted images are embedded in the issue through GitHub attachments', async () => {
  configureDemoMode(false);
  const db = await fixture();
  const uploads: Array<{ name: string; contentType: string; body: string; authToken: string; repositoryId: number }> = [];
  let issueBody = '';
  try {
    const image = { id: 'image-1', originalName: 'pasted [screen]\n<shot>.png', mimeType: 'image/webp', extension: '.webp', content: Buffer.from('webp-bytes').toString('base64') };
    const text = { id: 'text-1', originalName: 'notes.txt', mimeType: 'text/plain', extension: '.txt', content: Buffer.from('notes').toString('base64') };
    const row = await insertTaskSubmission(db, {
      user_id: 'alice', submission_key: 'stable-key', payload_hash: 'hash', repository: 'owner/repo', attachments: JSON.stringify([image, text]),
      payload: JSON.stringify({ instruction: 'Match the screenshot', username: 'alice', trigger: 'AI', routingLabel: 'llm-agent-model' }),
    });
    const routes = createTaskSubmissionRoutes({ db, services: {
      authorize: async () => ({ id: 'repo', name: 'owner/repo', enabled: true }),
      routing: async () => ({ agentAlias: 'agent', model: 'model', routingLabel: 'llm-agent-model' }),
      processingLabels: async () => ['AI'], enqueue: async () => undefined,
      images: {
        resolveToken: async () => 'user-token',
        upload: async options => { uploads.push({ ...options, body: options.body.toString() }); return 'https://github.com/user-attachments/assets/abc-123'; },
      },
      getOctokit: async () => ({ request: async (route: string, body: Record<string, unknown>) => {
        if (route === 'GET /repos/{owner}/{repo}') return { data: { id: 99 } };
        if (route === 'POST /repos/{owner}/{repo}/issues') {
          issueBody = String(body.body);
          return { data: { number: 42, html_url: 'https://github.com/owner/repo/issues/42' } };
        }
        if (route.endsWith('/timeline')) return { data: [] };
        return { data: {} };
      } }) as never,
    } });
    const value = response();
    await routes.retry(request({}), value.res);
    assert.equal(value.state.body.state, 'queued');
    assert.deepEqual(uploads, [{ name: 'image-1.webp', contentType: 'image/webp', body: 'webp-bytes', authToken: 'user-token', repositoryId: 99 }]);
    assert.ok(issueBody.includes(`- "pasted [screen]\\n<shot>.png": .propr/assets/${row.id}/image-1.webp`));
    assert.ok(issueBody.includes(`- "notes.txt": .propr/assets/${row.id}/text-1.txt`));
    assert.ok(issueBody.includes('![pasted \\[screen\\] \\<shot\\>.png](https://github.com/user-attachments/assets/abc-123)'));
    assert.ok(issueBody.endsWith(`\n<!-- propr-task-submission:${row.id} -->`));
  } finally { await db.destroy(); }
});

test('image embedding is best effort and never blocks issue creation', async () => {
  const image = { id: 'image-1', originalName: 'a.png', mimeType: 'image/webp', extension: '.webp', content: Buffer.from('bytes').toString('base64') };
  const octokit = { request: async () => ({ data: { id: 99 } }) } as never;
  const missingToken = await uploadSubmissionImages(octokit, { owner: 'owner', repo: 'repo' }, [image], {
    resolveToken: async () => { throw new Error('No GitHub user credential is configured'); },
    upload: async () => assert.fail('Uploads require a credential'),
  });
  assert.equal(missingToken.size, 0);
  const rejected = await uploadSubmissionImages(octokit, { owner: 'owner', repo: 'repo' }, [image, { ...image, id: 'image-2' }], {
    resolveToken: async () => 'token',
    upload: async ({ name }) => { if (name === 'image-1.webp') throw new Error('HTTP 500'); return 'https://github.com/user-attachments/assets/ok'; },
  });
  assert.deepEqual([...rejected], [['image-2', 'https://github.com/user-attachments/assets/ok']]);
  const noImages = await uploadSubmissionImages({ request: async () => assert.fail('Text-only submissions need no GitHub request') } as never,
    { owner: 'owner', repo: 'repo' }, [{ ...image, extension: '.txt' }], { resolveToken: async () => assert.fail('No token needed') });
  assert.equal(noImages.size, 0);
});


test('interrupted dispatch reconciles published triggers and receipts before resuming the same issue', async () => {
  configureDemoMode(false);
  for (const stage of ['before-trigger', 'after-trigger', 'after-enqueue', 'after-receipt', 'after-task', 'unconfirmed-trigger']) {
    const db = await fixture();
    const calls: string[] = [];
    const jobs = new Set(stage === 'after-enqueue' ? ['issue-owner-repo-42'] : []);
    let queues = 0;
    try {
      const row = await insertTaskSubmission(db, {
        user_id: 'alice', submission_key: 'stable-key', payload_hash: 'hash', repository: 'owner/repo', attachments: '[]',
        payload: JSON.stringify({ trigger: 'AI', routingLabel: 'llm-agent-model', baseBranch: 'release' }),
      });
      await db('task_submissions').where({ id: row.id }).update({
        issue_number: 42, state: 'issue_created', dispatch_claim: 'interrupted-attempt',
        dispatch_complete: stage === 'after-receipt', task_id: stage === 'after-task' ? 'existing-task' : null,
      });
      const routes = createTaskSubmissionRoutes({ db, services: {
        authorize: async () => ({ id: 'repo', name: 'owner/repo', enabled: true }),
        routing: async () => ({ agentAlias: 'agent', model: 'model', routingLabel: 'llm-agent-model' }),
        getOctokit: async () => ({ request: async (route: string, params: Record<string, unknown>) => {
          calls.push(route);
          assert.equal(params.issue_number, 42);
          if (route.endsWith('/timeline')) {
            if (stage === 'unconfirmed-trigger') throw new Error('GitHub unavailable');
            if (stage === 'before-trigger') return { data: [] };
            // The original label is no longer present, but its event remains on page two.
            if (params.page === 1) return { data: Array.from({ length: 100 }, () => ({ event: 'commented' })) };
            return { data: [{ event: 'labeled', label: { name: 'AI' } }] };
          }
          assert.ok(route.endsWith('/labels'));
          return { data: {} };
        } }) as never,
        enqueue: async args => {
          queues++;
          assert.equal(args.correlationId, row.id);
          jobs.add(`issue-${args.owner}-${args.repo}-${args.issueNumber}`);
        },
      } });
      const value = response();
      await routes.retry(request({}), value.res);
      assert.equal(value.state.status, 200, stage);
      assert.equal(value.state.body.issueNumber, 42);
      assert.equal(await db('task_submissions').count('* as count').first().then(result => result?.count), 1);
      assert.equal(calls.filter(route => route.endsWith('/labels')).length, stage === 'before-trigger' ? 3 : 0);
      const shouldEnqueue = ['before-trigger', 'after-trigger', 'after-enqueue'].includes(stage);
      assert.equal(queues, shouldEnqueue ? 1 : 0);
      assert.equal(jobs.size, shouldEnqueue ? 1 : 0);
      if (stage === 'unconfirmed-trigger') {
        assert.equal(value.state.body.state, 'failed');
        assert.match(String(value.state.body.error), /GitHub unavailable/);
      }
    } finally { await db.destroy(); }
  }
});

test('automation opt-ins label the issue before the trigger and keep ultrafix bounds tied to the opt-in', async () => {
  configureDemoMode(false);
  const cases = [
    { key: 'plain', body: {}, labels: [['llm-issue-agent-model'], ['base-release'], ['AI']], stored: {} },
    { key: 'ultrafix', body: { runUltrafix: true }, labels: [['llm-issue-agent-model'], ['base-release'], ['ultrafix'], ['AI']],
      stored: { runUltrafix: true, ultrafixGoal: null, ultrafixMaxCycles: null } },
    { key: 'bounded', body: { runUltrafix: true, ultrafixGoal: 7, ultrafixMaxCycles: 4, autoMerge: true },
      labels: [['llm-issue-agent-model'], ['base-release'], ['auto-merge'], ['ultrafix'], ['AI']],
      stored: { autoMerge: true, runUltrafix: true, ultrafixGoal: 7, ultrafixMaxCycles: 4 } },
  ];
  for (const scenario of cases) {
    const db = await fixture();
    const calls: Array<{ route: string; body: Record<string, unknown> }> = [];
    const routes = createTaskSubmissionRoutes({ db, services: {
      authorize: async () => ({ id: 'repo', name: 'owner/repo', enabled: true, baseBranch: 'release' }),
      routing: async () => ({ agentAlias: 'issue-agent', model: 'issue-model', routingLabel: 'llm-issue-agent-model' }),
      getOctokit: async () => ({ request: async (route: string, body: Record<string, unknown>) => {
        calls.push({ route, body });
        if (route.endsWith('/issues')) return { data: { number: 42, html_url: 'https://github.com/owner/repo/issues/42' } };
        return { data: {} };
      } }) as never,
      processingLabels: async () => ['AI'],
      enqueue: async () => undefined,
    } });
    try {
      const value = response();
      await routes.submit(request({ repository: 'owner/repo', instruction: 'Fix invoice dates', ...scenario.body }, scenario.key), value.res);
      assert.equal(value.state.body.state, 'queued', scenario.key);
      assert.deepEqual(calls.filter(call => call.route.endsWith('/labels')).map(call => call.body.labels), scenario.labels, scenario.key);
      const payload = JSON.parse((await db('task_submissions').first()).payload);
      assert.deepEqual(Object.fromEntries(['autoMerge', 'runUltrafix', 'ultrafixGoal', 'ultrafixMaxCycles']
        .filter(field => payload[field] !== undefined).map(field => [field, payload[field]])), scenario.stored, scenario.key);
    } finally { await db.destroy(); }
  }
});

test('automation options are rejected when malformed, out of range, or bounded without an ultrafix opt-in', async () => {
  configureDemoMode(false);
  const db = await fixture();
  const routes = createTaskSubmissionRoutes({ db, services: {
    authorize: async () => ({ id: 'repo', name: 'owner/repo', enabled: true, baseBranch: 'release' }),
    getOctokit: async () => { assert.fail('Rejected options must not reach GitHub'); },
  } });
  try {
    const invalid = [
      { runUltrafix: 'yes' }, { autoMerge: 'yes' },
      { runUltrafix: true, ultrafixGoal: 0 }, { runUltrafix: true, ultrafixGoal: 11 }, { runUltrafix: true, ultrafixGoal: 4.5 },
      { runUltrafix: true, ultrafixMaxCycles: 0 }, { runUltrafix: true, ultrafixMaxCycles: 11 },
      // Bounds without the opt-in would silently do nothing.
      { ultrafixGoal: 9 }, { ultrafixMaxCycles: 3 }, { runUltrafix: false, ultrafixGoal: 9 },
    ];
    for (const options of invalid) {
      const value = response();
      await routes.submit(request({ repository: 'owner/repo', instruction: 'Fix it', ...options }), value.res);
      assert.equal(value.state.status, 400, JSON.stringify(options));
    }
    const bounded = response();
    await routes.submit(request({ repository: 'owner/repo', instruction: 'Fix it', ultrafixGoal: 9 }), bounded.res);
    assert.match(String(bounded.state.body.error), /runUltrafix must be true/);
    assert.equal((await db('task_submissions').count('* as count').first())?.count, 0);
  } finally { await db.destroy(); }
});
