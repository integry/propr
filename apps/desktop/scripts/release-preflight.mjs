import { execFile as execFileCallback } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const execFile = promisify(execFileCallback);
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const ZERO_SHA = '0'.repeat(40);
const RELEASE_ENVIRONMENT = 'desktop-release';
const PREFLIGHT_ENVIRONMENT = 'desktop-release-preflight';
const RELEASE_TAG_POLICY = 'desktop-v*';
const RELEASE_TAG_RULESET_INCLUDE = `refs/tags/${RELEASE_TAG_POLICY}`;
const API_PAGE_SIZE = 100;

const defaultGit = async args => (await execFile('git', args)).stdout.trim();

const apiRequest = async ({ fetchImpl, apiUrl, repository, token, path, allowNotFound = false }) => {
  const response = await fetchImpl(`${apiUrl}/repos/${repository}${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (allowNotFound && response.status === 404) return undefined;
  if (!response.ok) throw new Error(`GitHub API ${path} failed with HTTP ${response.status}`);
  return response.json();
};

const paginatedArray = async (request, path) => {
  const values = [];
  for (let page = 1; ; page += 1) {
    const separator = path.includes('?') ? '&' : '?';
    const result = await request(`${path}${separator}per_page=${API_PAGE_SIZE}&page=${page}`);
    if (!Array.isArray(result)) throw new Error(`GitHub API ${path} returned an ambiguous paginated response`);
    values.push(...result);
    if (result.length < API_PAGE_SIZE) return values;
  }
};

const paginatedDeploymentPolicies = async (request, environmentName) => {
  const path = `/environments/${environmentName}/deployment-branch-policies`;
  const policies = [];
  let totalCount;
  for (let page = 1; ; page += 1) {
    const result = await request(`${path}?per_page=${API_PAGE_SIZE}&page=${page}`);
    if (!Number.isSafeInteger(result?.total_count) || result.total_count < 0 || !Array.isArray(result.branch_policies)) {
      throw new Error(`GitHub API ${path} returned an ambiguous paginated response`);
    }
    if (totalCount === undefined) totalCount = result.total_count;
    if (result.total_count !== totalCount || policies.length + result.branch_policies.length > totalCount) {
      throw new Error(`GitHub API ${path} changed or returned inconsistent pagination`);
    }
    policies.push(...result.branch_policies);
    if (policies.length === totalCount) return policies;
    if (result.branch_policies.length !== API_PAGE_SIZE) {
      throw new Error(`GitHub API ${path} omitted deployment policies during pagination`);
    }
  }
};

const assertNewTagPush = ({ event, tag }) => {
  if (event.ref !== `refs/tags/${tag}` || event.created !== true || event.deleted === true || event.forced === true
    || event.before !== ZERO_SHA || !SHA_PATTERN.test(event.after)) {
    throw new Error('Production release must be a new, non-forced desktop tag push at the exact event SHA');
  }
};

const assertEnvironmentProtection = (environment, policies, environmentName) => {
  if (environment?.name !== environmentName) {
    throw new Error(`GitHub environment ${environmentName} does not exist`);
  }
  const reviewerRule = environment.protection_rules?.find(rule => rule.type === 'required_reviewers');
  if (!reviewerRule || !Array.isArray(reviewerRule.reviewers) || reviewerRule.reviewers.length === 0) {
    throw new Error(`GitHub environment ${environmentName} must require reviewers`);
  }
  if (environment.deployment_branch_policy?.custom_branch_policies !== true
    || environment.deployment_branch_policy?.protected_branches !== false) {
    throw new Error(`GitHub environment ${environmentName} must use custom deployment tag restrictions`);
  }
  if (!Array.isArray(policies) || policies.length !== 1
    || policies[0]?.type !== 'tag' || policies[0]?.name !== RELEASE_TAG_POLICY) {
    throw new Error(`GitHub environment ${environmentName} must have exactly the tag policy ${RELEASE_TAG_POLICY}`);
  }
};

const rulesetSecurityState = ruleset => JSON.stringify({
  id: ruleset.id,
  target: ruleset.target,
  enforcement: ruleset.enforcement,
  bypassActors: ruleset.bypass_actors,
  refName: ruleset.conditions?.ref_name,
  ruleTypes: Array.isArray(ruleset.rules) ? ruleset.rules.map(rule => rule?.type).sort() : ruleset.rules,
});

const isExactImmutableTagRuleset = ruleset => {
  const refName = ruleset?.conditions?.ref_name;
  const ruleTypes = Array.isArray(ruleset?.rules) ? ruleset.rules.map(rule => rule?.type) : [];
  return Number.isSafeInteger(ruleset?.id)
    && ruleset.target === 'tag'
    && ruleset.enforcement === 'active'
    && Array.isArray(ruleset.bypass_actors)
    && ruleset.bypass_actors.length === 0
    && Array.isArray(refName?.include)
    && refName.include.length === 1
    && refName.include[0] === RELEASE_TAG_RULESET_INCLUDE
    && Array.isArray(refName.exclude)
    && refName.exclude.length === 0
    && ruleTypes.includes('update')
    && ruleTypes.includes('deletion');
};

const readImmutableTagRuleset = async request => {
  const summaries = await paginatedArray(request, '/rulesets?includes_parents=true&targets=tag');
  const ids = summaries.map(summary => summary?.id);
  if (ids.some(id => !Number.isSafeInteger(id)) || new Set(ids).size !== ids.length) {
    throw new Error('GitHub repository rulesets response is ambiguous');
  }
  const rulesets = [];
  for (const id of ids) {
    rulesets.push(await request(`/rulesets/${id}?includes_parents=true`));
  }
  const matching = rulesets.filter(isExactImmutableTagRuleset);
  if (matching.length === 0) {
    throw new Error(`Repository must have an active, bypass-free ${RELEASE_TAG_RULESET_INCLUDE} tag ruleset blocking update and deletion`);
  }
  return matching[0];
};

export const verifyDesktopReleasePreflight = async ({
  repository,
  tag,
  releaseSha,
  token,
  event,
  apiUrl = 'https://api.github.com',
  fetchImpl = fetch,
  git = defaultGit,
}) => {
  const version = tag.startsWith('desktop-v') ? tag.slice('desktop-v'.length) : '';
  if (!VERSION_PATTERN.test(version) || !SHA_PATTERN.test(releaseSha) || !repository.includes('/') || !token) {
    throw new Error('Desktop release preflight inputs are invalid');
  }
  assertNewTagPush({ event, tag });

  const request = (path, options) => apiRequest({ fetchImpl, apiUrl, repository, token, path, ...options });
  const repositoryDetails = await request('');
  if (repositoryDetails.default_branch !== 'main') throw new Error('The protected release branch must be main');
  const mainBranch = await request('/branches/main');
  if (mainBranch.protected !== true) throw new Error('Repository main branch is not protected');

  const immutableTagRuleset = await readImmutableTagRuleset(request);
  const immutableTagRulesetState = rulesetSecurityState(immutableTagRuleset);

  const encodedTag = encodeURIComponent(tag);
  const currentRef = await request(`/git/ref/tags/${encodedTag}`);
  if (currentRef.object?.sha !== event.after) throw new Error('Desktop release tag ref moved from the new-tag push');
  const currentCommit = await request(`/commits/${encodedTag}`);
  if (currentCommit.sha !== releaseSha) throw new Error('Desktop release tag moved or does not resolve to the event SHA');
  const existingRelease = await request(`/releases/tags/${encodedTag}`, { allowNotFound: true });
  if (existingRelease) throw new Error(`GitHub release ${tag} already exists`);

  for (const environmentName of [PREFLIGHT_ENVIRONMENT, RELEASE_ENVIRONMENT]) {
    const environment = await request(`/environments/${environmentName}`);
    const policies = await paginatedDeploymentPolicies(request, environmentName);
    assertEnvironmentProtection(environment, policies, environmentName);
  }

  await git(['fetch', '--no-tags', 'origin', 'refs/heads/main:refs/remotes/origin/main']);
  await git(['fetch', '--no-tags', 'origin', `refs/tags/${tag}:refs/tags/${tag}`]);
  const localTagSha = await git(['rev-parse', `${tag}^{commit}`]);
  if (localTagSha !== releaseSha) throw new Error('Fetched desktop release tag does not match the event SHA');
  await git(['merge-base', '--is-ancestor', releaseSha, 'refs/remotes/origin/main']);

  const stableCommit = await request(`/commits/${encodedTag}`);
  if (stableCommit.sha !== releaseSha) throw new Error('Desktop release tag moved during preflight');
  const stableRef = await request(`/git/ref/tags/${encodedTag}`);
  if (stableRef.object?.sha !== event.after) throw new Error('Desktop release tag ref moved during preflight');
  const racedRelease = await request(`/releases/tags/${encodedTag}`, { allowNotFound: true });
  if (racedRelease) throw new Error(`GitHub release ${tag} appeared during preflight`);
  const stableRuleset = await request(`/rulesets/${immutableTagRuleset.id}?includes_parents=true`);
  if (!isExactImmutableTagRuleset(stableRuleset)
    || rulesetSecurityState(stableRuleset) !== immutableTagRulesetState) {
    throw new Error('Desktop tag immutability ruleset changed during preflight');
  }
  return { version, releaseSha, tag, tagObjectSha: event.after };
};

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const result = await verifyDesktopReleasePreflight({
    repository: process.env.GITHUB_REPOSITORY,
    tag: process.env.GITHUB_REF_NAME,
    releaseSha: process.env.GITHUB_SHA,
    token: process.env.GITHUB_TOKEN,
    event,
    apiUrl: process.env.GITHUB_API_URL,
  });
  if (process.env.GITHUB_OUTPUT) {
    const { appendFile } = await import('node:fs/promises');
    await appendFile(process.env.GITHUB_OUTPUT, `version=${result.version}\nrelease_sha=${result.releaseSha}\ntag=${result.tag}\ntag_object_sha=${result.tagObjectSha}\n`);
  }
}
