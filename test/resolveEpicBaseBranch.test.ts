import { test, describe } from 'node:test';
import assert from 'node:assert';
import { resolveEpicBaseBranch } from '../packages/core/src/services/epicPRService.ts';

const noopLogger = { warn() {} };

function octokitReturning(data: unknown, calls: unknown[] = []) {
  return {
    request: async (route: string, params: Record<string, unknown>) => {
      calls.push({ route, params });
      return { data };
    }
  } as never;
}

function octokitThrowing() {
  return {
    request: async () => { throw new Error('boom'); }
  } as never;
}

describe('resolveEpicBaseBranch', () => {
  test('returns the explicit base branch without calling the API', async () => {
    const calls: unknown[] = [];
    const octo = octokitReturning({ default_branch: 'master' }, calls);
    const result = await resolveEpicBaseBranch(octo, 'o', 'r', 'develop', noopLogger);
    assert.strictEqual(result, 'develop');
    assert.strictEqual(calls.length, 0, 'must not query the repo when a base is given');
  });

  test('uses the repository default branch when no explicit base is given (not a hardcoded main)', async () => {
    const octo = octokitReturning({ default_branch: 'master' });
    const result = await resolveEpicBaseBranch(octo, 'integry', 'mcptest', undefined, noopLogger);
    assert.strictEqual(result, 'master');
  });

  test('falls back to main when the repo has no default_branch field', async () => {
    const octo = octokitReturning({});
    const result = await resolveEpicBaseBranch(octo, 'o', 'r', undefined, noopLogger);
    assert.strictEqual(result, 'main');
  });

  test('falls back to main when the repo lookup fails', async () => {
    const octo = octokitThrowing();
    const result = await resolveEpicBaseBranch(octo, 'o', 'r', undefined, noopLogger);
    assert.strictEqual(result, 'main');
  });
});
