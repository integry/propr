/**
 * Human-readable overview for PR review prompt/request payloads.
 *
 * When a task is created from a PR `/review` command, the execution log can
 * surface the raw JSON review request. That JSON is useful for debugging but
 * noisy for normal review workflows. This module detects such payloads and
 * renders a concise, human-readable overview instead, e.g.:
 *
 *   Reviewing PR #123 in owner/repo. 8 files changed, 1,240 diff lines
 *   included, 2 files skipped, 4 previous comments included.
 *
 * This is a presentation-layer helper only. The raw payload remains available
 * internally (the caller still holds the original value); we never mutate the
 * prompt sent to the LLM or the logs stored on the backend.
 *
 * Anything that is not recognizable as a review payload returns `null` so the
 * caller can fall back to the existing raw/markdown rendering path.
 */

type JsonObject = Record<string, unknown>;

// Wrapper keys under which a review payload may be nested (e.g. `{ prompt: {...} }`).
const WRAPPER_KEYS = [
  'prompt',
  'reviewRequest',
  'review_request',
  'reviewPrompt',
  'review_prompt',
  'request',
  'payload',
  'review',
  'data',
];

// Field name variants. Both camelCase and snake_case are accepted so future
// schema tweaks do not silently reintroduce raw JSON into the UI.
const PR_NUMBER_KEYS = [
  'pullRequestNumber',
  'pull_request_number',
  'prNumber',
  'pr_number',
];
const PR_OBJECT_KEYS = ['pullRequest', 'pull_request', 'pr'];
const REPO_OWNER_KEYS = ['repoOwner', 'repo_owner', 'owner'];
const REPO_NAME_KEYS = ['repoName', 'repo_name', 'repo', 'name'];
const REPOSITORY_KEYS = ['repository', 'repo'];
const CHANGED_FILES_KEYS = [
  'changedFiles',
  'changed_files',
  'filesChanged',
  'files_changed',
  'changedFileCount',
  'files',
];
const DIFF_LINES_KEYS = [
  'diffLines',
  'diff_lines',
  'diffLineCount',
  'diff_line_count',
  'diffLinesIncluded',
  'diff_lines_included',
  'lineCount',
];
const SKIPPED_FILES_KEYS = [
  'skippedFiles',
  'skipped_files',
  'omittedFiles',
  'omitted_files',
  'filesSkipped',
  'files_skipped',
  'skipped',
];
const PREVIOUS_COMMENTS_KEYS = [
  'previousComments',
  'previous_comments',
  'priorComments',
  'prior_comments',
  'commentCount',
  'comment_count',
  'previousCommentCount',
  'comments',
];
const INSTRUCTIONS_KEYS = [
  'instructions',
  'reviewInstructions',
  'review_instructions',
  'reviewFocus',
  'review_focus',
  'focus',
  'additionalInstructions',
  'additional_instructions',
];

const isPlainObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// Return the first present, non-null value among the candidate keys.
const getField = (obj: JsonObject, keys: string[]): unknown => {
  for (const key of keys) {
    const value = obj[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
};

// Coerce a value that may be a count (number) or a collection (array) into a count.
const countOf = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.length;
  return undefined;
};

const formatNumber = (value: number): string => value.toLocaleString('en-US');

const pluralize = (count: number, singular: string, plural?: string): string =>
  count === 1 ? singular : plural ?? `${singular}s`;

// Extract a PR number from either a direct numeric field or a `{ number }` object.
const extractPrNumber = (obj: JsonObject): number | undefined => {
  const direct = getField(obj, PR_NUMBER_KEYS);
  const directNum = typeof direct === 'number' ? direct : undefined;
  if (directNum !== undefined && Number.isFinite(directNum)) return directNum;

  const prObject = getField(obj, PR_OBJECT_KEYS);
  if (isPlainObject(prObject)) {
    const nested = prObject.number;
    if (typeof nested === 'number' && Number.isFinite(nested)) return nested;
  }
  return undefined;
};

interface RepoInfo {
  owner?: string;
  name?: string;
}

// Extract repository owner/name from several shapes:
//   { repoOwner, repoName } | { owner, repo } | { repository: 'owner/name' }
//   { repository: { owner, name } } | { repository: { owner: { login }, name } }
const extractRepo = (obj: JsonObject): RepoInfo => {
  const owner = getField(obj, REPO_OWNER_KEYS);
  const name = getField(obj, REPO_NAME_KEYS);
  if (typeof owner === 'string' && typeof name === 'string') {
    return { owner, name };
  }

  const repository = getField(obj, REPOSITORY_KEYS);
  if (typeof repository === 'string' && repository.includes('/')) {
    const [repoOwner, ...rest] = repository.split('/');
    return { owner: repoOwner, name: rest.join('/') };
  }
  if (isPlainObject(repository)) {
    const repoOwnerRaw = repository.owner;
    const repoOwner = isPlainObject(repoOwnerRaw)
      ? (repoOwnerRaw.login as string | undefined)
      : (repoOwnerRaw as string | undefined);
    const repoName =
      typeof repository.name === 'string'
        ? repository.name
        : typeof repository.repo === 'string'
          ? repository.repo
          : undefined;
    return { owner: repoOwner, name: repoName };
  }

  return {
    owner: typeof owner === 'string' ? owner : undefined,
    name: typeof name === 'string' ? name : undefined,
  };
};

// Extract skipped-file names when the value is an array of strings (or objects
// carrying a filename/path/name), so short lists can be shown inline.
const extractSkippedNames = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      if (isPlainObject(entry)) {
        const name = entry.filename ?? entry.path ?? entry.name ?? entry.file;
        return typeof name === 'string' ? name : undefined;
      }
      return undefined;
    })
    .filter((name): name is string => typeof name === 'string');
};

// Show skipped file names inline only when the list is short and compact.
const MAX_INLINE_SKIPPED_FILES = 3;
const MAX_INLINE_SKIPPED_LENGTH = 80;

const formatSkippedClause = (count: number, names: string[]): string => {
  const base = `${formatNumber(count)} ${pluralize(count, 'file')} skipped`;
  if (
    names.length > 0 &&
    names.length === count &&
    names.length <= MAX_INLINE_SKIPPED_FILES
  ) {
    const joined = names.join(', ');
    if (joined.length <= MAX_INLINE_SKIPPED_LENGTH) {
      return `${base} (${joined})`;
    }
  }
  return base;
};

interface ReviewPayloadFields {
  prNumber: number;
  repo: RepoInfo;
  changedFiles?: number;
  diffLines?: number;
  skippedCount?: number;
  skippedNames: string[];
  previousComments?: number;
  instructions?: string;
}

// Pull the recognized review fields out of a candidate object. Returns null when
// the object lacks the minimum signal of a review payload (a PR number plus at
// least one review-specific field), so unrelated JSON is left untouched.
const extractReviewFields = (obj: JsonObject): ReviewPayloadFields | null => {
  const prNumber = extractPrNumber(obj);
  if (prNumber === undefined) return null;

  const repo = extractRepo(obj);
  const changedFiles = countOf(getField(obj, CHANGED_FILES_KEYS));
  const diffLines = countOf(getField(obj, DIFF_LINES_KEYS));

  const skippedRaw = getField(obj, SKIPPED_FILES_KEYS);
  const skippedCount = countOf(skippedRaw);
  const skippedNames = extractSkippedNames(skippedRaw);

  const previousComments = countOf(getField(obj, PREVIOUS_COMMENTS_KEYS));

  const instructionsRaw = getField(obj, INSTRUCTIONS_KEYS);
  const instructions =
    typeof instructionsRaw === 'string' && instructionsRaw.trim().length > 0
      ? instructionsRaw.trim()
      : undefined;

  const hasReviewSignal =
    (repo.owner !== undefined && repo.name !== undefined) ||
    changedFiles !== undefined ||
    diffLines !== undefined ||
    skippedCount !== undefined ||
    previousComments !== undefined ||
    instructions !== undefined;

  if (!hasReviewSignal) return null;

  return {
    prNumber,
    repo,
    changedFiles,
    diffLines,
    skippedCount,
    skippedNames,
    previousComments,
    instructions,
  };
};

const MAX_INSTRUCTIONS_LENGTH = 160;

// Build the human-readable overview sentence(s) from extracted fields.
const buildOverview = (fields: ReviewPayloadFields): string => {
  const {
    prNumber,
    repo,
    changedFiles,
    diffLines,
    skippedCount,
    skippedNames,
    previousComments,
    instructions,
  } = fields;

  const location =
    repo.owner && repo.name ? ` in ${repo.owner}/${repo.name}` : '';
  const header = `Reviewing PR #${prNumber}${location}.`;

  const clauses: string[] = [];
  if (changedFiles !== undefined) {
    clauses.push(
      `${formatNumber(changedFiles)} ${pluralize(changedFiles, 'file')} changed`
    );
  }
  if (diffLines !== undefined) {
    clauses.push(
      `${formatNumber(diffLines)} ${pluralize(diffLines, 'diff line')} included`
    );
  }
  if (skippedCount !== undefined && skippedCount > 0) {
    clauses.push(formatSkippedClause(skippedCount, skippedNames));
  }
  if (previousComments !== undefined && previousComments > 0) {
    clauses.push(
      `${formatNumber(previousComments)} previous ${pluralize(previousComments, 'comment')} included`
    );
  }

  let overview = header;
  if (clauses.length > 0) {
    overview += ` ${clauses.join(', ')}.`;
  }

  if (instructions) {
    const trimmed =
      instructions.length > MAX_INSTRUCTIONS_LENGTH
        ? `${instructions.slice(0, MAX_INSTRUCTIONS_LENGTH - 1).trimEnd()}…`
        : instructions;
    overview += ` Review focus: ${trimmed}`;
    if (!/[.!?…]$/.test(trimmed)) overview += '.';
  }

  return overview;
};

// Find a review payload either at the top level or nested under a wrapper key.
const findReviewPayload = (root: JsonObject): ReviewPayloadFields | null => {
  const direct = extractReviewFields(root);
  if (direct) return direct;

  for (const key of WRAPPER_KEYS) {
    const nested = root[key];
    if (isPlainObject(nested)) {
      const fields = extractReviewFields(nested);
      if (fields) return fields;
    }
  }

  return null;
};

/**
 * Attempt to render a PR review prompt payload as a concise, human-readable
 * overview.
 *
 * @param content The raw log content (typically JSON text).
 * @returns The overview string, or `null` when the content is not a recognized
 *          review payload (invalid JSON, unknown schema, or non-review data).
 */
export const formatReviewPromptOverview = (
  content: string | null | undefined
): string | null => {
  if (typeof content !== 'string') return null;

  const trimmed = content.trim();
  if (!trimmed.startsWith('{')) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (!isPlainObject(parsed)) return null;

  const fields = findReviewPayload(parsed);
  if (!fields) return null;

  return buildOverview(fields);
};
