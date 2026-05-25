import { getAuthenticatedOctokit } from '../auth/githubAuth.js';

const MERGED_PR_KEY_PREFIX = 'pr-merged';
const MERGED_PR_KEY_TTL_SECONDS = 30 * 24 * 60 * 60;

export type PullRequestMergeStateRedisLike = {
  del?: (key: string) => Promise<unknown>;
  get: (key: string) => Promise<string | null>;
  set?: (key: string, value: string, options?: { EX?: number }) => Promise<unknown>;
  setex?: (key: string, seconds: number, value: string) => Promise<unknown>;
};

interface PullRequestMergeStateDeps {
  getAuthenticatedOctokit?: typeof getAuthenticatedOctokit;
}

export async function markPullRequestMerged(
  redisClient: PullRequestMergeStateRedisLike,
  repository: string,
  prNumber: number,
): Promise<void> {
  const key = getPullRequestMergedKey(repository, prNumber);
  const value = new Date().toISOString();

  if (typeof redisClient.setex === 'function') {
    await redisClient.setex(key, MERGED_PR_KEY_TTL_SECONDS, value);
  } else if (typeof redisClient.set === 'function') {
    await redisClient.set(key, value, { EX: MERGED_PR_KEY_TTL_SECONDS });
  } else {
    throw new Error('Redis client does not support merged PR state writes');
  }
}

export async function hasPullRequestMerged(
  redisClient: PullRequestMergeStateRedisLike,
  repository: string,
  prNumber: number,
  deps: PullRequestMergeStateDeps = {},
): Promise<boolean> {
  const mergedKey = getPullRequestMergedKey(repository, prNumber);

  if ((await redisClient.get(mergedKey)) !== null) {
    return true;
  }

  const [owner, repoName] = repository.split('/');
  if (!owner || !repoName) {
    throw new Error(`Invalid repository name for merge-state lookup: ${repository}`);
  }

  const octokit = await (deps.getAuthenticatedOctokit ?? getAuthenticatedOctokit)();
  const response = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
    owner,
    repo: repoName,
    pull_number: prNumber,
  });
  const merged = response.data.merged === true || response.data.merged_at !== null;

  if (merged) {
    await markPullRequestMerged(redisClient, repository, prNumber);
  }

  return merged;
}

function getPullRequestMergedKey(repository: string, prNumber: number): string {
  return `${MERGED_PR_KEY_PREFIX}:${repository}:${prNumber}`;
}
