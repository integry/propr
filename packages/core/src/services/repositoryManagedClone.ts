/**
 * Managed clone preparation for repository retrieval: cloning/refreshing the
 * shared clone and fetching a single requested ref into it.
 *
 * Managed clones may be shallow and single-branch (GIT_SHALLOW_CLONE_DEPTH), so
 * the regular `git fetch origin --prune` refresh only updates the branches in
 * the clone's configured refspec. A branch, tag or commit outside that scope
 * has to be fetched explicitly before it can be resolved, and a branch that is
 * in scope may still be behind origin, so retrieval refreshes the requested
 * ref itself on every request rather than trusting the clone's local refs.
 */

import { getGitHubInstallationToken } from '../auth/githubAuth.js';
import { createHooklessGit } from '../git/hooklessGit.js';
import { ensureRepoCloned } from '../git/repoManager.js';
import { configureGitAuthentication } from '../git/repoBranching.js';
import { redactAuthenticatedGitUrl } from '../git/redactGitUrl.js';
import { withGitLockRetry } from '../git/configLock.js';
import logger from '../utils/logger.js';
import { RepositoryRetrievalError, type RepositoryTargetOptions } from './repositoryRetrievalTypes.js';
import { isFullCommitSha, remoteRefMappings, type RemoteRefMapping } from './repositoryRetrievalValidation.js';

const GIT_SHALLOW_CLONE_DEPTH = process.env.GIT_SHALLOW_CLONE_DEPTH ? parseInt(process.env.GIT_SHALLOW_CLONE_DEPTH) : undefined;

export async function resolveCloneToken(authToken?: string): Promise<string> {
  try {
    return await getGitHubInstallationToken();
  } catch (error) {
    if (authToken) return authToken;
    throw new RepositoryRetrievalError(`No GitHub credentials available to clone repository: ${(error as Error).message}`, 503);
  }
}

/**
 * Clones the repository when no shared clone exists yet. The clone is always
 * prepared on the default branch, independently of the requested
 * `ref`/`branch`, so that a nonexistent branch cannot fail cloning; the caller
 * fetches the requested ref explicitly and reports it as not found if absent.
 * An existing clone is left alone: `ensureRepoCloned` would check out the
 * default branch under worker and indexing code sharing the clone, and
 * retrieval only ever needs the ref-scoped fetches below.
 */
export async function cloneManagedRepository(owner: string, repoName: string, options: RepositoryTargetOptions): Promise<{ repoPath: string; authToken: string }> {
  const authToken = await resolveCloneToken(options.authToken);
  try {
    const repoPath = await ensureRepoCloned({
      repoUrl: `https://github.com/${owner}/${repoName}.git`,
      owner,
      repoName,
      authToken,
    });
    return { repoPath, authToken };
  } catch (error) {
    // A clone failure is an unreachable or unreadable remote, as for a failed
    // fetch: retryable, never reported as an internal error.
    const detail = redactAuthenticatedGitUrl((error as Error)?.message ?? String(error));
    logger.warn({ repository: `${owner}/${repoName}`, error: detail }, 'Failed to clone repository for retrieval');
    throw new RepositoryRetrievalError(`Failed to clone repository: ${detail}`, 502);
  }
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

/**
 * Where origin's HEAD is stored in a managed clone. Outside refs/remotes so a
 * worker's `git fetch --prune` never removes it, and not the clone's own
 * HEAD, which reflects whatever the worker last checked out.
 */
export const ORIGIN_HEAD_REF = 'refs/propr/retrieval/origin-head';

/** Where `ref` lives on origin and locally once fetched; HEAD maps to origin's HEAD. */
export function managedRefMappings(ref: string): RemoteRefMapping[] {
  if (ref === 'HEAD') return [{ remote: 'HEAD', local: ORIGIN_HEAD_REF }];
  return remoteRefMappings(ref);
}

/**
 * Tags origin recently reported missing. Every unqualified branch name is
 * probed as a tag first (git prefers a same-named tag), so without this each
 * request for `main` would pay an extra round trip. A tag created on origin
 * is therefore seen at most this long after it appears.
 */
const MISSING_TAG_TTL_MS = 60_000;
/** Most missing tags remembered; requests for many distinct names evict the oldest. */
const MAX_MISSING_TAGS = 1000;
/** Entries share one TTL and are re-inserted on update, so insertion order is expiry order. */
const missingTags = new Map<string, number>();
/** Concurrent fetches of the same ref into the same clone share one round trip. */
const inflightFetches = new Map<string, Promise<string | null>>();

function missingTagKey(repoPath: string, remote: string): string {
  return `${repoPath}\0${remote}`;
}

/** Whether origin recently reported tag `remote` missing from the clone at `repoPath`. */
export function isKnownMissingTag(repoPath: string, remote: string): boolean {
  const key = missingTagKey(repoPath, remote);
  const expiresAt = missingTags.get(key);
  if (expiresAt === undefined) return false;
  if (expiresAt > Date.now()) return true;
  missingTags.delete(key);
  return false;
}

function rememberMissingTag(repoPath: string, remote: string): void {
  const key = missingTagKey(repoPath, remote);
  const now = Date.now();
  missingTags.delete(key);
  missingTags.set(key, now + MISSING_TAG_TTL_MS);
  for (const [candidate, expiresAt] of missingTags) {
    if (expiresAt > now && missingTags.size <= MAX_MISSING_TAGS) break;
    missingTags.delete(candidate);
  }
}

/** Number of remembered missing tags; exposed for tests. */
export function missingTagCacheSize(): number {
  return missingTags.size;
}

async function localRefExists(git: ReturnType<typeof createHooklessGit>, ref: string): Promise<boolean> {
  try {
    await git.raw(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Explicitly fetches `ref` (branch, tag, HEAD or full commit SHA) from origin
 * into `repoPath`, trying each place it may live most specific first and
 * stopping at the first one origin has. Resolves to what to resolve the
 * fetched commit through (the local ref it was stored under, or the SHA
 * itself), or null when origin has none of them. Callers resolve exactly that
 * target: a cached ref origin just reported missing (e.g. a deleted tag
 * shadowing a same-named branch) must not answer. A ref the remote does not
 * have is not an error (the caller reports 404); any other fetch failure is
 * raised as a 502 so an unreachable remote is not reported as a nonexistent ref.
 */
export function fetchRequestedRef(repoPath: string, ref: string, authToken: string): Promise<string | null> {
  const key = `${repoPath}\0${ref}`;
  const pending = inflightFetches.get(key);
  if (pending) return pending;
  const fetching = fetchRequestedRefOnce(repoPath, ref, authToken).finally(() => inflightFetches.delete(key));
  inflightFetches.set(key, fetching);
  return fetching;
}

async function fetchRequestedRefOnce(repoPath: string, ref: string, authToken: string): Promise<string | null> {
  const git = createHooklessGit(repoPath);
  configureGitAuthentication(git, authToken);

  let shallow = false;
  try {
    shallow = (await git.raw(['rev-parse', '--is-shallow-repository'])).trim() === 'true';
  } catch {
    // Treat an unknown state as a full clone.
  }
  const targets = isFullCommitSha(ref) ? [{ remote: ref, local: null }] : managedRefMappings(ref);
  let failure: unknown = null;
  for (const { remote, local } of targets) {
    const isTag = remote.startsWith('refs/tags/');
    if (isTag && isKnownMissingTag(repoPath, remote)) continue;
    // In a shallow clone, fetching a ref with no local history without --depth
    // would download its full history. A ref already present only needs the
    // new commits, and --depth there would move the shallow boundary of
    // history the worker relies on.
    const depthArgs = shallow && !(local && await localRefExists(git, local)) ? [`--depth=${GIT_SHALLOW_CLONE_DEPTH || 1}`] : [];
    const refspec = local ? `+${remote}:${local}` : remote;
    try {
      await withGitLockRetry(`fetching ${ref}`, () => git.raw(['fetch', '--no-tags', ...depthArgs, 'origin', refspec]));
      if (isTag) missingTags.delete(missingTagKey(repoPath, remote));
      return local ?? remote;
    } catch (error) {
      // Any other failure leaves it unknown whether origin has this more
      // specific ref, so a less specific one must not answer in its place.
      if (!isMissingRemoteRefError(error)) { failure = error; break; }
      if (isTag) rememberMissingTag(repoPath, remote);
    }
  }
  if (failure) {
    const detail = redactAuthenticatedGitUrl((failure as Error).message);
    logger.warn({ repoPath, ref, error: detail }, 'Failed to fetch requested ref');
    throw new RepositoryRetrievalError(`Failed to fetch ref "${ref}" from origin: ${detail}`, 502);
  }
  return null;
}
