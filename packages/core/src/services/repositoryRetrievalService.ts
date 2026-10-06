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
import { getGitHubInstallationToken } from '../auth/githubAuth.js';
import { createHooklessGit } from '../git/hooklessGit.js';
import { ensureRepoCloned } from '../git/repoManager.js';
import { resolveRepositoryClonePath } from '../git/repositoryPaths.js';
import { findRelevantFiles, type RelevantFile } from './relevanceService.js';
import logger from '../utils/logger.js';
import {
  RepositoryRetrievalError,
  type ReadRepositoryFileOptions,
  type ReadRepositoryFileResult,
  type RepositoryIndexingState,
  type RepositoryLineMatch,
  type RepositoryMatchReason,
  type RepositorySearchMatch,
  type RepositorySearchMode,
  type RepositoryTargetOptions,
  type SearchRepositoryFilesOptions,
  type SearchRepositoryFilesResult,
} from './repositoryRetrievalTypes.js';
import {
  assertSafeRef,
  assertSafeRepositoryPath,
  boundedInteger,
  buildPagination,
  normalizePathPrefix,
  parseRepository,
} from './repositoryRetrievalValidation.js';

const CLONES_BASE_PATH = process.env.GIT_CLONES_BASE_PATH || '/tmp/git-processor/clones';

const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 100;
const DEFAULT_LINE_MATCHES_PER_FILE = 5;
const MAX_LINE_MATCHES_PER_FILE = 50;
const MAX_LINE_MATCH_TEXT_LENGTH = 500;
const MAX_QUERY_LENGTH = 1000;
const DEFAULT_MAX_LINES = 800;
const HARD_MAX_LINES = 5000;
const DEFAULT_MAX_BYTES = 120_000;
const HARD_MAX_BYTES = 1_000_000;
/** Blobs above this size are refused before being loaded into memory. */
const MAX_BLOB_BYTES = 20 * 1024 * 1024;

export * from './repositoryRetrievalTypes.js';
export { assertSafeRepositoryPath } from './repositoryRetrievalValidation.js';

// --- Repository and ref resolution ---

async function resolveCloneToken(authToken?: string): Promise<string> {
  try {
    return await getGitHubInstallationToken();
  } catch (error) {
    if (authToken) return authToken;
    throw new RepositoryRetrievalError(`No GitHub credentials available to clone repository: ${(error as Error).message}`, 503);
  }
}

async function cloneOrRefresh(owner: string, repoName: string, options: RepositoryTargetOptions): Promise<string> {
  const authToken = await resolveCloneToken(options.authToken);
  return ensureRepoCloned({
    repoUrl: `https://github.com/${owner}/${repoName}.git`,
    owner,
    repoName,
    authToken,
    baseBranch: options.branch,
  });
}

interface ResolvedTarget {
  repoPath: string;
  ref: string;
  commit: string;
}

async function revParseCommit(repoPath: string, candidate: string): Promise<string | null> {
  try {
    const output = await createHooklessGit(repoPath).raw(['rev-parse', '--verify', '--quiet', '--end-of-options', `${candidate}^{commit}`]);
    const sha = output.trim();
    return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

async function resolveCommit(repoPath: string, ref: string): Promise<string | null> {
  return await revParseCommit(repoPath, ref)
    ?? (ref === 'HEAD' ? null : await revParseCommit(repoPath, `refs/remotes/origin/${ref}`));
}

/**
 * Finds a local clone (cloning or fetching when needed) and resolves the
 * requested ref to an exact commit.
 */
async function resolveTarget(options: RepositoryTargetOptions): Promise<ResolvedTarget> {
  const { owner, repoName } = parseRepository(options.repository);
  const ref = assertSafeRef((options.ref || options.branch || 'HEAD').trim());

  if (options.repoPath) {
    const commit = await resolveCommit(options.repoPath, ref);
    if (!commit) throw new RepositoryRetrievalError(`Ref "${ref}" not found in ${options.repository}`, 404);
    return { repoPath: options.repoPath, ref, commit };
  }

  const localPath = resolveRepositoryClonePath(CLONES_BASE_PATH, owner, repoName);
  if (await fs.pathExists(path.join(localPath, '.git'))) {
    const commit = await resolveCommit(localPath, ref);
    if (commit) return { repoPath: localPath, ref, commit };
  }

  // Missing clone or unknown ref: clone/fetch, then retry once.
  const repoPath = await cloneOrRefresh(owner, repoName, options);
  const commit = await resolveCommit(repoPath, ref);
  if (!commit) throw new RepositoryRetrievalError(`Ref "${ref}" not found in ${options.repository}`, 404);
  return { repoPath, ref, commit };
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

async function searchSemantic({ options, query, pathPrefix, offset, limit }: SearchRequest): Promise<SearchRepositoryFilesResult> {
  const repository = options.repository.trim();
  const target = await resolveTarget(options);
  const indexBranch = options.branch?.trim() || 'HEAD';
  const row = await loadIndexRow(repository, indexBranch);

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
  if (usedIndex && row?.last_indexed_hash && row.last_indexed_hash !== target.commit) {
    stale = true;
    caveat = `Index for branch "${indexBranch}" was built at ${row.last_indexed_hash.slice(0, 12)}, but ${target.ref} is at ${target.commit.slice(0, 12)}; recently changed files may be ranked using outdated summaries.`;
  }

  const relevance = await findRelevantFiles(target.repoPath, query, {
    correlationId: options.correlationId,
    useSummaryScoring: usedIndex,
    agent,
    modelId: agent?.config.defaultModel,
    repoName: repository,
    branch: indexBranch,
  });

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
  };
}

// --- Literal search ---

interface GrepFileMatch {
  path: string;
  matchCount: number;
  lineMatches: RepositoryLineMatch[];
}

/**
 * Parses `git grep -n -z <commit>` output. Each record looks like
 * `<commit>:<path>\0<line>\0<text>`; `-z` keeps paths containing ':' intact.
 */
export function parseGitGrepOutput(output: string, commit: string, maxLineMatchesPerFile: number): GrepFileMatch[] {
  const files = new Map<string, GrepFileMatch>();
  const commitPrefix = `${commit}:`;

  for (const record of output.split('\n')) {
    if (!record) continue;
    const firstNul = record.indexOf('\0');
    const secondNul = firstNul === -1 ? -1 : record.indexOf('\0', firstNul + 1);
    if (secondNul === -1) continue;

    let filePath = record.slice(0, firstNul);
    if (filePath.startsWith(commitPrefix)) filePath = filePath.slice(commitPrefix.length);
    const lineNumber = Number.parseInt(record.slice(firstNul + 1, secondNul), 10);
    if (!filePath || !Number.isFinite(lineNumber)) continue;

    let entry = files.get(filePath);
    if (!entry) {
      entry = { path: filePath, matchCount: 0, lineMatches: [] };
      files.set(filePath, entry);
    }
    entry.matchCount += 1;
    if (entry.lineMatches.length < maxLineMatchesPerFile) {
      const text = record.slice(secondNul + 1);
      entry.lineMatches.push({
        lineNumber,
        text: text.length > MAX_LINE_MATCH_TEXT_LENGTH ? `${text.slice(0, MAX_LINE_MATCH_TEXT_LENGTH)}…` : text,
      });
    }
  }

  return Array.from(files.values());
}

function isNoMatchError(error: unknown): boolean {
  const err = error as { exitCode?: number; message?: string };
  if (err?.exitCode === 1) return true;
  // simple-git reports `git grep` exit code 1 (no matches) as an empty error.
  return typeof err?.message === 'string' && err.message.trim() === '';
}

async function searchLiteral({ options, query, pathPrefix, offset, limit }: SearchRequest): Promise<SearchRepositoryFilesResult> {
  const target = await resolveTarget(options);
  const maxLineMatchesPerFile = boundedInteger(options.maxLineMatchesPerFile, 'maxLineMatchesPerFile', {
    fallback: DEFAULT_LINE_MATCHES_PER_FILE, min: 0, max: MAX_LINE_MATCHES_PER_FILE,
  });

  const args = ['grep', '-n', '-I', '-z', '--no-color', '-F'];
  if (!options.caseSensitive) args.push('-i');
  args.push('-e', query, target.commit, '--');
  if (pathPrefix) {
    // Narrow the search to the deepest directory of the prefix; partial file
    // or directory names are matched by the startsWith filter below.
    const slash = pathPrefix.lastIndexOf('/');
    const directory = slash === -1 ? '' : pathPrefix.slice(0, slash);
    if (directory) args.push(`:(literal,top)${directory}`);
  }

  let output = '';
  try {
    output = await createHooklessGit(target.repoPath).raw(args);
  } catch (error) {
    if (!isNoMatchError(error)) {
      throw new RepositoryRetrievalError(`git grep failed: ${(error as Error).message}`, 500);
    }
  }

  const all = parseGitGrepOutput(output, target.commit, maxLineMatchesPerFile)
    .filter(file => !pathPrefix || file.path.startsWith(pathPrefix));

  const matches = all.slice(offset, offset + limit).map((file): RepositorySearchMatch => ({
    path: file.path,
    matchCount: file.matchCount,
    lineMatches: file.lineMatches,
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

function splitLines(content: string): string[] {
  if (content === '') return [];
  const lines = content.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Longest prefix of `text` whose UTF-8 encoding fits in `maxBytes`. */
function truncateToBytes(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return text;
  let end = maxBytes;
  // Step back over UTF-8 continuation bytes so we never split a character.
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString('utf8');
}

async function readBlob(repoPath: string, commit: string, filePath: string, repository: string): Promise<string> {
  const git = createHooklessGit(repoPath);
  const object = `${commit}:${filePath}`;

  let type: string;
  try {
    type = (await git.raw(['cat-file', '-t', object])).trim();
  } catch {
    throw new RepositoryRetrievalError(`File "${filePath}" not found in ${repository} at ${commit.slice(0, 12)}`, 404);
  }
  if (type !== 'blob') {
    throw new RepositoryRetrievalError(`"${filePath}" is a ${type === 'tree' ? 'directory' : type}, not a file`, 400);
  }

  const size = Number.parseInt((await git.raw(['cat-file', '-s', object])).trim(), 10);
  if (Number.isFinite(size) && size > MAX_BLOB_BYTES) {
    throw new RepositoryRetrievalError(`File "${filePath}" is too large to read (${size} bytes)`, 413);
  }

  return git.show([object]);
}

/**
 * Reads a bounded line range of a file from the git object database at the
 * requested ref, without touching the working tree.
 */
export async function readRepositoryFileContent(options: ReadRepositoryFileOptions): Promise<ReadRepositoryFileResult> {
  const filePath = assertSafeRepositoryPath(options.path).replace(/^\.\//, '');
  parseRepository(options.repository);

  const startLine = boundedInteger(options.startLine, 'startLine', { fallback: 1, min: 1, max: Number.MAX_SAFE_INTEGER });
  const requestedEnd = options.endLine === undefined || options.endLine === null
    ? undefined
    : boundedInteger(options.endLine, 'endLine', { fallback: 1, min: 1, max: Number.MAX_SAFE_INTEGER });
  if (requestedEnd !== undefined && requestedEnd < startLine) {
    throw new RepositoryRetrievalError('endLine must be greater than or equal to startLine', 400);
  }
  const maxLines = boundedInteger(options.maxLines, 'maxLines', { fallback: DEFAULT_MAX_LINES, min: 1, max: HARD_MAX_LINES });
  const maxBytes = boundedInteger(options.maxBytes, 'maxBytes', { fallback: DEFAULT_MAX_BYTES, min: 1, max: HARD_MAX_BYTES });

  const target = await resolveTarget(options);
  const content = await readBlob(target.repoPath, target.commit, filePath, options.repository.trim());

  if (content.includes('\0')) {
    throw new RepositoryRetrievalError(`"${filePath}" appears to be a binary file and cannot be read as text`, 400);
  }

  const lines = splitLines(content);
  const totalLines = lines.length;
  const rangeEnd = Math.min(requestedEnd ?? totalLines, totalLines);

  const selected: string[] = [];
  let returnedBytes = 0;
  let truncated = false;

  for (let lineNo = startLine; lineNo <= rangeEnd; lineNo++) {
    if (selected.length >= maxLines) {
      truncated = true;
      break;
    }
    const line = lines[lineNo - 1];
    const lineBytes = Buffer.byteLength(line, 'utf8') + (selected.length > 0 ? 1 : 0);
    if (returnedBytes + lineBytes > maxBytes) {
      truncated = true;
      if (selected.length === 0) {
        // A single oversized line: return its leading bytes rather than nothing.
        const partial = truncateToBytes(line, maxBytes);
        selected.push(partial);
        returnedBytes = Buffer.byteLength(partial, 'utf8');
      }
      break;
    }
    selected.push(line);
    returnedBytes += lineBytes;
  }

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
  };
}
