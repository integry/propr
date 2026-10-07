/* eslint-disable max-lines -- one suite covers every agent definition and run route, including their race regressions */
import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Request, RequestHandler, Response } from 'express';
import knex, { type Knex } from 'knex';
import {
  closeConnection,
  transitionAgentRun,
  triggerAgentRun,
  type Attachment,
  type MulterFile,
  type StoredAgentRun,
} from '@propr/core';
import { AGENT_DEFINITION_CONTRACT } from '@propr/shared';
import {
  createAgentDefinitionRoutes,
  type AgentDefinitionRouteServices,
} from '../routes/agentDefinitionRoutes.js';

after(closeConnection);

const migrations = fileURLToPath(new URL('../../core/src/db/migrations/', import.meta.url));
const NOW = Date.UTC(2026, 9, 6, 15, 0);

interface RequestOptions {
  params?: Record<string, string>;
  body?: unknown;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  files?: MulterFile[];
  authenticationMethod?: 'session' | 'instance_token' | 'github_bearer';
}

function request(userId: string | null, options: RequestOptions = {}): Request {
  const headers = Object.fromEntries(Object.entries(options.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    user: userId ? { id: userId, username: userId, accessToken: `token-${userId}` } : undefined,
    authenticationMethod: options.authenticationMethod ?? 'session',
    params: options.params ?? {},
    body: options.body ?? {},
    query: options.query ?? {},
    files: options.files,
    get: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
}

function response() {
  const state: { status: number; body?: unknown; ended: boolean } = { status: 200, ended: false };
  const res = {
    headersSent: false,
    status(code: number) { state.status = code; return this; },
    json(body: unknown) { state.body = body; state.ended = true; return this; },
    end() { state.ended = true; return this; },
  } as unknown as Response;
  return { res, state };
}

async function call(route: RequestHandler, req: Request) {
  const { res, state } = response();
  await route(req, res, () => undefined);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- assertions read arbitrary JSON bodies
  return state as { status: number; body: any; ended: boolean };
}

describe('agent definition routes', () => {
  let database: Knex;
  let accessible: Set<string>;
  let verified: Array<{ repository: string; token: string }>;
  let stopped: string[];
  let enqueued: string[];
  let runtimeError: string | null;
  let removedFiles: Array<{ definitionId: string; attachments: readonly Attachment[] | 'all' }>;
  let routes: ReturnType<typeof createAgentDefinitionRoutes>;

  const services = (): AgentDefinitionRouteServices => ({
    now: () => NOW,
    resolveToken: async req => String(req.user!.accessToken),
    verifyAccess: async (repository, token) => {
      verified.push({ repository, token });
      if (!accessible.has(repository)) throw Object.assign(new Error('Not Found'), { status: 404 });
    },
    validateRuntime: async () => runtimeError,
    trigger: input => triggerAgentRun(input, {
      database, now: () => NOW,
      enqueue: async (_name, data) => { enqueued.push(data.runId); },
      loadRepos: async () => [...accessible].map(name => ({ id: name, name, enabled: true }) as never), loadAgents: async () => [], loadSyntheticAgents: async () => [],
    }),
    stopTask: async taskId => {
      stopped.push(taskId);
      return {} as never;
    },
    processUpload: async (file, definitionId) => ({
      id: `att-${file.originalname}`, originalName: file.originalname,
      storedPath: `storage/agent-definitions/${definitionId}/${file.originalname}`,
      mimeType: 'text/plain', size: file.size, tokenEstimate: 1, type: 'text',
    }),
    removeTemporaryUploads: async () => undefined,
    removeAttachmentFiles: async (definitionId, attachments) => { removedFiles.push({ definitionId, attachments }); },
    gate: () => null,
    evaluateCapacity: async definition => ({ threshold: 90, capacity: { status: 'near_limit', provider: definition.agentAlias ?? 'claude', sessionPercent: 95 } }),
  });

  beforeEach(async () => {
    database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    await database.raw('PRAGMA foreign_keys = ON');
    await database.migrate.latest({ directory: migrations });
    accessible = new Set(['acme/app', 'acme/lib']);
    verified = [];
    stopped = [];
    enqueued = [];
    runtimeError = null;
    removedFiles = [];
    routes = createAgentDefinitionRoutes({ db: database, services: services() });
  });

  afterEach(async () => {
    await database.destroy();
  });

  async function createDefinition(owner = 'alice', body: Record<string, unknown> = {}) {
    const created = await call(routes.create, request(owner, {
      body: { name: 'Triage', prompt: 'Summarize new issues', repositories: ['acme/app'], ...body },
    }));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    return created.body.definition as { id: string; revision: number; [key: string]: unknown };
  }

  /** Run `action` as soon as a matching query has answered, before the waiting caller resumes. */
  function afterQuery(matches: (sql: string) => boolean, action: () => Promise<unknown>): Promise<void> {
    return new Promise((resolve, reject) => {
      const listener = (_response: unknown, query: { sql: string }) => {
        if (!matches(query.sql)) return;
        database.off('query-response', listener);
        action().then(() => resolve(), reject);
      };
      database.on('query-response', listener);
    });
  }

  function deferred() {
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    return { promise, release };
  }

  async function storedAttachmentIds(definitionId: string): Promise<string[]> {
    const row = await database('agent_definitions').where({ id: definitionId }).first();
    return (JSON.parse(row.attachments) as Attachment[]).map(attachment => attachment.id);
  }

  async function triggerRun(definitionId: string, key?: string, owner = 'alice') {
    return call(routes.triggerRun, request(owner, {
      params: { id: definitionId },
      headers: key ? { 'Idempotency-Key': key } : {},
    }));
  }

  test('CRUD round-trip for the owner maps the shared input contract onto the store', async () => {
    const definition = await createDefinition('alice', {
      description: 'Daily digest', schedule: '@daily', autonomy: 'preview', capabilities: ['repository_read', 'web'],
      agentId: 'claude', model: 'opus', previousReportCount: 2,
    });
    assert.equal(definition.ownerId, 'alice');
    assert.deepEqual(definition.repositories, ['acme/app']);
    assert.equal(definition.scheduleCron, '@daily');
    assert.equal(definition.scheduleEnabled, true);
    assert.equal(definition.nextRunAt, Date.UTC(2026, 9, 7));
    assert.equal(definition.autonomyMode, 'preview');
    assert.equal(definition.agentAlias, 'claude');
    assert.equal(definition.modelName, 'opus');
    assert.equal(definition.previousReportsLimit, 2);
    assert.equal(definition.includePreviousReports, true);
    assert.deepEqual(verified, [{ repository: 'acme/app', token: 'token-alice' }]);

    const listed = await call(routes.list, request('alice', { query: { limit: '10', offset: '0' } }));
    assert.equal(listed.status, 200);
    assert.equal(listed.body.total, 1);
    assert.equal(listed.body.definitions[0].id, definition.id);

    const read = await call(routes.get, request('alice', { params: { id: definition.id } }));
    assert.equal(read.body.definition.name, 'Triage');

    const updated = await call(routes.update, request('alice', {
      params: { id: definition.id }, body: { name: 'Renamed', schedule: null, expectedRevision: definition.revision },
    }));
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.definition.name, 'Renamed');
    assert.equal(updated.body.definition.scheduleEnabled, false);
    assert.equal(updated.body.definition.nextRunAt, null);
    assert.equal(updated.body.definition.revision, definition.revision + 1);

    const stale = await call(routes.update, request('alice', {
      params: { id: definition.id }, body: { name: 'Stale', expectedRevision: definition.revision },
    }));
    assert.equal(stale.status, 409);

    const removed = await call(routes.remove, request('alice', { params: { id: definition.id } }));
    assert.equal(removed.status, 204);
    assert.deepEqual(removedFiles, [{ definitionId: definition.id, attachments: 'all' }]);
    const gone = await call(routes.get, request('alice', { params: { id: definition.id } }));
    assert.equal(gone.status, 404);
  });

  test('another user gets 404 on every definition and run route', async () => {
    const definition = await createDefinition('alice');
    const triggered = await triggerRun(definition.id, 'k1');
    const runId = triggered.body.run.id as string;
    const params = { id: definition.id, attachmentId: 'att-x', runId };
    const other = (body: unknown = {}) => request('mallory', { params, body });

    for (const route of [routes.get, routes.update, routes.remove, routes.uploadAttachments, routes.deleteAttachment,
      routes.triggerRun, routes.capacity, routes.listRuns, routes.getRun, routes.cancelRun]) {
      const result = await call(route, other({ name: 'Mine now' }));
      assert.equal(result.status, 404, `${route.name}: ${JSON.stringify(result.body)}`);
    }
    const listed = await call(routes.list, request('mallory'));
    assert.equal(listed.body.total, 0);
    assert.equal((await call(routes.get, request('alice', { params }))).body.definition.name, 'Triage');
  });

  test('every route requires authentication', async () => {
    for (const route of Object.values(routes)) {
      const result = await call(route, request(null, { params: { id: 'x', runId: 'y', attachmentId: 'z' } }));
      assert.equal(result.status, 401);
    }
  });

  test('serves the definition contract', async () => {
    const result = await call(routes.contract, request('alice'));
    assert.deepEqual(result.body, AGENT_DEFINITION_CONTRACT);
  });

  test('rejects invalid input and runtime-invalid definitions with 400', async () => {
    const invalid = await call(routes.create, request('alice', { body: { name: '', prompt: 'x' } }));
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error, 'name is required');

    const tooFrequent = await call(routes.create, request('alice', { body: { name: 'a', prompt: 'b', schedule: '* * * * *' } }));
    assert.equal(tooFrequent.status, 400);

    runtimeError = 'Repositories are not enabled: acme/app';
    const runtime = await call(routes.create, request('alice', { body: { name: 'a', prompt: 'b', repositories: ['acme/app'] } }));
    assert.deepEqual([runtime.status, runtime.body], [400, { error: 'Repositories are not enabled: acme/app', code: 'AGENT_INVALID' }]);
    assert.equal((await database('agent_definitions').count({ count: '*' }).first())?.count, 0);
  });

  test('creating or retargeting an agent over an inaccessible repository returns 404 REPOSITORY_NOT_ACCESSIBLE', async () => {
    const denied = await call(routes.create, request('alice', {
      body: { name: 'Spy', prompt: 'Read it', repositories: ['acme/app', 'secret/repo'] },
    }));
    assert.deepEqual([denied.status, denied.body.code], [404, 'REPOSITORY_NOT_ACCESSIBLE']);
    assert.equal((await database('agent_definitions').count({ count: '*' }).first())?.count, 0);

    const definition = await createDefinition('alice');
    verified = [];
    const unchanged = await call(routes.update, request('alice', { params: { id: definition.id }, body: { repositories: ['ACME/app'] } }));
    assert.equal(unchanged.status, 200);
    assert.deepEqual(verified, [], 'unchanged repositories are not re-verified');

    const retarget = await call(routes.update, request('alice', { params: { id: definition.id }, body: { repositories: ['secret/repo'] } }));
    assert.deepEqual([retarget.status, retarget.body.code], [404, 'REPOSITORY_NOT_ACCESSIBLE']);

    accessible.delete('acme/app');
    const trigger = await triggerRun(definition.id, 'k');
    assert.deepEqual([trigger.status, trigger.body.code], [404, 'REPOSITORY_NOT_ACCESSIBLE']);
    assert.deepEqual(enqueued, []);
  });

  test('the trigger endpoint is idempotent: 202 then 200 with the same run', async () => {
    const definition = await createDefinition('alice');
    const first = await triggerRun(definition.id, 'gh-action-123');
    assert.equal(first.status, 202);
    assert.equal(first.body.created, true);
    assert.equal(first.body.run.state, 'queued');
    assert.equal(first.body.run.trigger, 'manual', 'browser sessions default to manual');

    const replay = await triggerRun(definition.id, 'gh-action-123');
    assert.equal(replay.status, 200);
    assert.equal(replay.body.created, false);
    assert.equal(replay.body.run.id, first.body.run.id);
    assert.deepEqual(enqueued, [first.body.run.id]);
  });

  test('trigger defaults to api for token callers, accepts cli and refuses schedule and mcp', async () => {
    const definition = await createDefinition('alice');
    const api = await call(routes.triggerRun, request('alice', {
      params: { id: definition.id }, authenticationMethod: 'instance_token', body: { source: 'github-action' },
    }));
    assert.equal(api.status, 202);
    assert.equal(api.body.run.trigger, 'api');
    assert.equal(api.body.run.triggerSource, 'github-action');

    const cli = await call(routes.triggerRun, request('alice', { params: { id: definition.id }, body: { trigger: 'cli' } }));
    assert.equal(cli.body.run.trigger, 'cli');

    for (const trigger of ['schedule', 'mcp', 'bogus']) {
      const refused = await call(routes.triggerRun, request('alice', { params: { id: definition.id }, body: { trigger } }));
      assert.equal(refused.status, 400);
    }
  });

  test('the trigger applies the cost gate and records a held run without enqueueing', async () => {
    const gated = createAgentDefinitionRoutes({ db: database, services: { ...services(),
      gate: ({ trigger }) => trigger === 'manual' ? null : { action: 'skip', reason: 'Weekly subscription usage for claude is at 95% (pause threshold 90%).' } } });
    const definition = await createDefinition('alice');
    const api = await call(gated.triggerRun, request('alice', { params: { id: definition.id }, body: { trigger: 'api' } }));
    assert.equal(api.status, 202);
    assert.equal(api.body.run.state, 'skipped');
    assert.match(api.body.run.skipReason, /^Weekly subscription usage/);
    assert.deepEqual(enqueued, []);

    const manual = await call(gated.triggerRun, request('alice', { params: { id: definition.id }, body: { trigger: 'manual' } }));
    assert.equal(manual.body.run.state, 'queued');
    assert.deepEqual(enqueued, [manual.body.run.id]);
  });

  test('capacity reports the definition agent usage and the pause threshold', async () => {
    const definition = await createDefinition('alice');
    const result = await call(routes.capacity, request('alice', { params: { id: definition.id } }));
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { threshold: 90, capacity: { status: 'near_limit', provider: definition.agentAlias ?? 'claude', sessionPercent: 95 } });
  });

  test('triggering a disabled agent maps the core error to { error, code }', async () => {
    const definition = await createDefinition('alice', { enabled: false });
    const result = await triggerRun(definition.id);
    assert.deepEqual(result.body, { error: 'Agent is disabled', code: 'AGENT_DISABLED' });
    assert.equal(result.status, 409);
  });

  test('deleting a definition with a running run returns 409', async () => {
    const definition = await createDefinition('alice');
    const runId = (await triggerRun(definition.id)).body.run.id as string;
    await transitionAgentRun(runId, ['queued'], 'running', { reportTaskId: 'task-1' }, { database });

    const refused = await call(routes.remove, request('alice', { params: { id: definition.id } }));
    assert.deepEqual([refused.status, refused.body.code], [409, 'AGENT_RUN_ACTIVE']);
    assert.ok(await database('agent_definitions').where({ id: definition.id }).first());
  });

  test('a queued run that starts while the delete is in flight blocks the delete with 409', async () => {
    const definition = await createDefinition('alice');
    const runId = (await triggerRun(definition.id)).body.run.id as string;
    // The worker starts the run right after the route has read the definition.
    const started = afterQuery(sql => /^select .*agent_definitions/i.test(sql),
      () => transitionAgentRun(runId, ['queued'], 'running', { reportTaskId: 'task-1' }, { database }));

    const refused = await call(routes.remove, request('alice', { params: { id: definition.id } }));
    await started;
    assert.deepEqual([refused.status, refused.body.code], [409, 'AGENT_RUN_ACTIVE']);
    assert.equal((await database('agent_runs').where({ id: runId }).first())?.state, 'running');
    assert.deepEqual(removedFiles, []);
  });

  test('a run starting right after the delete consults agent_runs is never orphaned', async () => {
    const definition = await createDefinition('alice');
    const runId = (await triggerRun(definition.id)).body.run.id as string;
    let startedRun: StoredAgentRun | null = null;
    // The worker starts the run right after the route's last statement that reads agent_runs.
    const started = afterQuery(sql => /agent_runs/i.test(sql) && !/^insert/i.test(sql), async () => {
      startedRun = await transitionAgentRun(runId, ['queued'], 'running', { reportTaskId: 'task-1' }, { database });
    });

    const result = await call(routes.remove, request('alice', { params: { id: definition.id } }));
    await started;
    if (result.status === 204) {
      assert.equal(startedRun, null, 'a deleted definition leaves no run for the worker to start');
    } else {
      assert.deepEqual([result.status, result.body.code], [409, 'AGENT_RUN_ACTIVE']);
      assert.equal((await database('agent_runs').where({ id: runId }).first())?.state, 'running');
    }
  });

  test('deleting a definition whose run is only queued succeeds', async () => {
    const definition = await createDefinition('alice');
    await triggerRun(definition.id);
    const removed = await call(routes.remove, request('alice', { params: { id: definition.id } }));
    assert.equal(removed.status, 204);
    assert.equal(await database('agent_definitions').where({ id: definition.id }).first(), undefined);
  });

  test('cancel moves a queued run to cancelled without stopping a task', async () => {
    const definition = await createDefinition('alice');
    const runId = (await triggerRun(definition.id)).body.run.id as string;
    const cancelled = await call(routes.cancelRun, request('alice', { params: { runId } }));
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.run.state, 'cancelled');
    assert.deepEqual(stopped, []);

    const again = await call(routes.cancelRun, request('alice', { params: { runId } }));
    assert.equal(again.status, 409);
  });

  test('cancel on a running run also stops its report task', async () => {
    const definition = await createDefinition('alice');
    const runId = (await triggerRun(definition.id)).body.run.id as string;
    await transitionAgentRun(runId, ['queued'], 'running', { reportTaskId: 'report-task-7' }, { database });
    const cancelled = await call(routes.cancelRun, request('alice', { params: { runId } }));
    assert.equal(cancelled.body.run.state, 'cancelled');
    assert.deepEqual(stopped, ['report-task-7']);
  });

  test('cancel stops the report task of a run that started after the cancel read it as queued', async () => {
    const definition = await createDefinition('alice');
    const runId = (await triggerRun(definition.id)).body.run.id as string;
    const started = afterQuery(sql => /^select .*agent_runs/i.test(sql),
      () => transitionAgentRun(runId, ['queued'], 'running', { reportTaskId: 'report-task-9' }, { database }));

    const cancelled = await call(routes.cancelRun, request('alice', { params: { runId } }));
    await started;
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.equal(cancelled.body.run.state, 'cancelled');
    assert.deepEqual(stopped, ['report-task-9']);
  });

  test('run history omits report bodies; run detail includes the report', async () => {
    const definition = await createDefinition('alice');
    const runId = (await triggerRun(definition.id)).body.run.id as string;
    await transitionAgentRun(runId, ['queued'], 'running', {}, { database });
    await transitionAgentRun(runId, ['running'], 'report_ready', { report: 'All quiet.' }, { database });

    const history = await call(routes.listRuns, request('alice', { params: { id: definition.id } }));
    assert.equal(history.body.total, 1);
    const [summary] = history.body.runs as Array<Partial<StoredAgentRun>>;
    assert.equal(summary.id, runId);
    assert.equal('report' in summary, false);
    assert.equal('definitionSnapshot' in summary, false);

    const detail = await call(routes.getRun, request('alice', { params: { runId } }));
    assert.equal(detail.body.run.report, 'All quiet.');
  });

  test('uploads and removes input files without exposing stored paths', async () => {
    const definition = await createDefinition('alice');
    const file = { originalname: 'notes.md', size: 12, path: '/tmp/upload' } as MulterFile;
    const uploaded = await call(routes.uploadAttachments, request('alice', { params: { id: definition.id }, files: [file] }));
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
    assert.equal(uploaded.body.attachments[0].id, 'att-notes.md');
    assert.equal('storedPath' in uploaded.body.attachments[0], false);
    assert.equal(uploaded.body.definition.revision, definition.revision, 'uploads do not bump the revision');
    const stored = await database('agent_definitions').where({ id: definition.id }).first();
    assert.match(stored.attachments, /storage\/agent-definitions\//);

    const tooMany = await call(routes.uploadAttachments, request('alice', {
      params: { id: definition.id }, files: Array.from({ length: 10 }, (_, index) => ({ ...file, originalname: `f${index}.md` })),
    }));
    assert.equal(tooMany.status, 400);

    const missing = await call(routes.deleteAttachment, request('alice', { params: { id: definition.id, attachmentId: 'nope' } }));
    assert.equal(missing.status, 404);
    const removed = await call(routes.deleteAttachment, request('alice', { params: { id: definition.id, attachmentId: 'att-notes.md' } }));
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.body.definition.attachments, []);
    assert.equal((removedFiles[0]?.attachments as Attachment[])[0]?.id, 'att-notes.md');
  });

  test('concurrent input file removals keep each other\'s removal', async () => {
    const definition = await createDefinition('alice');
    const files = ['a.md', 'b.md'].map(name => ({ originalname: name, size: 1, path: `/tmp/${name}` }) as MulterFile);
    await call(routes.uploadAttachments, request('alice', { params: { id: definition.id }, files }));

    const results = await Promise.all(['att-a.md', 'att-b.md'].map(attachmentId =>
      call(routes.deleteAttachment, request('alice', { params: { id: definition.id, attachmentId } }))));
    assert.deepEqual(results.map(result => result.status), [200, 200]);
    assert.deepEqual(await storedAttachmentIds(definition.id), []);
    assert.deepEqual(removedFiles.flatMap(entry => (entry.attachments as Attachment[]).map(attachment => attachment.id)).sort(),
      ['att-a.md', 'att-b.md']);
  });

  test('an upload finishing after a concurrent change appends to the current list', async () => {
    const definition = await createDefinition('alice');
    const seed = { originalname: 'old.md', size: 1, path: '/tmp/old' } as MulterFile;
    await call(routes.uploadAttachments, request('alice', { params: { id: definition.id }, files: [seed] }));

    const processing = deferred();
    const slow = createAgentDefinitionRoutes({ db: database, services: {
      ...services(),
      processUpload: async (file, definitionId) => {
        await processing.promise;
        return services().processUpload!(file, definitionId);
      },
    } });
    const upload = call(slow.uploadAttachments, request('alice', {
      params: { id: definition.id }, files: [{ originalname: 'new.md', size: 1, path: '/tmp/new' } as MulterFile],
    }));
    const removed = await call(routes.deleteAttachment, request('alice', { params: { id: definition.id, attachmentId: 'att-old.md' } }));
    assert.equal(removed.status, 200);
    processing.release();

    assert.equal((await upload).status, 201);
    assert.deepEqual(await storedAttachmentIds(definition.id), ['att-new.md'], 'the removed file is not referenced again');
  });

  test('concurrent uploads are limited against the stored list, and the loser\'s files are removed', async () => {
    const definition = await createDefinition('alice');
    const batch = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, index) => ({ originalname: `${prefix}${index}.md`, size: 1, path: '/tmp/x' }) as MulterFile);
    await call(routes.uploadAttachments, request('alice', { params: { id: definition.id }, files: batch('seed', 8) }));
    removedFiles = [];

    const processing = deferred();
    const slow = createAgentDefinitionRoutes({ db: database, services: {
      ...services(),
      processUpload: async (file, definitionId) => {
        await processing.promise;
        return services().processUpload!(file, definitionId);
      },
    } });
    const uploads = ['x', 'y'].map(prefix =>
      call(slow.uploadAttachments, request('alice', { params: { id: definition.id }, files: batch(prefix, 2) })));
    processing.release();

    const statuses = (await Promise.all(uploads)).map(result => result.status).sort();
    assert.deepEqual(statuses, [201, 400]);
    assert.equal((await storedAttachmentIds(definition.id)).length, 10);
    assert.equal(removedFiles.length, 1, 'the rejected upload removes the files it processed');
  });

  test('rejects malformed paging', async () => {
    const result = await call(routes.list, request('alice', { query: { limit: '-1' } }));
    assert.equal(result.status, 400);
  });
});
