import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';
import {
  MAX_SPLIT_INSTRUCTION_LENGTH,
  normalizeSplitInstruction,
  parseSplitCommand,
} from '../../packages/core/src/services/prSplit/command.js';
import {
  authorizeSplitRequester,
  isSplitPermissionAuthorized,
  type PrSplitRequestClient,
} from '../../packages/core/src/services/prSplit/authorization.js';

describe('/split command parsing', () => {
  test('accepts empty or natural-language guidance and normalizes whitespace', () => {
    assert.deepEqual(parseSplitCommand('/split'), { instruction: '' });
    assert.deepEqual(parseSplitCommand('/split extract auth changes'), {
      instruction: 'extract auth changes',
    });
    assert.equal(normalizeSplitInstruction('  extract\n\tauth   changes  '), 'extract auth changes');
    assert.deepEqual(parseSplitCommand('/split\n  extract\n\tauth   changes'), {
      instruction: 'extract auth changes',
    });
  });

  test('requires /split to be the exact first command token', () => {
    assert.equal(parseSplitCommand('please /split this PR'), null);
    assert.equal(parseSplitCommand(' /split this PR'), null);
    assert.equal(parseSplitCommand('/review\n/split this PR'), null);
    assert.equal(parseSplitCommand('/splitter this PR'), null);
    assert.equal(parseSplitCommand('/SPLIT this PR'), null);
  });

  test('recognizes but rejects instructions beyond the execution limit', () => {
    assert.deepEqual(parseSplitCommand(`/split ${'x'.repeat(MAX_SPLIT_INSTRUCTION_LENGTH + 1)}`), {
      instruction: '',
      validationError: 'instruction_too_long',
    });
  });
});

describe('/split repository authorization', () => {
  const authorizationRequest = {
    owner: 'integry',
    repo: 'propr',
    username: 'maintainer',
    requesterId: 7654321,
  };

  test('maps only write-like GitHub permissions to authorized', () => {
    for (const permission of ['write', 'maintain', 'admin']) {
      assert.equal(isSplitPermissionAuthorized(permission), true, permission);
    }
    for (const permission of ['read', 'triage', 'none', '', null, undefined]) {
      assert.equal(isSplitPermissionAuthorized(permission), false, String(permission));
    }
  });

  test('uses the collaborator permission endpoint and treats only 404 as definitive', async () => {
    const requestedRoutes: string[] = [];
    const octokit: PrSplitRequestClient = {
      request: mock.fn(async (route: string) => {
        requestedRoutes.push(route);
        return { data: { permission: 'maintain', user: { id: 7654321 } } };
      }),
    };
    assert.deepEqual(await authorizeSplitRequester(octokit, authorizationRequest), {
      authorized: true,
      permission: 'maintain',
    });
    assert.deepEqual(requestedRoutes, [
      'GET /repos/{owner}/{repo}/collaborators/{username}/permission',
    ]);

    const notFoundClient: PrSplitRequestClient = {
      request: mock.fn(async () => {
        throw Object.assign(new Error('Not Found'), { status: 404 });
      }),
    };
    assert.deepEqual(await authorizeSplitRequester(notFoundClient, authorizationRequest), {
      authorized: false,
      permission: null,
    });
  });

  test('rejects a renamed or recycled login whose numeric identity differs', async () => {
    const octokit: PrSplitRequestClient = {
      request: mock.fn(async () => ({
        data: { permission: 'admin', user: { id: 9999999 } },
      })),
    };

    assert.deepEqual(await authorizeSplitRequester(octokit, authorizationRequest), {
      authorized: false,
      permission: 'admin',
    });
  });

  test('rethrows credential, rate-limit, and ambiguous 403 responses', async () => {
    const retryableErrors = [
      Object.assign(new Error('Resource not accessible by integration'), {
        status: 403,
        response: {
          data: { message: 'Resource not accessible by integration' },
          headers: {},
        },
      }),
      Object.assign(new Error('API rate limit exceeded'), {
        status: 403,
        response: {
          data: { message: 'API rate limit exceeded' },
          headers: { 'x-ratelimit-remaining': '0' },
        },
      }),
      Object.assign(new Error('ambiguous GitHub 403'), { status: 403 }),
      Object.assign(new Error('Too Many Requests'), { status: 429 }),
      Object.assign(new Error('Service Unavailable'), { status: 503 }),
    ];

    for (const error of retryableErrors) {
      const client: PrSplitRequestClient = {
        request: mock.fn(async () => { throw error; }),
      };
      await assert.rejects(
        authorizeSplitRequester(client, authorizationRequest),
        (caught) => caught === error,
      );
    }
  });
});
