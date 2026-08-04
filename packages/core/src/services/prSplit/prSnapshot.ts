/* eslint-disable max-lines -- Snapshot collection keeps consistency and completeness checks in one boundary. */
import { getAuthenticatedOctokit } from '../../auth/githubAuth.js';
import type {
  PrSnapshot,
  PrSnapshotCommit,
  PrSnapshotFile,
  PrSnapshotFileStatus,
  PrSnapshotRepositoryFile,
  PrSplitRepository,
} from './types.js';

export interface PrSnapshotGitHubResponse {
  data: unknown;
  headers?: Record<string, string | number | undefined>;
}

/** The Octokit capabilities used by snapshot collection. */
export interface PrSnapshotClient {
  request(
    route: string,
    parameters: Record<string, unknown>,
  ): Promise<PrSnapshotGitHubResponse>;
}

export interface ReadPrSnapshotRequest {
  owner: string;
  repo: string;
  pullNumber: number;
  octokit?: PrSnapshotClient;
  /** Primarily useful for workers/tests that need stricter resource ceilings. */
  resourceLimits?: Partial<PrSnapshotResourceLimits>;
}

export interface PrSnapshotResourceLimits {
  maxRequests: number;
  maxRetainedBytes: number;
  maxElapsedMs: number;
}

interface SnapshotBudget extends PrSnapshotResourceLimits {
  requests: number;
  retainedBytes: number;
  deadline: number;
}

interface RepositoryCoordinates {
  owner: string;
  repo: string;
}

interface SnapshotReader {
  octokit: PrSnapshotClient;
  budget: SnapshotBudget;
  targetRepository: RepositoryCoordinates;
  headRepository: RepositoryCoordinates;
}

interface RepositoryRequestOptions {
  route: string;
  repository: RepositoryCoordinates;
  parameters: Record<string, unknown>;
  fallback?: RepositoryCoordinates;
}

interface RawFileOptions {
  repository: RepositoryCoordinates;
  path: string;
  ref: string;
  fallback?: RepositoryCoordinates;
}

type UnknownRecord = Record<string, unknown>;

const PAGE_SIZE = 100;
const MAX_PAGES = 100;
const MAX_PR_FILES = 3_000;
const MAX_PR_COMMITS = 250;
const DETAIL_CONCURRENCY = 6;
const MAX_REPOSITORY_CONFIG_FILES = 500;
const MAX_ANALYSIS_FILE_BYTES = 1_000_000;
const DEFAULT_RESOURCE_LIMITS: PrSnapshotResourceLimits = {
  maxRequests: 750,
  maxRetainedBytes: 32 * 1024 * 1024,
  maxElapsedMs: 120_000,
};
const REPOSITORY_CONFIG_PATH = /(^|\/)(?:package\.json|pnpm-workspace\.yaml|pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?|tsconfig(?:\.[^/]+)?\.json|jsconfig\.json|pyproject\.toml|poetry\.lock|uv\.lock|requirements[^/]*\.txt|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|Gemfile|Gemfile\.lock|composer\.json|composer\.lock|pom\.xml|gradlew|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|gradle\.lockfile|Makefile|Package\.swift|Package\.resolved)$/i;
const REPOSITORY_CONTENT_PATH = /(^|\/)(?:package\.json|tsconfig(?:\.[^/]+)?\.json|jsconfig\.json|pyproject\.toml|Gemfile|composer\.json|Makefile)$/i;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null;
}

function requiredRecord(value: unknown, field: string): UnknownRecord {
  if (!isRecord(value)) throw new Error(`GitHub PR response is missing ${field}`);
  return value;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`GitHub PR response is missing ${field}`);
  }
  return value.trim();
}

function requiredPossiblyEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`GitHub PR response is missing ${field}`);
  return value;
}

class SnapshotConsistencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotConsistencyError';
  }
}

class SnapshotResourceLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotResourceLimitError';
  }
}

function errorStatus(error: unknown): number | null {
  if (!isRecord(error)) return null;
  if (typeof error.status === 'number') return error.status;
  const response = isRecord(error.response) ? error.response : null;
  return response && typeof response.status === 'number' ? response.status : null;
}

function isExpectedUnavailable(error: unknown): boolean {
  const status = errorStatus(error);
  return status === 404 || status === 409 || status === 422;
}

function createBudget(limits: Partial<PrSnapshotResourceLimits> | undefined): SnapshotBudget {
  const normalized = { ...DEFAULT_RESOURCE_LIMITS, ...limits };
  for (const [name, value] of Object.entries(normalized)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive safe integer`);
    }
  }
  return {
    ...normalized,
    requests: 0,
    retainedBytes: 0,
    deadline: Date.now() + normalized.maxElapsedMs,
  };
}

async function budgetedRequest(
  octokit: PrSnapshotClient,
  budget: SnapshotBudget,
  route: string,
  parameters: Record<string, unknown>,
): Promise<PrSnapshotGitHubResponse> {
  if (budget.requests >= budget.maxRequests) {
    throw new SnapshotResourceLimitError(`PR snapshot request budget exceeded (${budget.maxRequests})`);
  }
  const remaining = budget.deadline - Date.now();
  if (remaining <= 0) {
    throw new SnapshotResourceLimitError(`PR snapshot time budget exceeded (${budget.maxElapsedMs}ms)`);
  }
  budget.requests += 1;
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      octokit.request(route, parameters),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new SnapshotResourceLimitError(
          `PR snapshot time budget exceeded (${budget.maxElapsedMs}ms)`,
        )), remaining);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function retainText(budget: SnapshotBudget, value: string, description: string): void {
  const bytes = Buffer.byteLength(value, 'utf8');
  if (budget.retainedBytes + bytes > budget.maxRetainedBytes) {
    throw new SnapshotResourceLimitError(
      `PR snapshot retained-byte budget exceeded while reading ${description} (${budget.maxRetainedBytes} bytes)`,
    );
  }
  budget.retainedBytes += bytes;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function requiredNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`GitHub PR response is missing ${field}`);
  }
  return value;
}

function normalizeStatus(value: unknown): PrSnapshotFileStatus {
  const supported: PrSnapshotFileStatus[] = [
    'added', 'modified', 'removed', 'renamed', 'copied', 'changed', 'unchanged',
  ];
  return typeof value === 'string' && supported.includes(value as PrSnapshotFileStatus)
    ? value as PrSnapshotFileStatus
    : 'unknown';
}

function normalizeFile(value: unknown): PrSnapshotFile {
  const file = requiredRecord(value, 'changed file');
  return {
    filename: requiredString(file.filename, 'changed file filename'),
    previousFilename: nullableString(file.previous_filename),
    status: normalizeStatus(file.status),
    additions: nonNegativeInteger(file.additions),
    deletions: nonNegativeInteger(file.deletions),
    changes: nonNegativeInteger(file.changes),
    patch: nullableString(file.patch),
    sha: nullableString(file.sha)?.toLowerCase() ?? null,
    baseContent: null,
    headContent: null,
    contentComplete: false,
  };
}

function normalizeRepository(value: unknown): PrSplitRepository | null {
  if (value === null || value === undefined) return null;
  const repository = requiredRecord(value, 'head.repo');
  const owner = requiredRecord(repository.owner, 'head.repo.owner');
  const fullName = requiredString(repository.full_name, 'head.repo.full_name');
  const [fallbackOwner, fallbackName] = fullName.split('/', 2);
  return {
    owner: typeof owner.login === 'string' && owner.login.trim() ? owner.login.trim() : fallbackOwner,
    name: typeof repository.name === 'string' && repository.name.trim()
      ? repository.name.trim()
      : fallbackName,
    fullName,
    cloneUrl: nullableString(repository.clone_url),
    defaultBranch: nullableString(repository.default_branch),
    private: repository.private === true,
  };
}

function responseHasNextPage(
  response: PrSnapshotGitHubResponse,
  itemCount: number,
): boolean {
  const link = response.headers?.link;
  if (typeof link === 'string') return link.includes('rel="next"');
  return itemCount === PAGE_SIZE;
}

async function readAllPages(
  octokit: PrSnapshotClient,
  budget: SnapshotBudget,
  route: string,
  parameters: Record<string, unknown>,
): Promise<unknown[]> {
  const values: unknown[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await budgetedRequest(octokit, budget, route, {
      ...parameters,
      per_page: PAGE_SIZE,
      page,
    });
    if (!Array.isArray(response.data)) {
      throw new Error(`GitHub ${route} response was not an array`);
    }
    values.push(...response.data);
    if (!responseHasNextPage(response, response.data.length)) return values;
  }
  throw new Error(`GitHub ${route} pagination exceeded ${MAX_PAGES} pages`);
}

function commitFileNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.flatMap((file) => {
    if (!isRecord(file) || typeof file.filename !== 'string' || !file.filename.trim()) return [];
    return [file.filename.trim()];
  }))].sort();
}

function normalizeCommit(value: unknown, detail?: unknown): PrSnapshotCommit {
  const item = requiredRecord(value, 'commit');
  const commit = requiredRecord(item.commit, 'commit.commit');
  const detailRecord = isRecord(detail) ? detail : item;
  const detailCommit = isRecord(detailRecord.commit) ? detailRecord.commit : commit;
  const author = isRecord(detailCommit.author) ? detailCommit.author : {};
  const committer = isRecord(detailCommit.committer) ? detailCommit.committer : {};
  const message = requiredPossiblyEmptyString(
    detailCommit.message,
    'commit.commit.message',
  ).slice(0, 65_536);
  const parents = Array.isArray(detailRecord.parents)
    ? detailRecord.parents.flatMap(parent => isRecord(parent) && typeof parent.sha === 'string'
      ? [parent.sha.toLowerCase()]
      : [])
    : [];
  return {
    sha: requiredString(item.sha, 'commit.sha').toLowerCase(),
    message,
    title: (message.split(/\r?\n/, 1)[0] || '(empty commit message)').slice(0, 500),
    authoredAt: nullableString(author.date),
    committedAt: nullableString(committer.date),
    parents,
    files: commitFileNames(detailRecord.files),
    filesComplete: true,
  };
}

async function mapWithConcurrency<Input, Output>(
  values: readonly Input[],
  concurrency: number,
  mapper: (value: Input, index: number) => Promise<Output>,
): Promise<Output[]> {
  const output = new Array<Output>(values.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      output[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(concurrency, values.length) },
    () => worker(),
  ));
  return output;
}

function sameRepository(left: RepositoryCoordinates, right: RepositoryCoordinates): boolean {
  return left.owner.toLowerCase() === right.owner.toLowerCase()
    && left.repo.toLowerCase() === right.repo.toLowerCase();
}

async function repositoryRequest(
  reader: SnapshotReader,
  options: RepositoryRequestOptions,
): Promise<PrSnapshotGitHubResponse> {
  const { route, repository, parameters, fallback } = options;
  try {
    return await budgetedRequest(reader.octokit, reader.budget, route, {
      ...parameters,
      owner: repository.owner,
      repo: repository.repo,
    });
  } catch (error) {
    if (!fallback || sameRepository(repository, fallback) || !isExpectedUnavailable(error)) throw error;
    return budgetedRequest(reader.octokit, reader.budget, route, {
      ...parameters,
      owner: fallback.owner,
      repo: fallback.repo,
    });
  }
}

async function readCommitDetail(
  reader: SnapshotReader,
  sha: string,
): Promise<unknown> {
  let firstDetail: UnknownRecord | null = null;
  const files: unknown[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await repositoryRequest(reader, {
      route: 'GET /repos/{owner}/{repo}/commits/{ref}',
      repository: reader.headRepository,
      parameters: { ref: sha, per_page: PAGE_SIZE, page },
      fallback: reader.targetRepository,
    });
    const detail = requiredRecord(response.data, 'commit detail');
    firstDetail ??= detail;
    const pageFiles = Array.isArray(detail.files) ? detail.files : [];
    files.push(...pageFiles);
    if (!responseHasNextPage(response, pageFiles.length)) {
      return { ...firstDetail, files };
    }
  }
  throw new Error(`GitHub commit ${sha} file pagination exceeded ${MAX_PAGES} pages`);
}

async function readCommitDetails(
  reader: SnapshotReader,
  rawCommits: unknown[],
): Promise<PrSnapshotCommit[]> {
  const detailCache = new Map<string, Promise<unknown>>();
  return mapWithConcurrency(rawCommits, DETAIL_CONCURRENCY, async (rawCommit) => {
    const item = requiredRecord(rawCommit, 'commit');
    const sha = requiredString(item.sha, 'commit.sha');
    const key = sha.toLowerCase();
    let detail = detailCache.get(key);
    if (!detail) {
      detail = readCommitDetail(reader, sha);
      detailCache.set(key, detail);
    }
    return normalizeCommit(rawCommit, await detail);
  });
}

function normalizeRequest(
  request: ReadPrSnapshotRequest,
): Omit<ReadPrSnapshotRequest, 'octokit' | 'resourceLimits'> {
  const owner = request.owner.trim();
  const repo = request.repo.trim();
  if (!owner) throw new RangeError('owner must not be empty');
  if (!repo) throw new RangeError('repo must not be empty');
  if (!Number.isSafeInteger(request.pullNumber) || request.pullNumber <= 0) {
    throw new RangeError('pullNumber must be a positive safe integer');
  }
  return { owner, repo, pullNumber: request.pullNumber };
}

async function readRawFile(
  reader: SnapshotReader,
  options: RawFileOptions,
): Promise<{ content: string | null; complete: boolean }> {
  const { repository, path, ref, fallback } = options;
  try {
    const response = await repositoryRequest(reader, {
      route: 'GET /repos/{owner}/{repo}/contents/{path}',
      repository,
      parameters: { path, ref, mediaType: { format: 'raw' } },
      fallback,
    });
    if (typeof response.data !== 'string') return { content: null, complete: false };
    if (Buffer.byteLength(response.data, 'utf8') > MAX_ANALYSIS_FILE_BYTES) {
      return { content: null, complete: false };
    }
    retainText(reader.budget, response.data, path);
    return { content: response.data, complete: true };
  } catch (error) {
    if (!isExpectedUnavailable(error)) throw error;
    return { content: null, complete: false };
  }
}

async function enrichChangedFileContents(
  reader: SnapshotReader,
  files: readonly PrSnapshotFile[],
  refs: { baseSha: string; headSha: string },
): Promise<PrSnapshotFile[]> {
  return mapWithConcurrency(files, DETAIL_CONCURRENCY, async (file) => {
    const needsBase = file.status !== 'added' && file.status !== 'copied';
    const needsHead = file.status !== 'removed';
    const basePath = file.status === 'renamed' ? file.previousFilename : file.filename;
    const [base, head] = await Promise.all([
      needsBase && basePath
        ? readRawFile(reader, {
          repository: reader.targetRepository,
          path: basePath,
          ref: refs.baseSha,
        })
        : Promise.resolve({ content: null, complete: !needsBase }),
      needsHead
        ? readRawFile(reader, {
          repository: reader.headRepository,
          path: file.filename,
          ref: refs.headSha,
          fallback: reader.targetRepository,
        })
        : Promise.resolve({ content: null, complete: true }),
    ]);
    return {
      ...file,
      baseContent: base.content,
      headContent: head.content,
      contentComplete: base.complete && head.complete,
    };
  });
}

async function readRepositoryFiles(
  reader: SnapshotReader,
  headSha: string,
): Promise<{ files: PrSnapshotRepositoryFile[]; treeComplete: boolean }> {
  try {
    const response = await repositoryRequest(reader, {
      route: 'GET /repos/{owner}/{repo}/git/trees/{tree_sha}',
      repository: reader.headRepository,
      parameters: { tree_sha: headSha, recursive: '1' },
      fallback: reader.targetRepository,
    });
    const data = requiredRecord(response.data, 'repository tree');
    if (!Array.isArray(data.tree)) return { files: [], treeComplete: false };
    const paths = [...new Set(data.tree.flatMap((entry) => {
      if (!isRecord(entry) || entry.type !== 'blob' || typeof entry.path !== 'string') return [];
      return REPOSITORY_CONFIG_PATH.test(entry.path) ? [entry.path] : [];
    }))].sort();
    const boundedPaths = paths.slice(0, MAX_REPOSITORY_CONFIG_FILES);
    const files = await mapWithConcurrency(boundedPaths, DETAIL_CONCURRENCY, async (path) => {
      if (!REPOSITORY_CONTENT_PATH.test(path)) {
        return { path, content: null, contentComplete: false };
      }
      const result = await readRawFile(reader, {
        repository: reader.headRepository,
        path,
        ref: headSha,
        fallback: reader.targetRepository,
      });
      return { path, content: result.content, contentComplete: result.complete };
    });
    return {
      files,
      treeComplete: data.truncated !== true && paths.length <= MAX_REPOSITORY_CONFIG_FILES,
    };
  } catch (error) {
    if (!isExpectedUnavailable(error)) throw error;
    return { files: [], treeComplete: false };
  }
}

function assertSnapshotListLimits(
  expectedFileCount: number,
  expectedCommitCount: number,
  budget: SnapshotBudget,
): void {
  if (expectedFileCount > MAX_PR_FILES) {
    throw new Error(`Pull request has ${expectedFileCount} changed files; GitHub exposes at most ${MAX_PR_FILES} files for reliable snapshot analysis`);
  }
  if (expectedCommitCount > MAX_PR_COMMITS) {
    throw new Error(`Pull request has ${expectedCommitCount} commits; GitHub exposes at most ${MAX_PR_COMMITS} commits for reliable snapshot analysis`);
  }
  const worstCaseMinimumRequests = (expectedFileCount * 2) + expectedCommitCount + 6;
  if (budget.requests + worstCaseMinimumRequests > budget.maxRequests) {
    throw new SnapshotResourceLimitError(
      `Pull request requires at least ${worstCaseMinimumRequests} additional API requests, exceeding the aggregate snapshot budget of ${budget.maxRequests}`,
    );
  }
}

async function readMergeBaseSha(
  reader: SnapshotReader,
  baseSha: string,
  headSha: string,
): Promise<string | null> {
  try {
    const comparisonResponse = await repositoryRequest(reader, {
      route: 'GET /repos/{owner}/{repo}/compare/{basehead}',
      repository: reader.targetRepository,
      parameters: { basehead: `${baseSha}...${headSha}` },
    });
    const comparison = isRecord(comparisonResponse.data) ? comparisonResponse.data : null;
    const mergeBase = comparison && isRecord(comparison.merge_base_commit)
      ? comparison.merge_base_commit
      : null;
    return mergeBase && typeof mergeBase.sha === 'string' && mergeBase.sha.trim()
      ? mergeBase.sha.trim().toLowerCase()
      : null;
  } catch (error) {
    if (!isExpectedUnavailable(error)) throw error;
    return null;
  }
}

async function readSnapshotAttempt(
  request: Omit<ReadPrSnapshotRequest, 'octokit' | 'resourceLimits'>,
  octokit: PrSnapshotClient,
  budget: SnapshotBudget,
): Promise<{ snapshot: PrSnapshot; stable: boolean }> {
  const parameters = {
    owner: request.owner,
    repo: request.repo,
    pull_number: request.pullNumber,
  };
  const metadataResponse = await budgetedRequest(
    octokit,
    budget,
    'GET /repos/{owner}/{repo}/pulls/{pull_number}',
    parameters,
  );
  const metadata = requiredRecord(metadataResponse.data, 'pull request metadata');
  const base = requiredRecord(metadata.base, 'base');
  const head = requiredRecord(metadata.head, 'head');
  const baseSha = requiredString(base.sha, 'base.sha').toLowerCase();
  const headSha = requiredString(head.sha, 'head.sha').toLowerCase();
  const expectedFileCount = requiredNonNegativeInteger(metadata.changed_files, 'changed_files');
  const expectedCommitCount = requiredNonNegativeInteger(metadata.commits, 'commits');
  assertSnapshotListLimits(expectedFileCount, expectedCommitCount, budget);

  const targetRepository = { owner: request.owner, repo: request.repo };
  const sourceHeadRepository = normalizeRepository(head.repo);
  const headRepository = sourceHeadRepository
    ? { owner: sourceHeadRepository.owner, repo: sourceHeadRepository.name }
    : targetRepository;
  const reader: SnapshotReader = {
    octokit,
    budget,
    targetRepository,
    headRepository,
  };

  let collection: [unknown[], unknown[], PrSnapshotGitHubResponse];
  try {
    collection = await Promise.all([
      readAllPages(octokit, budget, 'GET /repos/{owner}/{repo}/pulls/{pull_number}/files', parameters),
      readAllPages(octokit, budget, 'GET /repos/{owner}/{repo}/pulls/{pull_number}/commits', parameters),
      budgetedRequest(octokit, budget, 'GET /repos/{owner}/{repo}/pulls/{pull_number}', {
        ...parameters,
        mediaType: { format: 'diff' },
      }),
    ]);
  } catch (error) {
    const status = errorStatus(error);
    if (status === 409 || status === 422) {
      throw new SnapshotConsistencyError('GitHub comparison data changed during snapshot collection');
    }
    throw error;
  }
  const [rawFiles, rawCommits, diffResponse] = collection;

  if (rawFiles.length !== expectedFileCount) {
    throw new SnapshotConsistencyError(`GitHub returned ${rawFiles.length} of ${expectedFileCount} changed files while the PR was moving`);
  }
  if (rawCommits.length !== expectedCommitCount) {
    throw new SnapshotConsistencyError(`GitHub returned ${rawCommits.length} of ${expectedCommitCount} commits while the PR was moving`);
  }
  const normalizedFiles = rawFiles.map(normalizeFile);
  for (const file of normalizedFiles) {
    if (file.patch !== null) retainText(budget, file.patch, `patch for ${file.filename}`);
  }
  const [changedFiles, repositoryContext] = await Promise.all([
    enrichChangedFileContents(reader, normalizedFiles, { baseSha, headSha }),
    readRepositoryFiles(reader, headSha),
  ]);
  const commits = await readCommitDetails(reader, rawCommits);
  for (const commit of commits) retainText(budget, commit.message, `commit ${commit.sha}`);
  if (typeof diffResponse.data !== 'string') {
    throw new Error('GitHub pull request diff response was not text');
  }
  retainText(budget, diffResponse.data, 'unified diff');

  const mergeBaseSha = await readMergeBaseSha(reader, baseSha, headSha);

  const verificationResponse = await budgetedRequest(
    octokit,
    budget,
    'GET /repos/{owner}/{repo}/pulls/{pull_number}',
    parameters,
  );
  const verification = requiredRecord(verificationResponse.data, 'pull request verification metadata');
  const verificationBase = requiredRecord(verification.base, 'verification base');
  const verificationHead = requiredRecord(verification.head, 'verification head');
  const verificationBaseSha = requiredString(verificationBase.sha, 'verification base.sha').toLowerCase();
  const verificationHeadSha = requiredString(verificationHead.sha, 'verification head.sha').toLowerCase();
  const verificationFileCount = requiredNonNegativeInteger(
    verification.changed_files,
    'verification changed_files',
  );
  const verificationCommitCount = requiredNonNegativeInteger(
    verification.commits,
    'verification commits',
  );

  return { snapshot: {
    owner: request.owner,
    repo: request.repo,
    pullNumber: request.pullNumber,
    baseRef: requiredString(base.ref, 'base.ref'),
    baseSha,
    mergeBaseSha,
    headRef: requiredString(head.ref, 'head.ref'),
    headSha,
    sourceHeadRepository,
    title: requiredString(metadata.title, 'title'),
    body: typeof metadata.body === 'string' ? metadata.body : '',
    commits,
    changedFiles,
    repositoryFiles: repositoryContext.files,
    repositoryTreeComplete: repositoryContext.treeComplete,
    unifiedDiff: diffResponse.data,
    unifiedDiffComplete: false,
  }, stable: verificationHeadSha === headSha
    && verificationBaseSha === baseSha
    && verificationFileCount === expectedFileCount
    && verificationCommitCount === expectedCommitCount };
}

async function readSnapshot(requestInput: ReadPrSnapshotRequest): Promise<PrSnapshot> {
  const request = normalizeRequest(requestInput);
  const octokit = requestInput.octokit ?? await getAuthenticatedOctokit();
  const budget = createBudget(requestInput.resourceLimits);
  let consistencyFailure: Error | null = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const result = await readSnapshotAttempt(request, octokit, budget);
      if (result.stable) return result.snapshot;
      consistencyFailure = new SnapshotConsistencyError(
        'Pull request base, head, file count, or commit count changed while collecting the snapshot',
      );
    } catch (error) {
      if (!(error instanceof SnapshotConsistencyError)) throw error;
      consistencyFailure = error;
    }
  }
  throw new Error(
    `${consistencyFailure?.message ?? 'Pull request changed while collecting the snapshot'}; retry after the pull request stabilizes`,
  );
}

export function readPrSnapshot(request: ReadPrSnapshotRequest): Promise<PrSnapshot>;
export function readPrSnapshot(
  owner: string,
  repo: string,
  pullNumber: number,
  octokit?: PrSnapshotClient,
): Promise<PrSnapshot>;
export function readPrSnapshot(
  requestOrOwner: ReadPrSnapshotRequest | string,
  repo?: string,
  pullNumber?: number,
  octokit?: PrSnapshotClient,
): Promise<PrSnapshot> {
  const request = typeof requestOrOwner === 'string'
    ? { owner: requestOrOwner, repo: repo ?? '', pullNumber: pullNumber ?? 0, octokit }
    : requestOrOwner;
  return readSnapshot(request);
}

export const fetchPrSnapshot = readPrSnapshot;
