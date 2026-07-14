import { test, describe } from 'node:test';
import assert from 'node:assert';
import { ensureEpicBaseBranchExists } from '../src/jobs/issueJobHelpers.js';

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} } as never;

interface Call { endpoint: string; options: Record<string, unknown>; }

function makeOctokit(handler: (endpoint: string, options: Record<string, unknown>) => unknown) {
  const calls: Call[] = [];
  return {
    calls,
    request: async (endpoint: string, options: Record<string, unknown>) => {
      calls.push({ endpoint, options });
      const result = handler(endpoint, options);
      if (result instanceof Error) throw result;
      return result;
    }
  };
}

function httpError(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}

const EPIC_BRANCH = '187-epic-modernize-and-n7j';

describe('ensureEpicBaseBranchExists', () => {
  test('does nothing for a non-epic base branch', async () => {
    const octo = makeOctokit(() => { throw new Error('should not call the API'); });
    await ensureEpicBaseBranchExists(octo, 'o', 'r', 'develop', 'master', noopLogger);
    assert.strictEqual(octo.calls.length, 0);
  });

  test('does not recreate the branch when it already exists', async () => {
    const octo = makeOctokit((endpoint) => {
      if (endpoint === 'GET /repos/{owner}/{repo}/git/ref/{ref}') return { data: { object: { sha: 'abc' } } };
      throw new Error(`unexpected ${endpoint}`);
    });
    await ensureEpicBaseBranchExists(octo, 'o', 'r', EPIC_BRANCH, 'master', noopLogger);
    assert.ok(octo.calls.every(c => !c.endpoint.startsWith('POST')), 'must not create a ref');
    assert.strictEqual(octo.calls.length, 1);
  });

  test('recreates a missing epic base branch from the default branch head', async () => {
    const octo = makeOctokit((endpoint, options) => {
      if (endpoint === 'GET /repos/{owner}/{repo}/git/ref/{ref}') {
        if (options.ref === `heads/${EPIC_BRANCH}`) return httpError('Not Found', 404);
        if (options.ref === 'heads/master') return { data: { object: { sha: 'deadbeef' } } };
      }
      if (endpoint === 'POST /repos/{owner}/{repo}/git/refs') return { data: {} };
      throw new Error(`unexpected ${endpoint} ${JSON.stringify(options)}`);
    });
    await ensureEpicBaseBranchExists(octo, 'o', 'r', EPIC_BRANCH, 'master', noopLogger);
    const create = octo.calls.find(c => c.endpoint === 'POST /repos/{owner}/{repo}/git/refs');
    assert.ok(create, 'should create the missing epic base branch');
    assert.strictEqual(create!.options.ref, `refs/heads/${EPIC_BRANCH}`);
    assert.strictEqual(create!.options.sha, 'deadbeef');
  });

  test('tolerates a concurrent job creating the branch first (422 already exists)', async () => {
    const octo = makeOctokit((endpoint, options) => {
      if (endpoint === 'GET /repos/{owner}/{repo}/git/ref/{ref}') {
        if (options.ref === `heads/${EPIC_BRANCH}`) return httpError('Not Found', 404);
        return { data: { object: { sha: 'x' } } };
      }
      if (endpoint === 'POST /repos/{owner}/{repo}/git/refs') return httpError('Reference already exists', 422);
      throw new Error(`unexpected ${endpoint}`);
    });
    await assert.doesNotReject(() => ensureEpicBaseBranchExists(octo, 'o', 'r', EPIC_BRANCH, 'master', noopLogger));
  });

  test('propagates unexpected errors from the existence check', async () => {
    const octo = makeOctokit(() => httpError('Server Error', 500));
    await assert.rejects(() => ensureEpicBaseBranchExists(octo, 'o', 'r', EPIC_BRANCH, 'master', noopLogger), /Server Error/);
  });
});
