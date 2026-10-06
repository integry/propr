/**
 * Managed clone preparation for repository retrieval: cloning/refreshing the
 * shared clone and fetching a single requested ref into it.
 *
 * Managed clones may be shallow and single-branch (GIT_SHALLOW_CLONE_DEPTH), so
 * the regular `git fetch origin --prune` refresh only updates the branches in
 * the clone's configured refspec. A branch, tag or commit outside that scope
 * has to be fetched explicitly before it can be resolved.
 */

import { getGitHubInstallationToken } from '../auth/githubAuth.js';
import { createHooklessGit } from '../git/hooklessGit.js';
import { ensureRepoCloned } from '../git/repoManager.js';
import { configureGitAuthentication } from '../git/repoBranching.js';
import { redactAuthenticatedGitUrl } from '../git/redactGitUrl.js';
import { withGitLockRetry } from '../git/configLock.js';
import logger from '../utils/logger.js';
import { RepositoryRetrievalError, type RepositoryTargetOptions } from './repositoryRetrievalTypes.js';
import { isFullCommitSha, remoteRefMappings } from './repositoryRetrievalValidation.js';

const GIT_SHALLOW_CLONE_DEPTH = process.env.GIT_SHALLOW_CLONE_DEPTH ? parseInt(process.env.GIT_SHALLOW_CLONE_DEPTH) : undefined;

async function resolveCloneToken(authToken?: string): Promise<string> {
  try {
    return await getGitHubInstallationToken();
  } catch (error) {
    if (authToken) return authToken;
    throw new RepositoryRetrievalError(`No GitHub credentials available to clone repository: ${(error as Error).message}`, 503);
  }
}

/**
 * Clones the repository or refreshes the existing shared clone. When `ref` is
 * given it takes precedence over `branch`, which then only names the semantic
 * index; the clone uses the default branch so that a missing `branch` cannot
 * fail cloning, and the caller fetches `ref` explicitly if it is still absent.
 */
export async function cloneOrRefresh(owner: string, repoName: string, options: RepositoryTargetOptions): Promise<{ repoPath: string; authToken: string }> {
  const authToken = await resolveCloneToken(options.authToken);
  const repoPath = await ensureRepoCloned({
    repoUrl: `https://github.com/${owner}/${repoName}.git`,
    owner,
    repoName,
    authToken,
    baseBranch: options.ref?.trim() ? undefined : options.branch,
  });
  return { repoPath, authToken };
}

/** Git errors meaning the remote simply does not have the requested ref/object. */
const MISSING_REMOTE_REF_PATTERNS = [
  /couldn't find remote ref/i,
  /not our ref/i,
  /no such remote ref/i,
  /unadvertised object/i,
];

function isMissingRemoteRefError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return MISSING_REMOTE_REF_PATTERNS.some(pattern => pattern.test(message));
}

/** Refspecs to try for `ref`, most specific first. `ref` must already be validated. */
function refspecsFor(ref: string): string[] {
  if (isFullCommitSha(ref)) return [ref];
  return remoteRefMappings(ref).map(({ remote, local }) => `+${remote}:${local}`);
}

/**
 * Explicitly fetches `ref` (branch, tag or full commit SHA) from origin into
 * `repoPath`. A ref the remote does not have is not an error (the caller's
 * resolution reports 404); any other fetch failure is raised as a 502 so an
 * unreachable remote is not reported as a nonexistent ref.
 */
export async function fetchRequestedRef(repoPath: string, ref: string, authToken: string): Promise<void> {
  if (ref === 'HEAD') return;
  const git = createHooklessGit(repoPath);
  configureGitAuthentication(git, authToken);

  let shallow = false;
  try {
    shallow = (await git.raw(['rev-parse', '--is-shallow-repository'])).trim() === 'true';
  } catch {
    // Treat an unknown state as a full clone.
  }
  // In a shallow clone, fetching without --depth would download the ref's full history.
  const depthArgs = shallow ? [`--depth=${GIT_SHALLOW_CLONE_DEPTH || 1}`] : [];

  let failure: unknown = null;
  for (const refspec of refspecsFor(ref)) {
    try {
      await withGitLockRetry(`fetching ${ref}`, () => git.raw(['fetch', '--no-tags', ...depthArgs, 'origin', refspec]));
      return;
    } catch (error) {
      if (!isMissingRemoteRefError(error)) failure = error;
    }
  }
  if (failure) {
    const detail = redactAuthenticatedGitUrl((failure as Error).message);
    logger.warn({ repoPath, ref, error: detail }, 'Failed to fetch requested ref');
    throw new RepositoryRetrievalError(`Failed to fetch ref "${ref}" from origin: ${detail}`, 502);
  }
}
