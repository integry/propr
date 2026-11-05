import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Response } from 'express';
import type { Knex } from 'knex';
import type { RedisClientType } from 'redis';
import { db } from '@propr/core';
import { createLogFiles } from '../../core/src/utils/github/logFiles.js';
import type { FlatRequest } from '../requestTypes.js';
import { createExecutionRoutes } from '../routes/executionRoutes.js';

after(() => db.destroy());

test('worker execution logs use the shared logs volume and are readable through the API', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'propr-shared-execution-logs-'));
  const previousDirectory = process.cwd();
  t.after(async () => { process.chdir(previousDirectory); await rm(directory, { recursive: true, force: true }); });
  process.chdir(directory);
  const files = await createLogFiles({
    rawOutput: 'Acceptance output\n',
    conversationLog: [{ type: 'assistant', message: { content: [{ text: 'Acceptance conversation' }] } }],
  }, { number: 6, repoOwner: 'fixture', repoName: 'acceptance' });
  t.after(() => Promise.all(Object.values(files).map(file => rm(file, { force: true }))));
  const redisClient = { get: async () => JSON.stringify({ files }) } as unknown as RedisClientType;
  const routes = createExecutionRoutes({ redisClient, db: {} as Knex });
  for (const [type, filePath] of Object.entries(files)) {
    assert.equal(path.dirname(filePath), path.join(directory, 'logs', 'executions'), 'must use the shared volume, not container-private /tmp');
    let status = 200;
    let content: unknown;
    const response = {
      status(value: number) { status = value; return response; },
      json(value: unknown) { content = value; return response; },
      send(value: unknown) { content = value; return response; },
      setHeader() { return response; },
    } as unknown as Response;
    await routes.getLogByType({ params: { sessionId: 'shared-log-acceptance', type }, query: {} } as unknown as FlatRequest, response);
    assert.equal(status, 200);
    assert.match(String(content), /Acceptance/);
    if (type === 'conversation') assert.equal(JSON.parse(String(content)).messages.length, 1);
  }
});
