import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express, { type RequestHandler } from 'express';
import type { Response } from 'express';
import type { Knex } from 'knex';
import type { RedisClientType } from 'redis';
import type { FlatRequest } from '../requestTypes.js';
import { createExecutionRoutes } from '../routes/executionRoutes.js';
import { db } from '@propr/core';
after(() => db.destroy());

test('execution API redacts old persisted preview paths in prompts, log metadata, and downloads', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'preview-log-redaction-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const local = '/tmp/work tree/.propr/previews/screen.png';
  const message = `Captured "${local}" successfully`;
  const conversation = path.join(directory, 'conversation.json');
  const output = path.join(directory, 'output.txt');
  await writeFile(conversation, JSON.stringify([{ text: message }]));
  await writeFile(output, message);
  const redisClient = { get: async (key: string) => JSON.stringify(key.includes('prompt')
    ? { prompt: message } : { files: { conversation, stdout: output }, summary: message }) } as unknown as RedisClientType;
  const routes = createExecutionRoutes({ redisClient, db: {} as Knex });
  let body: unknown;
  const response = { status(code: number) { assert.equal(code, 200); return response; },
    json(value: unknown) { body = value; return response; },
    type() { return response; },
    send(value: unknown) { body = value; return response; },
    setHeader() { return response; } } as unknown as Response;
  const request = { params: { sessionId: 'session-2283' }, query: {} } as unknown as FlatRequest;
  for (const handler of [routes.getPrompt, routes.getLogs]) {
    await handler(request, response);
    assert.ok(!JSON.stringify(body).includes(local));
    assert.match(JSON.stringify(body), /successfully/);
  }
  for (const type of ['conversation', 'stdout']) {
    await routes.getLogByType({ ...request, params: { ...request.params, type } } as FlatRequest, response);
    assert.equal(typeof body, 'string');
    assert.ok(!String(body).includes(local));
    assert.match(String(body), /successfully/);
    if (type === 'conversation') assert.equal(JSON.parse(String(body)).length, 1, 'JSON remains parseable after redaction');
  }
  await writeFile(conversation, [JSON.stringify({ text: message }), JSON.stringify({ text: 'done' })].join('\n'));
  await routes.getLogByType({ ...request, params: { ...request.params, type: 'conversation' } } as FlatRequest, response);
  assert.ok(!String(body).includes(local));
  assert.equal(String(body).split('\n').map(line => JSON.parse(line)).length, 2, 'legacy JSONL remains valid');
});

test('execution prompt and log metadata emit escaped JSON without changing parsed values', async t => {
  const attackerValue = '</script><img src=x onerror=alert(1)><&>';
  const previewPath = '/tmp/jobs/execution-xss/.propr/preview-src/capture.ts';
  const redisClient = { get: async (key: string) => JSON.stringify(key.includes('prompt')
    ? { prompt: { nested: { attackerValue, symbols: '<&>', previewPath } } }
    : { files: { conversation: attackerValue }, nested: { attackerValue, symbols: '<&>', previewPath } }) } as unknown as RedisClientType;
  const routes = createExecutionRoutes({ redisClient, db: {} as Knex });
  const app = express();
  app.get('/api/execution/:sessionId/prompt', routes.getPrompt as RequestHandler);
  app.get('/api/execution/:sessionId/logs', routes.getLogs as RequestHandler);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  }));

  const port = (server.address() as AddressInfo).port;
  for (const endpoint of ['prompt', 'logs'] as const) {
    const response = await fetch(`http://127.0.0.1:${port}/api/execution/session-2288/${endpoint}`);
    const wireBody = await response.text();

    assert.match(response.headers.get('content-type') ?? '', /^application\/json\b/);
    assert.doesNotMatch(wireBody, /[<>&]/);
    assert.match(wireBody, /\\u003c\/script\\u003e\\u003cimg/);
    assert.match(wireBody, /\\u003c\\u0026\\u003e/);
    const body = JSON.parse(wireBody) as {
      prompt?: { nested: { attackerValue: string; symbols: string; previewPath: string } };
      nested?: { attackerValue: string; symbols: string; previewPath: string };
    };
    const nested = endpoint === 'prompt' ? body.prompt?.nested : body.nested;
    assert.equal(nested?.attackerValue, attackerValue);
    assert.equal(nested?.symbols, '<&>');
    assert.equal(nested?.previewPath, '[local preview omitted]');
  }
});
