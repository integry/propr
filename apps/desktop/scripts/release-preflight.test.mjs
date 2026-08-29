import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { verifyDesktopReleasePreflight } from './release-preflight.mjs';

const sha = '1'.repeat(40);
const event = {
  ref: 'refs/tags/desktop-v1.2.3',
  created: true,
  deleted: false,
  forced: false,
  before: '0'.repeat(40),
  after: sha,
};

const responses = ({ protectedMain = true, environment = true, release = false, tagSha = sha } = {}) => ({
  '': { default_branch: 'main' },
  '/branches/main': { protected: protectedMain },
  '/git/ref/tags/desktop-v1.2.3': { object: { sha } },
  '/commits/desktop-v1.2.3': { sha: tagSha },
  '/releases/tags/desktop-v1.2.3': release ? { id: 7 } : undefined,
  '/environments/desktop-release': environment ? {
    name: 'desktop-release',
    protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'Team' }] }, { type: 'branch_policy' }],
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
  } : undefined,
  '/environments/desktop-release/deployment-branch-policies': environment ? {
    branch_policies: [{ name: 'desktop-v*', type: 'tag' }],
  } : undefined,
});

const harness = (values, { secondTagSha, secondRefSha } = {}) => {
  const calls = new Map();
  return {
    fetchImpl: async url => {
      const path = new URL(url).pathname.replace('/repos/integry/propr', '');
      const count = (calls.get(path) ?? 0) + 1;
      calls.set(path, count);
      let value = values[path];
      if (path === '/commits/desktop-v1.2.3' && count === 2 && secondTagSha) value = { sha: secondTagSha };
      if (path === '/git/ref/tags/desktop-v1.2.3' && count === 2 && secondRefSha) value = { object: { sha: secondRefSha } };
      return { status: value === undefined ? 404 : 200, ok: value !== undefined, json: async () => value };
    },
    git: async args => args[0] === 'rev-parse' ? sha : '',
  };
};

const verify = (values = responses(), options = {}) => verifyDesktopReleasePreflight({
  repository: 'integry/propr',
  tag: 'desktop-v1.2.3',
  releaseSha: sha,
  token: 'token',
  event,
  ...harness(values, options),
});

describe('desktop release preflight', () => {
  test('accepts only a new immutable tag reachable from protected main and a protected environment', async () => {
    assert.deepEqual(await verify(), { version: '1.2.3', releaseSha: sha, tag: 'desktop-v1.2.3', tagObjectSha: sha });
  });

  test('rejects missing environment protection and unprotected main', async () => {
    await assert.rejects(verify(responses({ protectedMain: false })), /main branch is not protected/);
    await assert.rejects(verify(responses({ environment: false })), /environments\/desktop-release.*404/);
    const missingReviewers = responses();
    missingReviewers['/environments/desktop-release'].protection_rules = [{ type: 'branch_policy' }];
    await assert.rejects(verify(missingReviewers), /require reviewers/);
    const unrestrictedTags = responses();
    unrestrictedTags['/environments/desktop-release/deployment-branch-policies'].branch_policies = [];
    await assert.rejects(verify(unrestrictedTags), /restrict tags/);
  });

  test('rejects tags not created by this push, tags off main, and moved or existing releases', async () => {
    await assert.rejects(
      verifyDesktopReleasePreflight({
        repository: 'integry/propr', tag: 'desktop-v1.2.3', releaseSha: sha, token: 'token',
        event: { ...event, created: false, before: '2'.repeat(40) }, ...harness(responses()),
      }),
      /new, non-forced desktop tag push/,
    );
    await assert.rejects(verify(responses({ tagSha: '2'.repeat(40) })), /tag moved/);
    await assert.rejects(verify(responses({ release: true })), /already exists/);
    await assert.rejects(verify(responses(), { secondTagSha: '2'.repeat(40) }), /moved during preflight/);
    await assert.rejects(verify(responses(), { secondRefSha: '2'.repeat(40) }), /tag ref moved during preflight/);
    const failingGit = harness(responses());
    failingGit.git = async args => {
      if (args[0] === 'merge-base') throw new Error('not an ancestor');
      return args[0] === 'rev-parse' ? sha : '';
    };
    await assert.rejects(
      verifyDesktopReleasePreflight({ repository: 'integry/propr', tag: 'desktop-v1.2.3', releaseSha: sha, token: 'token', event, ...failingGit }),
      /not an ancestor/,
    );
  });
});
