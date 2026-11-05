/* eslint-disable max-lines -- related lifecycle regression cases share the same fixtures and module mocks */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import knex from 'knex';
import fs from 'fs-extra';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { closeConnection, insertTaskSubmission } from '@propr/core';
import { up } from '../../core/src/db/migrations/20260922000000_add_task_submissions.js';
import { up as identityMigration } from '../../core/src/db/migrations/20260922010000_preserve_task_submission_identity.js';
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
    // Seed the pre-extension identity for an in-flight replay across upgrade.
    const legacyIdentity = { repository: 'owner/repo', instruction, agentAlias: '', model: '', todoIds: ['todo-1'], files: [] };
    await db('task_submissions').where({ submission_key: 'stable-key' }).update({ payload_hash: createHash('sha256').update(JSON.stringify(legacyIdentity)).digest('hex') });
    const duplicate = response();
    await routes.submit(request({ repository: 'owner/repo', instruction, todoIds: ['todo-1'] }), duplicate.res);
    assert.equal(duplicate.state.body.id, first.state.body.id);
    const noSelectionReplay = response();
    await routes.submit(request({ repository: 'owner/repo', instruction, todoIds: ['todo-1'], extensionProfile: null }), noSelectionReplay.res);
    assert.equal(noSelectionReplay.state.status, 200);
    assert.equal(noSelectionReplay.state.body.id, first.state.body.id, 'an explicit absent selection retains the pre-upgrade identity');
    assert.equal(calls.filter(call => call.route === 'POST /repos/{owner}/{repo}/issues').length, 1);
    assert.equal(queues, 2);
    const changed = response();
    await routes.submit(request({ repository: 'owner/repo', instruction: 'changed' }), changed.res);
    assert.equal(changed.state.status, 409);
    assert.equal(await db.schema.hasTable('goals'), false);
    assert.equal(await db.schema.hasTable('task_drafts'), false);
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


test('submission routing rejects extension selections on unsupported runtimes before routing side effects', async () => {
  const { routing } = await import('../routes/taskSubmissionRoutes.js');
  const extensionProfile = { instanceId: 'instance', profileId: 'profile', revision: 1 };
  for (const type of ['vibe', 'opencode', 'antigravity', 'claude', 'codex']) {
    const registry = { ensureInitialized: async () => undefined, getAgentByAlias: () => ({ config: { alias: 'selected', type, enabled: true, defaultModel: 'model', supportedModels: ['model'] } }) } as never;
    let labelCalls = 0;
    const labels = async () => { labelCalls++; return 'llm-selected'; };
    if (['claude', 'codex'].includes(type)) {
      assert.equal((await routing({ agentAlias: 'selected', extensionProfile }, registry, labels, async () => ({ agentAlias: 'selected', model: 'model' }))).agentAlias, 'selected');
    } else {
      await assert.rejects(routing({ agentAlias: 'selected', extensionProfile }, registry, labels, async () => ({ agentAlias: 'selected', model: 'model' })), error => (error as Error & { status?: number }).status === 400 && /Claude or Codex/.test((error as Error).message));
      assert.equal(labelCalls, 0);
    }
    assert.equal((await routing({ agentAlias: 'selected' }, registry, labels)).agentAlias, 'selected');
  }
});

test('extension write choices default false, persist exact authority and cannot be replayed or substituted', async () => {
  const db = await fixture();
  const { sealSubmissionExtensions, submissionExtensionsForRun } = await import('../../core/src/services/taskSubmissionService.js');
  await db.schema.alterTable('task_submissions', t => t.text('extension_authorization'));
  const environment = { SYSTEM_TASK_SECRET: 'synthetic-submission-integrity-key' };
  const selection = { instanceId: randomUUID(), profileId: randomUUID(), revision: 1 };
  const run = { taskId: 'initial', agentAlias: 'claude', model: 'model', repository: 'owner/repo', issueNumber: 42 };
  try {
    for (const choice of [undefined, false, true]) {
      const row = await insertTaskSubmission(db, { user_id: '1', submission_key: randomUUID(), payload_hash: randomUUID(), repository: run.repository, attachments: '[]', payload: JSON.stringify({ instruction: 'Fix it', agentAlias: run.agentAlias, model: run.model, routingLabel: 'route', trigger: 'AI', username: 'admin', extensionProfile: selection, ...(choice === undefined ? {} : { extensionAllowWrite: choice }) }) });
      await sealSubmissionExtensions(db, row, environment);
      await db('task_submissions').where({ id: row.id }).update({ task_id: run.taskId, latest_task_id: run.taskId, issue_number: run.issueNumber, state: 'queued' });
      const saved = await db('task_submissions').where({ id: row.id }).first();
      assert.equal(submissionExtensionsForRun(saved, run, environment).extensionAllowWrite, choice === true);
      for (const changed of [{ agentAlias: 'codex' }, { model: 'other' }, { repository: 'other/repo' }, { issueNumber: 43 }]) assert.throws(() => submissionExtensionsForRun(saved, { ...run, ...changed }, environment), /exact run/);
      assert.deepEqual(submissionExtensionsForRun(saved, { ...run, taskId: 'replayed' }, environment), {});
      for (const changed of [{ latest_task_id: 'retry' }, { task_id: 'replacement' }, { state: 'completed' }, { extension_authorization: null }]) assert.deepEqual(submissionExtensionsForRun({ ...saved, ...changed }, run, environment), {});
      assert.throws(() => submissionExtensionsForRun({ ...saved, user_id: '2' }, run, environment), /unavailable/);
      assert.throws(() => submissionExtensionsForRun({ ...saved, payload: JSON.stringify({ ...JSON.parse(saved.payload), extensionAllowWrite: choice !== true }) }, run, environment), /exact run/);
      assert.throws(() => submissionExtensionsForRun({ ...saved, payload: JSON.stringify({ ...JSON.parse(saved.payload), extensionProfile: { ...selection, revision: 2 } }) }, run, environment), /exact run/);

      await db('task_submissions').where({ id: row.id }).delete();
    }
  } finally { await db.destroy(); }
});

test('submission API rejects implicit, malformed or unselected write escalation before side effects', async () => {
  const db = await fixture();
  const routes = createTaskSubmissionRoutes({ db, services: { authorize: async () => { assert.fail('Invalid write escalation reached repository access'); } } });
  try {
    for (const extensionAllowWrite of [true, 'true', 1, null, {}]) {
      const res = response();
      await routes.submit(request({ repository: 'owner/repo', instruction: 'Fix it', extensionAllowWrite }), res.res);
      assert.equal(res.state.status, 400);
    }
    assert.equal((await db('task_submissions')).length, 0);
  } finally { await db.destroy(); }
});

test('authenticated API seals the explicit choice and idempotency rejects changing it', async t => {
  const database = await fixture(); t.after(() => database.destroy());
  const previous = process.env.SYSTEM_TASK_SECRET; process.env.SYSTEM_TASK_SECRET = 'synthetic-api-submission-key';
  t.after(() => { if (previous === undefined) delete process.env.SYSTEM_TASK_SECRET; else process.env.SYSTEM_TASK_SECRET = previous; });
  await database.schema.alterTable('task_submissions', c => c.text('extension_authorization'));
  await database.schema.createTable('instance_members', c => { c.string('github_user_id'); c.string('role'); });
  await database.schema.createTable('agent_definitions', c => c.string('id').primary());
  await (await import('../../core/src/db/migrations/20261013210000_extension_profiles.js')).up(database);
  await (await import('../../core/src/db/migrations/20261013220000_extension_grant_network.js')).up(database);
  await database('instance_members').insert({ github_user_id: '1', role: 'admin' });
  const { ExtensionProfileStore } = await import('../../core/src/extensions/extensionProfileStore.js');
  const profile = await new ExtensionProfileStore(database).save('1', { version: 1, name: 'Write tools', enabled: true, agentScope: [], repositoryScope: [], mcpServers: [{ kind: 'https', name: 'tools', url: 'https://8.8.8.8/mcp', enabled: true, tools: ['update'], capability: 'write', authentication: 'none' }], skillBundleIds: [] });
  const extensionProfile = { instanceId: profile.instanceId, profileId: profile.profileId, revision: profile.revision };
  let issue = 41; let sideEffects = 0;
  const routes = createTaskSubmissionRoutes({ db: database, services: {
    authorize: async () => ({ id: 'repo', name: 'owner/repo', enabled: true, baseBranch: 'main' }),
    routing: async () => ({ agentAlias: 'claude', model: 'model', routingLabel: 'route', runtime: 'claude' }),
    getOctokit: async () => ({ request: async (route: string) => { sideEffects++; return { data: route === 'POST /repos/{owner}/{repo}/issues' ? { number: ++issue, html_url: 'https://github.com/owner/repo/issues/' + issue } : {} }; } }) as never,
    processingLabels: async () => ['AI'], enqueue: async () => {},
  } });
  for (const choice of [false, true]) {
    const key = randomUUID(); const body = { repository: 'owner/repo', instruction: 'Update documentation', extensionProfile, extensionAllowWrite: choice };
    const make = (input: unknown) => { const req = request(input, key, { id: '1', username: 'admin' }); req.get = ((name: string) => name === 'X-ProPR-Extensions' ? '1' : key) as Request['get']; return req; };
    const first = response(); await routes.submit(make(body), first.res); assert.equal(first.state.status, 200);
    const saved = await database('task_submissions').where({ submission_key: key }).first(); assert.ok(saved.extension_authorization); assert.equal(JSON.parse(saved.payload).extensionAllowWrite, choice);
    const before = sideEffects;
    const changed = response(); await routes.submit(make({ ...body, extensionAllowWrite: !choice }), changed.res); assert.equal(changed.state.status, 409); assert.equal(sideEffects, before);
    const replay = response(); await routes.submit(make(body), replay.res); assert.equal(replay.state.body.id, first.state.body.id); assert.equal(sideEffects, before);
    assert.ok(!JSON.stringify(replay.state.body).includes(saved.extension_authorization));
  }

});


test('extension scope preflight rejects mismatches and rechecks awaited boundaries without losing reconciliation', async t => {
  const database = await fixture(); t.after(() => database.destroy());
  const previous = process.env.SYSTEM_TASK_SECRET; process.env.SYSTEM_TASK_SECRET = 'synthetic-api-submission-key';
  t.after(() => { if (previous === undefined) delete process.env.SYSTEM_TASK_SECRET; else process.env.SYSTEM_TASK_SECRET = previous; });
  await database.schema.alterTable('task_submissions', c => c.text('extension_authorization'));
  await database.schema.createTable('instance_members', c => { c.string('github_user_id'); c.string('role'); });
  await database.schema.createTable('agent_definitions', c => c.string('id').primary());
  await (await import('../../core/src/db/migrations/20261013210000_extension_profiles.js')).up(database);
  await (await import('../../core/src/db/migrations/20261013220000_extension_grant_network.js')).up(database);
  await database('instance_members').insert({ github_user_id: '1', role: 'admin' });
  const { ExtensionProfileStore } = await import('../../core/src/extensions/extensionProfileStore.js');
  let sideEffects = 0;
  const routes = createTaskSubmissionRoutes({ db: database, services: {
    authorize: async () => ({ id: 'repo', name: 'owner/repo', enabled: true, baseBranch: 'main' }),
    routing: async () => ({ agentAlias: 'claude', model: 'model', routingLabel: 'route', runtime: 'claude' }),
    getOctokit: async () => ({ request: async (route: string) => { sideEffects++; assert.fail(`Unexpected GitHub call before scope rejection: ${route}`); } }) as never,
    processingLabels: async () => ['AI'], enqueue: async () => {},
  } });
  const store = new ExtensionProfileStore(database);
  const make = (profile: { instanceId: string; profileId: string; revision: number }, key = randomUUID()) => {
    const req = request({ repository: 'owner/repo', instruction: 'Scoped task', extensionProfile: { instanceId: profile.instanceId, profileId: profile.profileId, revision: profile.revision } }, key, { id: '1', username: 'admin' });
    req.get = ((name: string) => name === 'X-ProPR-Extensions' ? '1' : key) as Request['get'];
    return req;
  };
  for (const scope of [{ agentScope: ['other'], repositoryScope: [] }, { agentScope: [], repositoryScope: ['owner/other'] }]) {
    const scoped = await store.save('1', { version: 1, name: 'Scoped', enabled: true, ...scope, mcpServers: [], skillBundleIds: [] });
    const rejected = response(); const before = sideEffects;
    await routes.submit(make(scoped), rejected.res);
    assert.equal(rejected.state.status, 400);
    assert.match(String(rejected.state.body.error), /scope does not match/);
    assert.equal(sideEffects, before);
    assert.equal(await database('task_submissions').count('* as count').first().then(row => row?.count), 0);
  }
  // A prepared retry must use its durable payload, including the resolved alias.
  const scoped = await store.save('1', { version: 1, name: 'Retry scope', enabled: true, agentScope: ['other'], repositoryScope: [], mcpServers: [], skillBundleIds: [] });
  const pending = await insertTaskSubmission(database, { user_id: '1', submission_key: randomUUID(), payload_hash: 'pending', repository: 'owner/repo', attachments: '[]', payload: JSON.stringify({ instruction: 'Retry', agentAlias: 'claude', model: 'model', routingLabel: 'route', trigger: 'AI', username: 'admin', extensionProfile: { instanceId: scoped.instanceId, profileId: scoped.profileId, revision: scoped.revision } }) });
  const retryReq = make(scoped, pending.submission_key); const retryResult = response(); const beforeRetry = sideEffects;
  await routes.retry(retryReq, retryResult.res);
  assert.equal(retryResult.state.status, 400); assert.equal(sideEffects, beforeRetry);
  assert.equal((await database('task_submissions').where({ id: pending.id }).first()).state, 'prepared');
  const scopedInput = { version: 1 as const, name: 'Boundary scope', enabled: true, agentScope: ['claude'], repositoryScope: ['OWNER/REPO'], mcpServers: [], skillBundleIds: [] };
  const boundaryProfile = await store.save('1', scopedInput);
  let octokitReads = 0; let posts = 0;
  const boundaryRoutes = createTaskSubmissionRoutes({ db: database, services: {
    authorize: async () => ({ id: 'repo', name: 'owner/repo', enabled: true, baseBranch: 'main' }),
    routing: async () => ({ agentAlias: 'claude', model: 'model', routingLabel: 'route', runtime: 'claude' }),
    getOctokit: async () => {
      if (++octokitReads === 2) await store.save('1', { ...scopedInput, enabled: false }, {}, { instanceId: boundaryProfile.instanceId, profileId: boundaryProfile.profileId, revision: boundaryProfile.revision });
      return { request: async (route: string) => { if (route.startsWith('POST')) posts++; return { data: {} }; } } as never;
    }, processingLabels: async () => ['AI'], enqueue: async () => {},
  } });
  const boundaryResult = response(); const boundaryReq = make(boundaryProfile);
  await boundaryRoutes.submit(boundaryReq, boundaryResult.res);
  assert.equal(boundaryResult.state.status, 400); assert.equal(posts, 0);
  const boundaryRow = await database('task_submissions').where({ submission_key: boundaryReq.params.key }).first();
  assert.equal(boundaryRow.state, 'prepared'); assert.equal(boundaryRow.issue_number, null);
  const uploadProfile = await store.save('1', scopedInput);
  const uploadPending = await insertTaskSubmission(database, { user_id: '1', submission_key: randomUUID(), payload_hash: 'upload', repository: 'owner/repo', payload: JSON.stringify({ instruction: 'Upload', agentAlias: 'claude', model: 'model', routingLabel: 'route', trigger: 'AI', username: 'admin', extensionProfile: { instanceId: uploadProfile.instanceId, profileId: uploadProfile.profileId, revision: uploadProfile.revision } }), attachments: JSON.stringify([{ id: 'image', originalName: 'image.png', mimeType: 'image/png', extension: '.png', content: Buffer.from('fixture').toString('base64') }]) });
  const uploadRoutes = createTaskSubmissionRoutes({ db: database, services: {
    authorize: async () => ({ id: 'repo', name: 'owner/repo', enabled: true, baseBranch: 'main' }),
    routing: async () => ({ agentAlias: 'claude', model: 'model', routingLabel: 'route', runtime: 'claude' }),
    getOctokit: async () => ({ request: async (route: string) => { if (route.startsWith('POST')) posts++; return { data: { id: 1 } }; } }) as never,
    images: { resolveToken: async () => 'fixture-upload-token', upload: async () => {
      await store.save('1', { ...scopedInput, enabled: false }, {}, { instanceId: uploadProfile.instanceId, profileId: uploadProfile.profileId, revision: uploadProfile.revision });
      return 'https://github.com/user-attachments/assets/fixture';
    } }, enqueue: async () => {},
  } });
  const uploadResult = response(); await uploadRoutes.retry(make(uploadProfile, uploadPending.submission_key), uploadResult.res);
  assert.equal(posts, 0);
  const afterUpload = await database('task_submissions').where({ id: uploadPending.id }).first();
  assert.equal(afterUpload.state, 'prepared'); assert.equal(afterUpload.issue_number, null);
  assert.match(afterUpload.error, /disabled, deleted or superseded/);
  const bearerProfile = await store.save('1', { ...scopedInput, mcpServers: [{ kind: 'https', name: 'auth', url: 'https://8.8.8.8/mcp', enabled: true, tools: ['lookup'], capability: 'read', authentication: 'bearer' }] });
  const bearerResult = response(); const beforeBearer = sideEffects;
  await routes.submit(make(bearerProfile), bearerResult.res);
  assert.equal(bearerResult.state.status, 400); assert.equal(sideEffects, beforeBearer);
  assert.match(String(bearerResult.state.body.error), /authentication is not configured/);
  // Refusals after attachment upload still precede the GitHub POST. Preserve
  // prepared state for every local ExtensionError, including demotion/503.
  const { ExtensionError } = await import('../../core/src/extensions/extensionProfileStore.js');
  for (const status of [403, 503, 404]) {
    const localPending = await insertTaskSubmission(database, { user_id: '1', submission_key: randomUUID(), payload_hash: `local-${status}`, repository: 'owner/repo', payload: uploadPending.payload, attachments: uploadPending.attachments });
    // Use a live selection so only the final awaited boundary refuses.
    const live = await store.save('1', scopedInput);
    await database('task_submissions').where({ id: localPending.id }).update({ payload: JSON.stringify({ ...JSON.parse(localPending.payload), extensionProfile: { instanceId: live.instanceId, profileId: live.profileId, revision: live.revision } }) });
    const original = ExtensionProfileStore.prototype.assertLaunch;
    let checks = 0;
    const mocked = t.mock.method(ExtensionProfileStore.prototype, 'assertLaunch', async function (...args: Parameters<typeof original>) {
      if (++checks === 2) throw new ExtensionError(status, 'Local extension refusal');
      return original.apply(this, args);
    });
    const localRoutes = createTaskSubmissionRoutes({ db: database, services: {
      authorize: async () => ({ id: 'repo', name: 'owner/repo', enabled: true, baseBranch: 'main' }),
      routing: async () => ({ agentAlias: 'claude', model: 'model', routingLabel: 'route', runtime: 'claude' }),
      getOctokit: async () => ({ request: async () => assert.fail('A local refusal must not POST or reconcile') }) as never,
      images: { resolveToken: async () => 'fixture', upload: async () => 'https://github.com/user-attachments/assets/fixture' }, enqueue: async () => {},
    } });
    await localRoutes.retry(make(live, localPending.submission_key), response().res);
    mocked.mock.restore();
    assert.equal(checks, 2);
    const row = await database('task_submissions').where({ id: localPending.id }).first();
    assert.equal(row.state, 'prepared'); assert.equal(row.issue_number, null); assert.match(row.error, /Local extension refusal/);
  }
  // Ambiguous external creation still needs reconciliation after scope changes.
  await database('task_submissions').where({ id: pending.id }).update({ state: 'creating' });
  const { submissionMarker } = await import('../../core/src/services/taskSubmissionService.js');
  const reconcileRoutes = createTaskSubmissionRoutes({ db: database, services: {
    authorize: async () => ({ id: 'repo', name: 'owner/repo', enabled: true, baseBranch: 'main' }),
    routing: async () => ({ agentAlias: 'claude', model: 'model', routingLabel: 'route', runtime: 'claude' }),
    getOctokit: async () => ({ request: async (route: string) => {
      if (route === 'POST /repos/{owner}/{repo}/issues') assert.fail('Never create another issue for an ambiguous attempt');
      if (route === 'GET /repos/{owner}/{repo}/issues') return { data: [{ number: 99, html_url: 'https://github.com/owner/repo/issues/99', body: submissionMarker(pending.id) }] };
      return { data: [] };
    } }) as never, enqueue: async () => {},
  } });
  const reconciled = response(); await reconcileRoutes.retry(retryReq, reconciled.res);
  assert.equal(reconciled.state.status, 200); assert.equal(reconciled.state.body.issueNumber, 99);
  assert.equal((await database('task_submissions').where({ id: pending.id }).first()).state, 'queued');

});

test('extension submission routing rejects label round trips that change the alias or model', async () => {
  const { routing } = await import('../routes/taskSubmissionRoutes.js');
  const registry = { ensureInitialized: async () => undefined, getAgentByAlias: () => ({ config: { alias: 'selected', type: 'codex', enabled: true, supportedModels: ['model'] } }) } as never;
  const body = { agentAlias: 'selected', model: 'model', extensionProfile: { instanceId: 'instance', profileId: 'profile', revision: 1 } };
  for (const resolved of [{ agentAlias: 'other', model: 'model' }, { agentAlias: 'selected', model: 'other' }]) {
    await assert.rejects(routing(body, registry, async () => 'llm-selection', async label => {
      assert.equal(label, 'selection'); return resolved;
    }), error => (error as Error & { status?: number }).status === 400 && /routed exactly/.test((error as Error).message));
  }
  assert.deepEqual(await routing(body, registry, async () => 'llm-selection', async () => ({ agentAlias: 'selected', model: 'model' })), { agentAlias: 'selected', model: 'model', routingLabel: 'llm-selection', runtime: 'codex' });
});
