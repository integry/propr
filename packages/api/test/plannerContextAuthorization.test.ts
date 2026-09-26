import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import type { Request, Response } from 'express';
import knex, { type Knex } from 'knex';
import { closeConnection } from '@propr/core';
import { createGenerateHandler, createRefineHandler } from '../routes/plannerActionHandlers.js';
import { createPreviewContextHandler } from '../routes/plannerHelpers/handlers/contextHandlers.js';
import { resolveEffectiveContextRepositories } from '../routes/plannerHelpers/repositoryAuthorization.js';
import { resetConfiguredDemoMode } from '../demoMode.js';

function responseRecorder() {
  const record: { status: number; body?: unknown } = { status: 200 };
  const response = {
    headersSent: false,
    status(code: number) {
      record.status = code;
      return response;
    },
    json(body: unknown) {
      record.body = body;
      return response;
    },
  } as unknown as Response;
  return { response, record };
}

function inaccessibleRepositoryError(): Error & { status: number } {
  return Object.assign(new Error('Not Found'), { status: 404 });
}

async function createPlannerDatabase(contextRepositories: string[]): Promise<Knex> {
  const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await database.schema.createTable('task_drafts', table => {
    table.text('draft_id').primary();
    table.text('user_id').notNullable();
    table.text('repository').notNullable();
    table.text('context_config');
    table.text('status');
  });
  await database('task_drafts').insert({
    draft_id: 'draft-1',
    user_id: 'user-1',
    repository: 'allowed/primary',
    context_config: JSON.stringify({
      contextRepositories: contextRepositories.map(repository => ({ repository })),
    }),
    status: 'review',
  });
  return database;
}

afterEach(() => resetConfiguredDemoMode());
after(async () => closeConnection());

test('request repositories replace saved repositories when resolving effective context', () => {
  const saved = { contextRepositories: [{ repository: 'saved/context' }] };

  assert.deepEqual(resolveEffectiveContextRepositories(saved, undefined), [{
    repository: 'saved/context',
    branch: undefined,
    description: undefined,
  }]);
  assert.deepEqual(
    resolveEffectiveContextRepositories(saved, [{ repository: 'request/context', branch: 'main' }]),
    [{ repository: 'request/context', branch: 'main', description: undefined }],
  );
  assert.deepEqual(resolveEffectiveContextRepositories(saved, []), []);
});

test('preview denies a request context repository before installation auth or cloning', async () => {
  let installationAuthCalls = 0;
  let cloneCalls = 0;
  const verified: string[] = [];
  const handler = createPreviewContextHandler({
    verifyOwnership: async () => ({
      authorized: true,
      draft: {
        repository: 'allowed/primary',
        context_config: JSON.stringify({
          contextRepositories: [{ repository: 'saved/not-effective' }],
        }),
        status: 'review',
      },
    }),
    validateInput: () => ({ valid: true }),
    resolveMetadataToken: async () => 'ghu_user-grant',
    verifyRepositoryAccess: async repository => {
      verified.push(repository);
      if (repository === 'installation-only/context') throw inaccessibleRepositoryError();
    },
    resolveRepoAuthToken: async () => {
      installationAuthCalls += 1;
      return 'ghs_installation';
    },
    cloneRepository: async () => {
      cloneCalls += 1;
      return '/tmp/should-not-clone';
    },
  });
  const recorder = responseRecorder();

  await handler({
    user: { id: 'user-1' },
    authenticationMethod: 'instance_token',
    body: {
      draftId: 'draft-1',
      prompt: 'Inspect the code',
      baseBranch: 'main',
      contextRepositories: [{ repository: 'installation-only/context' }],
    },
  } as Request, recorder.response);

  assert.equal(recorder.record.status, 404);
  assert.deepEqual(verified, ['allowed/primary', 'installation-only/context']);
  assert.equal(installationAuthCalls, 0);
  assert.equal(cloneCalls, 0);
});

test('generate denies a request context repository before repository setup', async () => {
  const database = await createPlannerDatabase(['saved/not-effective']);
  let setupCalls = 0;
  const verified: string[] = [];
  const handler = createGenerateHandler(database, {
    hasRunningContainer: async () => false,
    resolveMetadataToken: async () => 'ghu_user-grant',
    verifyRepositoryAccess: async repository => {
      verified.push(repository);
      if (repository === 'installation-only/context') throw inaccessibleRepositoryError();
    },
    setupRepository: async () => {
      setupCalls += 1;
      return { repository: 'allowed/primary', authToken: 'ghs_installation', worktreePath: '/tmp/should-not-clone' };
    },
  });
  const recorder = responseRecorder();

  try {
    await handler({
      user: { id: 'user-1' },
      authenticationMethod: 'instance_token',
      body: {
        draftId: 'draft-1',
        contextRepositories: [{ repository: 'installation-only/context' }],
      },
    } as Request, recorder.response);
  } finally {
    await database.destroy();
  }

  assert.equal(recorder.record.status, 404);
  assert.deepEqual(verified, ['allowed/primary', 'installation-only/context']);
  assert.equal(setupCalls, 0);
});

test('refine denies a saved context repository before background cloning can start', async () => {
  const database = await createPlannerDatabase(['installation-only/saved-context']);
  const verified: string[] = [];
  const handler = createRefineHandler(database, {
    hasRunningContainer: async () => false,
    resolveMetadataToken: async () => 'ghu_user-grant',
    verifyRepositoryAccess: async repository => {
      verified.push(repository);
      if (repository === 'installation-only/saved-context') throw inaccessibleRepositoryError();
    },
  });
  const recorder = responseRecorder();

  try {
    await handler({
      user: { id: 'user-1' },
      authenticationMethod: 'instance_token',
      body: {
        draftId: 'draft-1',
        plan: [],
        instruction: 'Refine the plan',
      },
    } as Request, recorder.response);
  } finally {
    await database.destroy();
  }

  assert.equal(recorder.record.status, 404);
  assert.deepEqual(verified, ['allowed/primary', 'installation-only/saved-context']);
});
