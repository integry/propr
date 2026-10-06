/**
 * Public types for the repository retrieval service.
 */

export type RepositorySearchMode = 'semantic' | 'literal';
export type RepositoryMatchReason = 'semantic' | 'path-match' | 'git-history';
export type RepositoryIndexingState = 'idle' | 'indexing' | 'completed' | 'failed';

/** Error carrying an HTTP-style status so API/MCP layers can map it directly. */
export class RepositoryRetrievalError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'RepositoryRetrievalError';
    this.status = status;
  }
}

export interface RepositoryTargetOptions {
  /** Repository full name, e.g. "owner/repo". */
  repository: string;
  /** Branch name; used as the ref when `ref` is absent and as the index branch. */
  branch?: string;
  /** Any git ref or commit SHA. Takes precedence over `branch` for git lookups. */
  ref?: string;
  /** Use an existing local clone instead of resolving/cloning one. */
  repoPath?: string;
  /** Fallback token used when no GitHub App installation token is available. */
  authToken?: string;
  correlationId?: string;
}

export interface SearchRepositoryFilesOptions extends RepositoryTargetOptions {
  query: string;
  mode?: RepositorySearchMode;
  /** Restrict results to repository paths starting with this prefix. */
  path?: string;
  /** Literal mode only. Defaults to false. */
  caseSensitive?: boolean;
  offset?: number;
  limit?: number;
  /** Literal mode only: line matches returned per file (counts are always complete). */
  maxLineMatchesPerFile?: number;
}

export interface RepositoryLineMatch {
  lineNumber: number;
  text: string;
}

export interface RepositorySearchMatch {
  path: string;
  /** Relevance score 0-100 (semantic mode). */
  score?: number;
  /** Signals that contributed to the score (semantic mode). */
  reasons?: RepositoryMatchReason[];
  /** Number of matching lines in the file (literal mode). */
  matchCount?: number;
  /** First matching lines (literal mode). */
  lineMatches?: RepositoryLineMatch[];
}

export interface RepositorySearchFreshness {
  /** Branch whose index was consulted. */
  indexBranch: string;
  indexingStatus: RepositoryIndexingState | null;
  lastIndexedAt: string | null;
  lastIndexedHash: string | null;
  /** True when file summaries contributed to the ranking. */
  usedIndex: boolean;
  /** True when the index is missing, incomplete, or older than the searched commit. */
  stale: boolean;
  caveat?: string;
}

export interface RepositorySearchPagination {
  offset: number;
  limit: number;
  nextOffset: number | null;
  totalMatches: number;
}

export interface SearchRepositoryFilesResult {
  repository: string;
  mode: RepositorySearchMode;
  query: string;
  ref: string;
  commit: string | null;
  pathPrefix: string | null;
  matches: RepositorySearchMatch[];
  pagination: RepositorySearchPagination;
  /** Present in semantic mode. */
  freshness?: RepositorySearchFreshness;
  /** Keywords the relevance engine extracted (semantic mode). */
  keywordsDetected?: string[];
}

export interface ReadRepositoryFileOptions extends RepositoryTargetOptions {
  path: string;
  /** 1-based, inclusive. Defaults to 1. */
  startLine?: number;
  /** 1-based, inclusive. Defaults to the last line. */
  endLine?: number;
  maxLines?: number;
  maxBytes?: number;
}

export interface ReadRepositoryFileResult {
  repository: string;
  path: string;
  ref: string;
  commit: string;
  content: string;
  /** First line returned (1-based). */
  startLine: number;
  /** Last line returned (1-based); `startLine - 1` when nothing was returned. */
  endLine: number;
  totalLines: number;
  totalBytes: number;
  returnedBytes: number;
  truncated: boolean;
  /** Line to request next to continue reading, or null when the range was fully returned. */
  nextStartLine: number | null;
}
