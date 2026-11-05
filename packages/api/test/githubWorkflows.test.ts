import assert from 'node:assert/strict';
import { test } from 'node:test';
import { closeConnection } from '@propr/core';
import { createGitHubRoutes } from '../routes/githubRoutes.js';
import { workflowTriggers } from '../routes/githubWorkflows.js';

test.after(async () => { await closeConnection(); });

function responseRecorder() {
  const record: { status: number; body: unknown } = { status: 200, body: undefined };
  const response = {
    status(code: number) { record.status = code; return response; },
    json(body: unknown) { record.body = body; return response; },
  };
  return { record, response: response as never };
}

const files: Record<string, string> = {
  '.github/workflows/pr-build-check.yml': 'name: Build & Lint Check\non:\n  pull_request:\n    branches: [main]\njobs: {}\n',
  '.github/workflows/pr-preview.yml': 'name: PR Preview\non: pull_request_target\njobs: {}\n',
  '.github/workflows/docker-images.yml': 'name: Docker Images\non: [push, workflow_dispatch]\njobs: {}\n',
  '.github/workflows/broken.yml': 'name: [unclosed\n',
};

function routesFor(workflows: Array<{ id: number; name: string; path: string; state: string }>, seen: string[] = []) {
  return createGitHubRoutes({
    redisClient: {} as never,
    taskQueue: {} as never,
    db: {} as never,
    resolveMetadataToken: async () => 'ghu_user-secret',
    createMetadataOctokit: token => {
      seen.push(token);
      return {
        request: async (_route: string, params: { path: string }) => {
          if (!(params.path in files)) throw Object.assign(new Error('Not Found'), { status: 404 });
          return { data: files[params.path] };
        },
        paginate: { iterator: async function* () { yield { data: workflows }; } },
      } as never;
    },
  });
}

test('workflow triggers are read from every form of the on: key', () => {
  assert.deepEqual(workflowTriggers('on: push'), ['push']);
  assert.deepEqual(workflowTriggers('on: [push, pull_request]'), ['push', 'pull_request']);
  assert.deepEqual(workflowTriggers('on:\n  pull_request:\n  workflow_dispatch:\n'), ['pull_request', 'workflow_dispatch']);
  assert.equal(workflowTriggers('name: [unclosed'), null);
  assert.equal(workflowTriggers('jobs: {}'), null);
});

test('lists active workflow files with their triggers, pull request workflows first', async () => {
  const seen: string[] = [];
  const recorder = responseRecorder();
  await routesFor([
    { id: 3, name: 'Docker Images', path: '.github/workflows/docker-images.yml', state: 'active' },
    { id: 1, name: 'PR Preview', path: '.github/workflows/pr-preview.yml', state: 'active' },
    { id: 2, name: 'Build & Lint Check', path: '.github/workflows/pr-build-check.yml', state: 'active' },
    { id: 4, name: 'Broken', path: '.github/workflows/broken.yml', state: 'active' },
    { id: 5, name: 'Old', path: '.github/workflows/old.yml', state: 'disabled_manually' },
    { id: 6, name: 'Dependabot Updates', path: 'dynamic/dependabot/dependabot-updates', state: 'active' },
  ], seen).getWorkflows({ params: { owner: 'integry', repo: 'propr' } } as never, recorder.response);

  assert.equal(recorder.record.status, 200);
  const { workflows } = recorder.record.body as { workflows: Array<Record<string, unknown>> };
  assert.deepEqual(workflows.map(workflow => [workflow.file, workflow.pullRequest]), [
    ['pr-build-check.yml', true], ['pr-preview.yml', true], ['broken.yml', null], ['docker-images.yml', false],
  ]);
  assert.deepEqual(workflows[0], {
    id: 2, name: 'Build & Lint Check', path: '.github/workflows/pr-build-check.yml', file: 'pr-build-check.yml',
    triggers: ['pull_request'], pullRequest: true,
  });
  assert.ok(seen.every(token => token === 'ghu_user-secret'), 'workflows are read with the requester credential');
});

test('an inaccessible repository is denied instead of listing nothing', async () => {
  const routes = createGitHubRoutes({
    redisClient: {} as never,
    taskQueue: {} as never,
    db: {} as never,
    resolveMetadataToken: async () => 'ghu_user-secret',
    createMetadataOctokit: () => ({
      request: async () => ({ data: '' }),
      paginate: { iterator: async function* () { yield await Promise.reject(Object.assign(new Error('Not Found'), { status: 404 })); } },
    } as never),
  });
  const recorder = responseRecorder();
  await routes.getWorkflows({ params: { owner: 'private-owner', repo: 'private-repo' } } as never, recorder.response);
  assert.equal(recorder.record.status, 404);
});
