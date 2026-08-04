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
}

type UnknownRecord = Record<string, unknown>;

const PAGE_SIZE = 100;
const MAX_PAGES = 100;
const MAX_PR_FILES = 3_000;
const MAX_PR_COMMITS = 250;
const DETAIL_CONCURRENCY = 6;
const MAX_REPOSITORY_CONFIG_FILES = 500;
const MAX_ANALYSIS_FILE_BYTES = 1_000_000;
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
  route: string,
  parameters: Record<string, unknown>,
): Promise<unknown[]> {
  const values: unknown[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await octokit.request(route, {
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
  const message = requiredString(detailCommit.message, 'commit.commit.message');
  const parents = Array.isArray(detailRecord.parents)
    ? detailRecord.parents.flatMap(parent => isRecord(parent) && typeof parent.sha === 'string'
      ? [parent.sha.toLowerCase()]
      : [])
    : [];
  return {
    sha: requiredString(item.sha, 'commit.sha').toLowerCase(),
    message,
    title: message.split(/\r?\n/, 1)[0],
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

async function readCommitDetail(
  octokit: PrSnapshotClient,
  request: Omit<ReadPrSnapshotRequest, 'octokit'>,
  sha: string,
): Promise<unknown> {
  let firstDetail: UnknownRecord | null = null;
  const files: unknown[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await octokit.request('GET /repos/{owner}/{repo}/commits/{ref}', {
      owner: request.owner,
      repo: request.repo,
      ref: sha,
      per_page: PAGE_SIZE,
      page,
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
  octokit: PrSnapshotClient,
  request: Omit<ReadPrSnapshotRequest, 'octokit'>,
  rawCommits: unknown[],
): Promise<PrSnapshotCommit[]> {
  const detailCache = new Map<string, Promise<unknown>>();
  return mapWithConcurrency(rawCommits, DETAIL_CONCURRENCY, async (rawCommit) => {
    const item = requiredRecord(rawCommit, 'commit');
    const sha = requiredString(item.sha, 'commit.sha');
    const key = sha.toLowerCase();
    let detail = detailCache.get(key);
    if (!detail) {
      detail = readCommitDetail(octokit, request, sha);
      detailCache.set(key, detail);
    }
    return normalizeCommit(rawCommit, await detail);
  });
}

function normalizeRequest(request: ReadPrSnapshotRequest): Omit<ReadPrSnapshotRequest, 'octokit'> {
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
  octokit: PrSnapshotClient,
  request: Omit<ReadPrSnapshotRequest, 'octokit'>,
  path: string,
  ref: string,
): Promise<{ content: string | null; complete: boolean }> {
  try {
    const response = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
      owner: request.owner,
      repo: request.repo,
      path,
      ref,
      mediaType: { format: 'raw' },
    });
    if (typeof response.data !== 'string') return { content: null, complete: false };
    if (Buffer.byteLength(response.data, 'utf8') > MAX_ANALYSIS_FILE_BYTES) {
      return { content: null, complete: false };
    }
    return { content: response.data, complete: true };
  } catch {
    return { content: null, complete: false };
  }
}

async function enrichChangedFileContents(
  octokit: PrSnapshotClient,
  request: Omit<ReadPrSnapshotRequest, 'octokit'>,
  files: readonly PrSnapshotFile[],
  refs: { baseSha: string; headSha: string },
): Promise<PrSnapshotFile[]> {
  return mapWithConcurrency(files, DETAIL_CONCURRENCY, async (file) => {
    const needsBase = file.status !== 'added' && file.status !== 'copied';
    const needsHead = file.status !== 'removed';
    const basePath = file.status === 'renamed' ? file.previousFilename : file.filename;
    const [base, head] = await Promise.all([
      needsBase && basePath
        ? readRawFile(octokit, request, basePath, refs.baseSha)
        : Promise.resolve({ content: null, complete: !needsBase }),
      needsHead
        ? readRawFile(octokit, request, file.filename, refs.headSha)
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
  octokit: PrSnapshotClient,
  request: Omit<ReadPrSnapshotRequest, 'octokit'>,
  headSha: string,
): Promise<{ files: PrSnapshotRepositoryFile[]; treeComplete: boolean }> {
  try {
    const response = await octokit.request('GET /repos/{owner}/{repo}/git/trees/{tree_sha}', {
      owner: request.owner,
      repo: request.repo,
      tree_sha: headSha,
      recursive: '1',
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
      const result = await readRawFile(octokit, request, path, headSha);
      return { path, content: result.content, contentComplete: result.complete };
    });
    return {
      files,
      treeComplete: data.truncated !== true && paths.length <= MAX_REPOSITORY_CONFIG_FILES,
    };
  } catch {
    return { files: [], treeComplete: false };
  }
}

function assertUnifiedDiffCoverage(diff: string, files: readonly PrSnapshotFile[]): void {
  const lines = diff.split(/\r?\n/);
  const missing = files.filter(file => {
    const paths = [file.filename, file.previousFilename].filter((path): path is string => Boolean(path));
    return !paths.some(path => lines.some(line =>
      line === `--- a/${path}`
      || line === `+++ b/${path}`
      || line === `rename from ${path}`
      || line === `rename to ${path}`
      || (line.startsWith('diff --git ') && (
        line.endsWith(` a/${path}`)
        || line.endsWith(` b/${path}`)
        || line.endsWith(JSON.stringify(`a/${path}`))
        || line.endsWith(JSON.stringify(`b/${path}`))
      ))));
  });
  if (missing.length > 0) {
    throw new Error(
      `GitHub unified diff omitted ${missing.length} changed file${missing.length === 1 ? '' : 's'}; refusing incomplete analysis`,
    );
  }
}

async function readSnapshotAttempt(
  request: Omit<ReadPrSnapshotRequest, 'octokit'>,
  octokit: PrSnapshotClient,
): Promise<{ snapshot: PrSnapshot; stable: boolean }> {
  const parameters = {
    owner: request.owner,
    repo: request.repo,
    pull_number: request.pullNumber,
  };
  const metadataResponse = await octokit.request(
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
  if (expectedFileCount > MAX_PR_FILES) {
    throw new Error(`Pull request has ${expectedFileCount} changed files; GitHub exposes at most ${MAX_PR_FILES} files for reliable snapshot analysis`);
  }
  if (expectedCommitCount > MAX_PR_COMMITS) {
    throw new Error(`Pull request has ${expectedCommitCount} commits; GitHub exposes at most ${MAX_PR_COMMITS} commits for reliable snapshot analysis`);
  }

  const [rawFiles, rawCommits, diffResponse] = await Promise.all([
    readAllPages(octokit, 'GET /repos/{owner}/{repo}/pulls/{pull_number}/files', parameters),
    readAllPages(octokit, 'GET /repos/{owner}/{repo}/pulls/{pull_number}/commits', parameters),
    octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
      ...parameters,
      mediaType: { format: 'diff' },
    }),
  ]);

  if (rawFiles.length !== expectedFileCount) {
    throw new Error(`GitHub returned ${rawFiles.length} of ${expectedFileCount} changed files; refusing an incomplete snapshot`);
  }
  if (rawCommits.length !== expectedCommitCount) {
    throw new Error(`GitHub returned ${rawCommits.length} of ${expectedCommitCount} commits; refusing an incomplete snapshot`);
  }
  const normalizedFiles = rawFiles.map(normalizeFile);
  const [changedFiles, repositoryContext] = await Promise.all([
    enrichChangedFileContents(octokit, request, normalizedFiles, { baseSha, headSha }),
    readRepositoryFiles(octokit, request, headSha),
  ]);
  const commits = await readCommitDetails(octokit, request, rawCommits);
  if (typeof diffResponse.data !== 'string') {
    throw new Error('GitHub pull request diff response was not text');
  }
  assertUnifiedDiffCoverage(diffResponse.data, changedFiles);

  const verificationResponse = await octokit.request(
    'GET /repos/{owner}/{repo}/pulls/{pull_number}',
    parameters,
  );
  const verification = requiredRecord(verificationResponse.data, 'pull request verification metadata');
  const verificationHead = requiredRecord(verification.head, 'verification head');
  const verificationHeadSha = requiredString(verificationHead.sha, 'verification head.sha').toLowerCase();

  return { snapshot: {
    owner: request.owner,
    repo: request.repo,
    pullNumber: request.pullNumber,
    baseRef: requiredString(base.ref, 'base.ref'),
    baseSha,
    headRef: requiredString(head.ref, 'head.ref'),
    headSha,
    sourceHeadRepository: normalizeRepository(head.repo),
    title: requiredString(metadata.title, 'title'),
    body: typeof metadata.body === 'string' ? metadata.body : '',
    commits,
    changedFiles,
    repositoryFiles: repositoryContext.files,
    repositoryTreeComplete: repositoryContext.treeComplete,
    unifiedDiff: diffResponse.data,
  }, stable: verificationHeadSha === headSha };
}

async function readSnapshot(requestInput: ReadPrSnapshotRequest): Promise<PrSnapshot> {
  const request = normalizeRequest(requestInput);
  const octokit = requestInput.octokit ?? await getAuthenticatedOctokit();
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const result = await readSnapshotAttempt(request, octokit);
    if (result.stable) return result.snapshot;
  }
  throw new Error('Pull request head changed while collecting the snapshot; retry after the head stabilizes');
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
