import { getAuthenticatedOctokit } from '../../auth/githubAuth.js';
import type {
  PrSnapshot,
  PrSnapshotCommit,
  PrSnapshotFile,
  PrSnapshotFileStatus,
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
  const listedFiles = commitFileNames(item.files);
  return {
    sha: requiredString(item.sha, 'commit.sha').toLowerCase(),
    message,
    title: message.split(/\r?\n/, 1)[0],
    authoredAt: nullableString(author.date),
    committedAt: nullableString(committer.date),
    parents,
    files: listedFiles.length > 0 ? listedFiles : commitFileNames(detailRecord.files),
  };
}

async function readCommitDetails(
  octokit: PrSnapshotClient,
  request: Omit<ReadPrSnapshotRequest, 'octokit'>,
  rawCommits: unknown[],
): Promise<PrSnapshotCommit[]> {
  const commits: PrSnapshotCommit[] = [];
  for (const rawCommit of rawCommits) {
    const item = requiredRecord(rawCommit, 'commit');
    const sha = requiredString(item.sha, 'commit.sha');
    let detail: unknown = rawCommit;
    if (commitFileNames(item.files).length === 0) {
      const response = await octokit.request('GET /repos/{owner}/{repo}/commits/{ref}', {
        owner: request.owner,
        repo: request.repo,
        ref: sha,
      });
      detail = response.data;
    }
    commits.push(normalizeCommit(rawCommit, detail));
  }
  return commits;
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

async function readSnapshot(requestInput: ReadPrSnapshotRequest): Promise<PrSnapshot> {
  const request = normalizeRequest(requestInput);
  const octokit = requestInput.octokit ?? await getAuthenticatedOctokit();
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

  const [rawFiles, rawCommits, diffResponse] = await Promise.all([
    readAllPages(octokit, 'GET /repos/{owner}/{repo}/pulls/{pull_number}/files', parameters),
    readAllPages(octokit, 'GET /repos/{owner}/{repo}/pulls/{pull_number}/commits', parameters),
    octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
      ...parameters,
      mediaType: { format: 'diff' },
    }),
  ]);

  const changedFiles = rawFiles.map(normalizeFile);
  const commits = await readCommitDetails(octokit, request, rawCommits);
  if (typeof diffResponse.data !== 'string') {
    throw new Error('GitHub pull request diff response was not text');
  }

  return {
    owner: request.owner,
    repo: request.repo,
    pullNumber: request.pullNumber,
    baseRef: requiredString(base.ref, 'base.ref'),
    baseSha: requiredString(base.sha, 'base.sha').toLowerCase(),
    headRef: requiredString(head.ref, 'head.ref'),
    headSha: requiredString(head.sha, 'head.sha').toLowerCase(),
    sourceHeadRepository: normalizeRepository(head.repo),
    title: requiredString(metadata.title, 'title'),
    body: typeof metadata.body === 'string' ? metadata.body : '',
    commits,
    changedFiles,
    unifiedDiff: diffResponse.data,
  };
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
