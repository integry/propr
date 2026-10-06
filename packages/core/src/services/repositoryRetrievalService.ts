/**
 * Repository retrieval primitives: semantic/literal file search and bounded
 * file reading straight from the git object database.
 *
 * Semantic search reuses the planner's relevance engine (file summaries plus
 * keyword/path/git-history scoring). Literal search runs `git grep` against an
 * exact commit, and reads use `git show <commit>:<path>`, so neither depends on
 * what is currently checked out in the shared clone.
 */

import fs from 'fs-extra';
import path from 'path';
import { db } from '../db/connection.js';
import { getAgentRegistry } from '../agents/AgentRegistry.js';
import { createHooklessGit } from '../git/hooklessGit.js';
import { resolveRepositoryClonePath } from '../git/repositoryPaths.js';
import { findRelevantFiles, type RelevantFile } from './relevanceService.js';
import logger from '../utils/logger.js';
import { selectLines, splitLines } from './repositoryFileLines.js';
import { GrepAggregator, MAX_GREP_MATCHED_FILES, streamGitGrep } from './repositoryLiteralGrep.js';
import { readBlob } from './repositoryBlobReader.js';
import { cachedRelevance, relevanceCacheKey } from './repositoryRelevanceCache.js';
import { cloneManagedRepository, fetchRequestedRef, isKnownMissingTag, managedRefMappings, resolveCloneToken } from './repositoryManagedClone.js';
import {
  RepositoryRetrievalError,
  type ReadRepositoryFileOptions,
  type ReadRepositoryFileResult,
  type RepositoryIndexingState,
  type RepositoryMatchReason,
  type RepositorySearchMatch,
  type RepositorySearchMode,
  type RepositoryTargetOptions,
  type SearchRepositoryFilesOptions,
  type SearchRepositoryFilesResult,
} from './repositoryRetrievalTypes.js';
import {
  assertSafeRef,
  boundedInteger,
  buildPagination,
  canonicalRepositoryPath,
  isFullCommitSha,
  normalizeCommitSha,
  normalizePathPrefix,
  parseRepository,
  remoteRefMappings,
} from './repositoryRetrievalValidation.js';

const CLONES_BASE_PATH = process.env.GIT_CLONES_BASE_PATH || '/tmp/git-processor/clones';

const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 100;
const DEFAULT_LINE_MATCHES_PER_FILE = 5;
const MAX_LINE_MATCHES_PER_FILE = 50;
const MAX_QUERY_LENGTH = 1000;
const DEFAULT_MAX_LINES = 800;
const HARD_MAX_LINES = 5000;
const DEFAULT_MAX_BYTES = 120_000;
const HARD_MAX_BYTES = 1_000_000;

export * from './repositoryRetrievalTypes.js';
export { parseGitGrepOutput } from './repositoryLiteralGrep.js';
export { assertSafeRepositoryPath } from './repositoryRetrievalValidation.js';
export { clearRelevanceCache } from './repositoryRelevanceCache.js';

// --- Repository and ref resolution ---

interface ResolvedTarget {
  repoPath: string;
  ref: string;
  commit: string;
  /** Set when origin could not be reached and a cached commit answered. */
  refCaveat?: string;
}

async function revParseCommit(repoPath: string, candidate: string): Promise<string | null> {
  try {
    const output = await createHooklessGit(repoPath).raw(['rev-parse', '--verify', '--quiet', '--end-of-options', `${candidate}^{commit}`]);
    const sha = output.trim();
    return /^[0-9a-f]{40,64}$/i.test(sha) ? sha.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Resolves `ref` directly, then via the local refs an explicit fetch stores it under. */
async function resolveCommit(repoPath: string, ref: string): Promise<string | null> {
  const direct = await revParseCommit(repoPath, ref);
  if (direct) return direct;
  for (const { local } of remoteRefMappings(ref)) {
    if (local === ref) continue;
    const commit = await revParseCommit(repoPath, local);
    if (commit) return commit;
  }
  return null;
}

/**
 * Resolves `ref` from the managed clone's cache when origin cannot be reached,
 * through the local refs origin's copy is fetched into, most specific first
 * (a tag before a branch, as git resolves a short name), so a stale local
 * branch or the worker's checked-out HEAD never shadows the remote-tracking
 * ref. A tag origin recently reported missing is skipped so it cannot shadow
 * the same-named branch.
 */
async function resolveCachedCommit(repoPath: string, ref: string): Promise<string | null> {
  for (const { remote, local } of managedRefMappings(ref)) {
    if (remote.startsWith('refs/tags/') && isKnownMissingTag(repoPath, remote)) continue;
    const commit = await revParseCommit(repoPath, local);
    if (commit) return commit;
  }
  return null;
}

/**
 * An abbreviated commit SHA, the one short name origin cannot have as a tag or
 * branch yet git can resolve. Either case is accepted, as git does; it is only
 * tried after origin reported no tag or branch of that exact name.
 */
const ABBREVIATED_SHA = /^[0-9a-f]{4,39}$/i;

/**
 * Resolves `ref` as an abbreviated object id only. Plain `rev-parse` would
 * prefer a same-named local ref (a worker branch called `deadbeef`), which
 * origin does not have and must not answer for.
 */
async function resolveAbbreviatedSha(repoPath: string, ref: string): Promise<string | null> {
  try {
    const output = await createHooklessGit(repoPath).raw(['rev-parse', `--disambiguate=${ref.toLowerCase()}`]);
    const candidates = output.split('\n').map(line => line.trim()).filter(Boolean);
    const commits: string[] = [];
    for (const candidate of candidates) {
      const commit = await revParseCommit(repoPath, candidate);
      if (commit && !commits.includes(commit)) commits.push(commit);
    }
    return commits.length === 1 ? commits[0] : null;
  } catch {
    return null;
  }
}

/**
 * Resolves `ref` in a managed clone. The clone's local refs are a cache of
 * whatever earlier worker runs fetched (local branches are never
 * fast-forwarded), so every branch, tag and HEAD request is refreshed from
 * origin first and resolved through the refs that fetch stores it under.
 * Only full commit SHAs, which cannot move, are answered without a fetch
 * when already present. When origin cannot be reached but the ref resolves
 * from cache, that commit answers with a caveat instead of failing.
 */
async function resolveManagedCommit(
  repoPath: string,
  ref: string,
  getAuthToken: () => Promise<string>,
): Promise<{ commit: string; refCaveat?: string } | null> {
  if (isFullCommitSha(ref)) {
    const cached = await revParseCommit(repoPath, ref);
    if (cached) return { commit: cached };
    await fetchRequestedRef(repoPath, ref, await getAuthToken());
    const fetched = await revParseCommit(repoPath, ref);
    return fetched ? { commit: fetched } : null;
  }

  let fetched: string | null;
  try {
    fetched = await fetchRequestedRef(repoPath, ref, await getAuthToken());
  } catch (error) {
    if (!(error instanceof RepositoryRetrievalError) || (error.status !== 502 && error.status !== 503)) throw error;
    const cached = await resolveCachedCommit(repoPath, ref)
      ?? (ABBREVIATED_SHA.test(ref) ? await resolveAbbreviatedSha(repoPath, ref) : null);
    if (!cached) throw error;
    return {
      commit: cached,
      refCaveat: `Could not refresh "${ref}" from origin, so it was resolved from the managed clone's cached copy, which may be behind origin.`,
    };
  }

  // Resolve exactly what was fetched: a cached ref that origin just reported
  // missing (such as a deleted tag named like a surviving branch) must not
  // shadow it.
  if (fetched) {
    const commit = await revParseCommit(repoPath, fetched);
    if (commit) return { commit };
  }
  // Origin has no tag or branch of this name. A stale remote-tracking or
  // local branch left behind must not answer for it; only an abbreviated
  // commit SHA can still resolve.
  if (!ABBREVIATED_SHA.test(ref)) return null;
  const commit = await resolveAbbreviatedSha(repoPath, ref);
  return commit ? { commit } : null;
}

/**
 * Finds a local clone (cloning when needed) and resolves the requested ref to
 * an exact commit, refreshed from origin.
 */
async function resolveTarget(options: RepositoryTargetOptions): Promise<ResolvedTarget> {
  const { owner, repoName } = parseRepository(options.repository);
  const ref = normalizeCommitSha(assertSafeRef((options.ref || options.branch || 'HEAD').trim()));

  if (options.repoPath) {
    const commit = await resolveCommit(options.repoPath, ref);
    if (!commit) throw new RepositoryRetrievalError(`Ref "${ref}" not found in ${options.repository}`, 404, 'ref_not_found');
    return { repoPath: options.repoPath, ref, commit };
  }

  let repoPath = resolveRepositoryClonePath(CLONES_BASE_PATH, owner, repoName);
  let getAuthToken = () => resolveCloneToken(options.authToken);
  if (!(await fs.pathExists(path.join(repoPath, '.git')))) {
    // The fresh clone only covers its default branch (a single branch for
    // shallow clones); the requested ref is fetched explicitly below.
    const cloned = await cloneManagedRepository(owner, repoName, options);
    repoPath = cloned.repoPath;
    getAuthToken = async () => cloned.authToken;
  }

  const resolved = await resolveManagedCommit(repoPath, ref, getAuthToken);
  if (!resolved) throw new RepositoryRetrievalError(`Ref "${ref}" not found in ${options.repository}`, 404, 'ref_not_found');
  return { repoPath, ref, ...resolved };
}

// --- Semantic search ---

interface IndexRow {
  indexing_status: RepositoryIndexingState | null;
  last_indexed_at: Date | string | null;
  last_indexed_hash: string | null;
}

async function loadIndexRow(repository: string, branch: string): Promise<IndexRow | null> {
  const row = await db('repositories')
    .where({ full_name: repository, branch })
    .select('indexing_status', 'last_indexed_at', 'last_indexed_hash')
    .first();
  return (row as IndexRow | undefined) ?? null;
}

function toIsoString(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function describeIndexCaveat(row: IndexRow | null, indexBranch: string): string | null {
  if (!row || !row.indexing_status || (row.indexing_status === 'idle' && !row.last_indexed_at)) {
    return `Repository has not been indexed for branch "${indexBranch}"; results use keyword, path, and git-history heuristics only.`;
  }
  if (row.indexing_status === 'indexing') {
    return `Indexing for branch "${indexBranch}" is in progress; results use keyword, path, and git-history heuristics only and may miss files.`;
  }
  if (row.indexing_status === 'failed') {
    return `The last indexing run for branch "${indexBranch}" failed; results use keyword, path, and git-history heuristics only.`;
  }
  return null;
}

/**
 * Loads the index row for `branch`, falling back (like summary scoring) to the
 * default-branch (HEAD) index when the branch has none; `indexBranch` reports
 * which index was consulted.
 */
async function loadIndexRowWithFallback(repository: string, branch: string): Promise<{ row: IndexRow | null; indexBranch: string }> {
  const row = await loadIndexRow(repository, branch);
  if (row || branch === 'HEAD') return { row, indexBranch: branch };
  const headRow = await loadIndexRow(repository, 'HEAD');
  return headRow ? { row: headRow, indexBranch: 'HEAD' } : { row: null, indexBranch: branch };
}

/**
 * Says why a usable index's summaries may not describe the searched commit,
 * or null when the index was verifiably built from it. An index that does not
 * record its commit cannot be verified, so its freshness is unknown.
 */
function describeRevisionCaveat(row: IndexRow | null, indexBranch: string, target: ResolvedTarget): string | null {
  const commit = target.commit.slice(0, 12);
  if (!row?.last_indexed_hash) {
    return `Index for branch "${indexBranch}" does not record the commit it was built from, so it cannot be verified against ${target.ref} at ${commit}; files may be ranked using outdated summaries.`;
  }
  if (row.last_indexed_hash === target.commit) return null;
  return `Index for branch "${indexBranch}" was built at ${row.last_indexed_hash.slice(0, 12)}, but ${target.ref} is at ${commit}; recently changed files may be ranked using outdated summaries.`;
}

function toMatchReasons(file: RelevantFile): RepositoryMatchReason[] {
  const signals = file.signals?.length ? file.signals : [file.reason];
  const reasons = new Set<RepositoryMatchReason>();
  for (const signal of signals) {
    if (signal === 'semantic' || signal === 'llm-semantic') reasons.add('semantic');
    else if (signal === 'path-match' || signal === 'git-history') reasons.add(signal);
  }
  return Array.from(reasons);
}

interface SearchRequest {
  options: SearchRepositoryFilesOptions;
  query: string;
  pathPrefix: string | null;
  offset: number;
  limit: number;
}

/** Runs the relevance engine, reporting its failures (e.g. a failed `git ls-tree`) as retrieval errors. */
async function scoreRelevance(...args: Parameters<typeof findRelevantFiles>): ReturnType<typeof findRelevantFiles> {
  try {
    return await findRelevantFiles(...args);
  } catch (error) {
    if (error instanceof RepositoryRetrievalError) throw error;
    throw new RepositoryRetrievalError(`Semantic search failed: ${(error as Error)?.message ?? String(error)}`, 500);
  }
}

async function searchSemantic({ options, query, pathPrefix, offset, limit }: SearchRequest): Promise<SearchRepositoryFilesResult> {
  const repository = options.repository.trim();
  const target = await resolveTarget(options);
  const requestedIndexBranch = options.branch?.trim() || 'HEAD';
  const { row, indexBranch } = await loadIndexRowWithFallback(repository, requestedIndexBranch);

  let caveat = describeIndexCaveat(row, indexBranch);
  let usedIndex = caveat === null;

  let agent = undefined;
  if (usedIndex) {
    const registry = getAgentRegistry();
    await registry.ensureInitialized();
    agent = registry.getDefaultAgent();
    if (!agent) {
      usedIndex = false;
      caveat = 'No default agent is configured, so file summaries could not be used; results use keyword, path, and git-history heuristics only.';
    }
  }

  let stale = !usedIndex;
  const revisionCaveat = usedIndex ? describeRevisionCaveat(row, indexBranch, target) : null;
  if (revisionCaveat) {
    stale = true;
    caveat = revisionCaveat;
  }
  if (caveat && indexBranch !== requestedIndexBranch) {
    caveat = `Branch "${requestedIndexBranch}" has no index, so the default-branch (HEAD) index was consulted. ${caveat}`;
  }

  // Score against the resolved commit (not the checkout) and keep every
  // eligible file so path filtering and pagination see the full result set.
  const cacheKey = relevanceCacheKey({ repoPath: target.repoPath, repository, commit: target.commit, query, indexBranch, usedIndex, agent, indexRow: row });
  const relevance = await cachedRelevance(cacheKey, usedIndex, () => scoreRelevance(target.repoPath, query, {
    correlationId: options.correlationId,
    useSummaryScoring: usedIndex,
    agent,
    modelId: agent?.config.defaultModel,
    repoName: repository,
    branch: indexBranch,
    commit: target.commit,
    maxResults: Number.POSITIVE_INFINITY,
  }));

  if (usedIndex && !relevance.usedSummaryScoring) {
    usedIndex = false;
    stale = true;
    caveat = 'File summary scoring failed or matched no indexed files, so summaries did not contribute; results use keyword, path, and git-history heuristics only.';
  }

  const filtered = pathPrefix
    ? relevance.files.filter(file => file.path.startsWith(pathPrefix))
    : relevance.files;

  const matches = filtered.slice(offset, offset + limit).map((file): RepositorySearchMatch => ({
    path: file.path,
    score: Math.round(file.score * 100) / 100,
    reasons: toMatchReasons(file),
  }));

  return {
    repository,
    mode: 'semantic',
    query,
    ref: target.ref,
    commit: target.commit,
    pathPrefix,
    matches,
    pagination: buildPagination(offset, limit, filtered.length),
    freshness: {
      indexBranch,
      indexingStatus: row?.indexing_status ?? null,
      lastIndexedAt: toIsoString(row?.last_indexed_at),
      lastIndexedHash: row?.last_indexed_hash ?? null,
      usedIndex,
      stale,
      ...(caveat ? { caveat } : {}),
    },
    keywordsDetected: relevance.keywordsDetected,
    ...(target.refCaveat ? { refCaveat: target.refCaveat } : {}),
  };
}

// --- Literal search ---

async function searchLiteral({ options, query, pathPrefix, offset, limit }: SearchRequest): Promise<SearchRepositoryFilesResult> {
  const target = await resolveTarget(options);
  const maxLineMatchesPerFile = boundedInteger(options.maxLineMatchesPerFile, 'maxLineMatchesPerFile', {
    fallback: DEFAULT_LINE_MATCHES_PER_FILE, min: 0, max: MAX_LINE_MATCHES_PER_FILE,
  });

  // --no-column keeps a configured grep.column from adding a third metadata
  // field that the parser would read as line text.
  const args = ['grep', '-n', '-I', '-z', '--no-color', '--no-column', '-F'];
  if (!options.caseSensitive) args.push('-i');
  args.push('-e', query, target.commit, '--');
  if (pathPrefix) {
    // Narrow the search to the deepest directory of the prefix; partial file
    // or directory names are matched by the startsWith filter below.
    const slash = pathPrefix.lastIndexOf('/');
    const directory = slash === -1 ? '' : pathPrefix.slice(0, slash);
    if (directory) args.push(`:(literal,top)${directory}`);
  }

  const aggregator = new GrepAggregator(target.commit, maxLineMatchesPerFile, MAX_GREP_MATCHED_FILES,
    filePath => !pathPrefix || filePath.startsWith(pathPrefix));
  let scanTruncated: boolean;
  try {
    ({ scanTruncated } = await streamGitGrep(target.repoPath, args, aggregator));
  } catch (error) {
    throw new RepositoryRetrievalError(`git grep failed: ${(error as Error).message}`, 500);
  }
  const all = aggregator.finish(scanTruncated);

  const matches = all.slice(offset, offset + limit).map((file): RepositorySearchMatch => ({
    path: file.path,
    matchCount: file.matchCount,
    lineMatches: file.lineMatches,
    ...(file.countTruncated ? { countTruncated: true } : {}),
  }));

  return {
    repository: options.repository.trim(),
    mode: 'literal',
    query,
    ref: target.ref,
    commit: target.commit,
    pathPrefix,
    matches,
    pagination: buildPagination(offset, limit, all.length),
    scanTruncated,
    ...(target.refCaveat ? { refCaveat: target.refCaveat } : {}),
  };
}

/**
 * Searches repository files either semantically (relevance engine with index
 * summaries) or literally (`git grep` at the requested ref).
 */
export async function searchRepositoryFiles(options: SearchRepositoryFilesOptions): Promise<SearchRepositoryFilesResult> {
  const mode: RepositorySearchMode = options.mode ?? 'semantic';
  if (mode !== 'semantic' && mode !== 'literal') {
    throw new RepositoryRetrievalError(`Unsupported search mode "${String(mode)}"`, 400);
  }
  const query = typeof options.query === 'string' ? options.query : '';
  if (!query.trim()) throw new RepositoryRetrievalError('query is required', 400);
  if (query.length > MAX_QUERY_LENGTH) {
    throw new RepositoryRetrievalError(`query must be at most ${MAX_QUERY_LENGTH} characters`, 400);
  }
  if (query.includes('\0') || (mode === 'literal' && query.includes('\n'))) {
    throw new RepositoryRetrievalError('query must not contain null bytes or newlines', 400);
  }
  parseRepository(options.repository);

  const pathPrefix = normalizePathPrefix(options.path);
  const offset = boundedInteger(options.offset, 'offset', { fallback: 0, min: 0, max: Number.MAX_SAFE_INTEGER });
  const limit = boundedInteger(options.limit, 'limit', { fallback: DEFAULT_SEARCH_LIMIT, min: 1, max: MAX_SEARCH_LIMIT });

  const correlatedLogger = options.correlationId ? logger.withCorrelation(options.correlationId) : logger;
  correlatedLogger.info({ repository: options.repository, mode, pathPrefix, offset, limit }, 'Searching repository files');

  const request: SearchRequest = { options, query, pathPrefix, offset, limit };
  return mode === 'semantic' ? searchSemantic(request) : searchLiteral(request);
}

// --- File reading ---

/**
 * Reads a bounded line range of a file from the git object database at the
 * requested ref, without touching the working tree.
 */
export async function readRepositoryFileContent(options: ReadRepositoryFileOptions): Promise<ReadRepositoryFileResult> {
  const filePath = canonicalRepositoryPath(options.path);
  parseRepository(options.repository);

  const startLine = boundedInteger(options.startLine, 'startLine', { fallback: 1, min: 1, max: Number.MAX_SAFE_INTEGER });
  const requestedEnd = options.endLine === undefined || options.endLine === null
    ? undefined
    : boundedInteger(options.endLine, 'endLine', { fallback: 1, min: 1, max: Number.MAX_SAFE_INTEGER });
  if (requestedEnd !== undefined && requestedEnd < startLine) {
    throw new RepositoryRetrievalError('endLine must be greater than or equal to startLine', 400);
  }
  const maxLines = boundedInteger(options.maxLines, 'maxLines', { fallback: DEFAULT_MAX_LINES, min: 1, max: HARD_MAX_LINES });
  const maxBytesLimit = Math.min(options.maxBytesLimit ?? HARD_MAX_BYTES, HARD_MAX_BYTES);
  const maxBytes = boundedInteger(options.maxBytes, 'maxBytes', { fallback: Math.min(DEFAULT_MAX_BYTES, maxBytesLimit), min: 1, max: maxBytesLimit });

  const target = await resolveTarget(options);
  const content = await readBlob(target.repoPath, target.commit, filePath, options.repository.trim());

  if (content.includes('\0')) {
    throw new RepositoryRetrievalError(`"${filePath}" appears to be a binary file and cannot be read as text`, 400, 'binary_file');
  }

  const lines = splitLines(content);
  const totalLines = lines.length;
  const rangeEnd = Math.min(requestedEnd ?? totalLines, totalLines);

  const { selected, returnedBytes, truncated } = selectLines(lines, { filePath, startLine, rangeEnd }, {
    maxLines, maxBytes, maxBytesLimit, encodedByteLimit: options.encodedByteLimit,
  });

  const lastReturned = startLine + selected.length - 1;
  const nextStartLine = truncated && lastReturned < rangeEnd ? lastReturned + 1 : null;

  return {
    repository: options.repository.trim(),
    path: filePath,
    ref: target.ref,
    commit: target.commit,
    content: selected.join('\n'),
    startLine,
    endLine: lastReturned,
    totalLines,
    totalBytes: Buffer.byteLength(content, 'utf8'),
    returnedBytes,
    truncated,
    nextStartLine,
    ...(target.refCaveat ? { refCaveat: target.refCaveat } : {}),
  };
}
