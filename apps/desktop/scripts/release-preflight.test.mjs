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

const immutableRuleset = (overrides = {}) => ({
  id: 9,
  name: 'immutable desktop release tags',
  target: 'tag',
  enforcement: 'active',
  bypass_actors: [],
  conditions: { ref_name: { include: ['refs/tags/desktop-v*'], exclude: [] } },
  rules: [{ type: 'update' }, { type: 'deletion' }],
  ...overrides,
});

const protectedEnvironment = name => ({
  name,
  protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'Team' }] }, { type: 'branch_policy' }],
  deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
});

const responses = ({ protectedMain = true, environment = true, release = false, tagSha = sha } = {}) => ({
  '': { default_branch: 'main' },
  '/branches/main': { protected: protectedMain },
  '/rulesets': [{ id: 9 }],
  '/rulesets/9': immutableRuleset(),
  '/git/ref/tags/desktop-v1.2.3': { object: { sha } },
  '/commits/desktop-v1.2.3': { sha: tagSha },
  '/releases/tags/desktop-v1.2.3': release ? { id: 7 } : undefined,
  '/environments/desktop-release-preflight': environment ? protectedEnvironment('desktop-release-preflight') : undefined,
  '/environments/desktop-release-preflight/deployment-branch-policies': environment ? {
    total_count: 1,
    branch_policies: [{ name: 'desktop-v*', type: 'tag' }],
  } : undefined,
  '/environments/desktop-release': environment ? protectedEnvironment('desktop-release') : undefined,
  '/environments/desktop-release/deployment-branch-policies': environment ? {
    total_count: 1,
    branch_policies: [{ name: 'desktop-v*', type: 'tag' }],
  } : undefined,
});

const harness = (values, {
  secondTagSha,
  secondRefSha,
  secondRuleset,
  failures = {},
} = {}) => {
  const calls = new Map();
  const requested = [];
  return {
    requested,
    fetchImpl: async (url, request) => {
      const parsed = new URL(url);
      const path = parsed.pathname.replace('/repos/integry/propr', '');
      const count = (calls.get(path) ?? 0) + 1;
      calls.set(path, count);
      requested.push(`${path}${parsed.search}`);
      assert.equal(request.headers.Authorization, 'Bearer token');
      if (failures[path]) return { status: failures[path], ok: false, json: async () => undefined };
      let value = values[path];
      if (typeof value === 'function') value = value({ count, page: Number(parsed.searchParams.get('page') ?? 1), url: parsed });
      if (path === '/commits/desktop-v1.2.3' && count === 2 && secondTagSha) value = { sha: secondTagSha };
      if (path === '/git/ref/tags/desktop-v1.2.3' && count === 2 && secondRefSha) value = { object: { sha: secondRefSha } };
      if (path === '/rulesets/9' && count === 2 && secondRuleset !== undefined) value = secondRuleset;
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

  test('accepts an authorization-visible bypass list and fails closed for hidden or denied ruleset details', async () => {
    const authorized = responses();
    authorized['/rulesets/9'] = immutableRuleset({ bypass_actors: [] });
    await verify(authorized);

    const hidden = responses();
    hidden['/rulesets/9'] = immutableRuleset({ bypass_actors: undefined });
    await assert.rejects(verify(hidden), /active, bypass-free/);

    await assert.rejects(
      verify(responses(), { failures: { '/rulesets/9': 403 } }),
      /rulesets\/9.*403/,
    );
  });

  test('paginates repository rulesets and reads every full rule definition', async () => {
    const values = responses();
    const summaries = Array.from({ length: 101 }, (_, index) => ({ id: index + 1 }));
    values['/rulesets'] = ({ page }) => page === 1 ? summaries.slice(0, 100) : summaries.slice(100);
    for (let id = 1; id <= 101; id += 1) {
      values[`/rulesets/${id}`] = id === 101
        ? immutableRuleset({ id })
        : immutableRuleset({ id, enforcement: 'disabled' });
    }
    const configured = harness(values);
    await verifyDesktopReleasePreflight({
      repository: 'integry/propr', tag: 'desktop-v1.2.3', releaseSha: sha, token: 'token', event, ...configured,
    });
    assert(configured.requested.includes('/rulesets?includes_parents=true&targets=tag&per_page=100&page=2'));
    assert(configured.requested.includes('/rulesets/101?includes_parents=true'));
  });

  test('requires an exact active bypass-free update and deletion tag ruleset', async () => {
    const invalidRulesets = [
      immutableRuleset({ enforcement: 'disabled' }),
      immutableRuleset({ enforcement: 'evaluate' }),
      immutableRuleset({ target: 'branch' }),
      immutableRuleset({ bypass_actors: [{ actor_type: 'Integration', actor_id: 15368, bypass_mode: 'always' }] }),
      immutableRuleset({ bypass_actors: undefined }),
      immutableRuleset({ conditions: { ref_name: { include: ['refs/tags/desktop-v**'], exclude: [] } } }),
      immutableRuleset({ conditions: { ref_name: { include: ['refs/tags/desktop-v*', '~ALL'], exclude: [] } } }),
      immutableRuleset({ conditions: { ref_name: { include: ['refs/tags/desktop-v*'], exclude: ['refs/tags/desktop-v1.*'] } } }),
      immutableRuleset({ rules: [{ type: 'update' }] }),
      immutableRuleset({ rules: [{ type: 'deletion' }] }),
    ];
    for (const ruleset of invalidRulesets) {
      const values = responses();
      values['/rulesets/9'] = ruleset;
      await assert.rejects(verify(values), /active, bypass-free.*blocking update and deletion/);
    }
  });

  test('rejects ruleset mutation or deletion during preflight', async () => {
    await assert.rejects(
      verify(responses(), { secondRuleset: immutableRuleset({ rules: [{ type: 'update' }] }) }),
      /ruleset changed during preflight/,
    );
    await assert.rejects(
      verify(responses(), { failures: { '/rulesets/9': 404 } }),
      /rulesets\/9.*404/,
    );
    const values = responses();
    values['/rulesets/9'] = ({ count }) => count === 1 ? immutableRuleset() : undefined;
    await assert.rejects(verify(values), /rulesets\/9.*404/);
  });

  test('requires the complete effective environment policy set to be exactly desktop-v* tags', async () => {
    const invalidPolicies = [
      [],
      [{ name: '*', type: 'tag' }],
      [{ name: 'desktop-v**', type: 'tag' }],
      [{ name: 'desktop-v*', type: 'branch' }],
      [{ name: 'desktop-v*', type: 'tag' }, { name: '*', type: 'tag' }],
      [{ name: 'desktop-v*', type: 'tag' }, { name: 'main', type: 'branch' }],
    ];
    for (const policies of invalidPolicies) {
      const values = responses();
      values['/environments/desktop-release/deployment-branch-policies'] = {
        total_count: policies.length,
        branch_policies: policies,
      };
      await assert.rejects(verify(values), /exactly the tag policy desktop-v\*/);
    }
    const fallback = responses();
    fallback['/environments/desktop-release'].deployment_branch_policy = {
      protected_branches: true,
      custom_branch_policies: false,
    };
    await assert.rejects(verify(fallback), /custom deployment tag restrictions/);
  });

  test('requires the separately protected preflight credential environment', async () => {
    const missing = responses();
    missing['/environments/desktop-release-preflight'] = undefined;
    await assert.rejects(verify(missing), /environments\/desktop-release-preflight.*404/);
    const permissive = responses();
    permissive['/environments/desktop-release-preflight/deployment-branch-policies'] = {
      total_count: 1,
      branch_policies: [{ name: '*', type: 'tag' }],
    };
    await assert.rejects(verify(permissive), /desktop-release-preflight must have exactly the tag policy desktop-v\*/);
  });

  test('paginates all environment policies and rejects a permissive policy on a later page', async () => {
    const values = responses();
    const firstPage = Array.from({ length: 100 }, (_, index) => ({ name: `desktop-v${index}.*`, type: 'tag' }));
    values['/environments/desktop-release/deployment-branch-policies'] = ({ page }) => ({
      total_count: 101,
      branch_policies: page === 1 ? firstPage : [{ name: '*', type: 'tag' }],
    });
    const configured = harness(values);
    await assert.rejects(
      verifyDesktopReleasePreflight({
        repository: 'integry/propr', tag: 'desktop-v1.2.3', releaseSha: sha, token: 'token', event, ...configured,
      }),
      /exactly the tag policy desktop-v\*/,
    );
    assert(configured.requested.includes('/environments/desktop-release/deployment-branch-policies?per_page=100&page=2'));
  });

  test('rejects missing or ambiguous environment protection and explicit API denial', async () => {
    await assert.rejects(verify(responses({ protectedMain: false })), /main branch is not protected/);
    await assert.rejects(verify(responses({ environment: false })), /environments\/desktop-release.*404/);
    await assert.rejects(verify(responses(), { failures: { '/environments/desktop-release': 403 } }), /environments\/desktop-release.*403/);
    const missingReviewers = responses();
    missingReviewers['/environments/desktop-release'].protection_rules = [{ type: 'branch_policy' }];
    await assert.rejects(verify(missingReviewers), /require reviewers/);
    const ambiguous = responses();
    ambiguous['/environments/desktop-release/deployment-branch-policies'] = { branch_policies: [] };
    await assert.rejects(verify(ambiguous), /ambiguous paginated response/);
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
