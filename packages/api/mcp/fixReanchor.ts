import type { ReviewFeedbackSelection } from '@propr/shared';
import type { McpPrincipal } from './policy.js';

/** One selected review record, with all of its prose: every field may cite a file. */
export interface FixRecord { id: string; kind: 'finding' | 'suggestion'; text: string }

/** A record still sent to `/fix`; `touchedPaths` are cited files that changed since the review. */
export interface AppliedFixRecord { id: string; kind: 'finding' | 'suggestion'; touchedPaths: string[] }

/** A record withheld because every file it cites was deleted after the review. */
export interface SkippedFixRecord { id: string; kind: 'finding' | 'suggestion'; reason: 'code_removed'; removedPaths: string[] }

export interface FixReanchorReport {
  /** Head the review was produced for; null for a legacy review without the marker. */
  reviewedHead: string | null;
  /** Head the posted `/fix` runs against. */
  resolvedHead: string;
  /** True when the review was for an older head and the fix was moved onto `resolvedHead`. */
  reanchored: boolean;
  /**
   * How applicability was decided: `same_head` needs no check, `compared` read the
   * commits since the review, and `unavailable` means that comparison could not be
   * read, so every record was sent on exactly as a hand-typed `/fix` would be.
   */
  comparison: 'same_head' | 'compared' | 'unavailable';
  applied: AppliedFixRecord[];
  skipped: SkippedFixRecord[];
}

interface ComparedFile { filename: string; status: string; previous_filename?: string }

/** Conventional repository files that carry no extension, e.g. `Dockerfile`. */
const EXTENSIONLESS_FILES = 'Dockerfile|Containerfile|Makefile|GNUmakefile|Procfile|Gemfile|Rakefile|Jenkinsfile|Vagrantfile|Brewfile|Justfile|Caddyfile|Pipfile|Podfile|Fastfile|Earthfile|Tiltfile|LICENSE|LICENCE|NOTICE|CODEOWNERS|OWNERS|AUTHORS|VERSION';

/**
 * One unit of a path segment: an ordinary character, or a bracketed or
 * parenthesised group as framework routes name directories and files, e.g.
 * `[slug]`, `[[...rest]]`, `(marketing)`, `@modal` or `+page.svelte`.
 */
const SEGMENT_UNIT = String.raw`(?:[\w.@+$~-]|\[\[?[\w.-]+\]\]?|\([\w.-]+\))`;
/** The same, minus a bare `.`, so a sentence's closing full stop is not taken as part of a path. */
const SEGMENT_END = String.raw`(?:[\w@+$~-]|\[\[?[\w.-]+\]\]?|\([\w.-]+\))`;

/**
 * Repository-relative path tokens as reviews cite them, e.g. `src/config.ts:10`,
 * `src/app/[slug]/page.tsx`, `docker/entrypoint`, `.env` or `Dockerfile`,
 * including inside Markdown emphasis such as `**Dockerfile**`.
 * Over-matching prose (`and/or`) is harmless: an unrecognised token is never
 * "removed", so it only keeps a record applied. Under-matching is what would
 * wrongly withhold one, so `hasUnparsedPath` backs this up.
 */
const CITED_PATH = new RegExp(String.raw`(?:^|[\s\`'"([*])(` + [
  String.raw`(?:${SEGMENT_UNIT}+\/)+${SEGMENT_UNIT}*${SEGMENT_END}`,
  String.raw`${SEGMENT_UNIT}+\.[A-Za-z][A-Za-z0-9]*`,
  String.raw`\.[\w-](?:[\w.-]*[\w-])?`,
  String.raw`[\w.-]*(?:${EXTENSIONLESS_FILES})`,
].join('|') + String.raw`)(?=[:#\s\`'",;)\]*]|\.(?:\s|$)|$)`, 'g');

export function citedPaths(text: string): string[] {
  return [...new Set([...text.replace(/\\/g, '/').matchAll(CITED_PATH)].map(match => match[1].replace(/^(?:\.\/)+/, '')))];
}

/**
 * A backticked or Markdown-emphasised span holding one bare name, e.g. `gradlew`,
 * **gradlew**, _configure_, `gradlew:12` or `配置`: it may name a root-level file no
 * extraction rule recognises.
 */
const MARKED_NAME = /(`|(?<![\p{L}\p{N}_*])\*{1,3}|(?<![\p{L}\p{N}_*])_{1,3})(?:\.\/)*([\p{L}\p{M}\p{N}_.@+~-]+?)(?::\d+(?:-\d+)?)?\1(?![\p{L}\p{N}_*])/gu;

/** Code identifiers in lowerCamelCase (`citedPaths`) and spans without a letter (`409`) are not file names. */
function isBareFileName(name: string): boolean {
  return /\p{L}/u.test(name) && !/^[a-z][a-z0-9]*[A-Z]\w*$/.test(name);
}

/**
 * True when `text` may cite a file the extracted `paths` do not account for:
 * a slash-separated token with an unread remainder, or a backticked or
 * emphasised bare name such as `gradlew` that is not itself an extracted path. A record is only
 * withheld on positive evidence that all its code is gone, so such a record
 * must be kept rather than judged on the citations that did parse.
 */
export function hasUnparsedPath(text: string, paths: string[]): boolean {
  const normalized = text.replace(/\\/g, '/');
  const known = new Set(paths);
  for (const [, , name] of normalized.matchAll(MARKED_NAME)) {
    if (!known.has(name) && isBareFileName(name)) return true;
  }
  const longestFirst = [...paths].sort((a, b) => b.length - a.length);
  return normalized.split(/[\s`'"]+/).some(token => {
    if (!token.includes('/')) return false;
    let residue = token.replace(/(^|[([])(?:\.\/)+/g, '$1');
    for (const path of longestFirst) residue = residue.split(path).join('');
    return residue.includes('/');
  });
}

/** A character that continues a file name, in any script; a lone `.` is handled separately. */
const NAME_CHAR = /[\p{L}\p{M}\p{N}_@+~$-]/u;

/**
 * True when `text`, once the extracted `paths` are taken out, names an entry of
 * `present` as a complete citation, e.g. `gradlew` in "legacy/bootstrap.sh and
 * gradlew run unverified code", `build wrapper` or `配置`. Each tree entry is
 * looked up whole, so a name with spaces or non-ASCII letters counts just like
 * an ASCII word; a trailing full stop ends a name rather than continuing it.
 */
function citesPresentFile(text: string, paths: string[], present: Set<string>): boolean {
  let residue = text.replace(/\\/g, '/');
  for (const path of [...paths].sort((a, b) => b.length - a.length)) residue = residue.split(path).join(' ');
  const continues = (index: number) => NAME_CHAR.test(residue[index] ?? '');
  const isWhole = (start: number, end: number) =>
    !continues(start - 1) && residue[start - 1] !== '.'
    && !continues(end) && !(residue[end] === '.' && (continues(end + 1) || residue[end + 1] === '.'));
  for (const name of present) {
    for (let at = residue.indexOf(name); at !== -1; at = residue.indexOf(name, at + 1)) {
      if (isWhole(at, at + name.length)) return true;
    }
  }
  return false;
}

/** Paths and file names of everything at `ref`, or null when the tree cannot be read in full. */
async function filesAt(principal: McpPrincipal, repository: string, ref: string): Promise<Set<string> | null> {
  const [owner, repo] = repository.split('/');
  try {
    const { data } = await principal.github.request('GET /repos/{owner}/{repo}/git/trees/{tree_sha}', { owner, repo, tree_sha: ref, recursive: '1' });
    if (!Array.isArray(data?.tree) || data.truncated) return null;
    const names = new Set<string>();
    for (const entry of data.tree as Array<{ path: string; type: string }>) {
      if (entry.type === 'tree') continue;
      names.add(entry.path);
      names.add(entry.path.slice(entry.path.lastIndexOf('/') + 1));
    }
    return names;
  } catch {
    return null;
  }
}

async function changedSince(principal: McpPrincipal, repository: string, from: string, to: string): Promise<ComparedFile[] | null> {
  const [owner, repo] = repository.split('/');
  try {
    const { data } = await principal.github.request('GET /repos/{owner}/{repo}/compare/{basehead}', { owner, repo, basehead: `${from}...${to}` });
    return Array.isArray(data?.files) ? data.files as ComparedFile[] : null;
  } catch {
    // A force-push can make the reviewed commit unreachable. The `/fix` command
    // runs regardless, so an unreadable comparison must not block it either.
    return null;
  }
}

/**
 * Decide which selected records still apply at the current head, as the worker's
 * `/fix` already does implicitly by fixing against whatever the branch holds.
 *
 * A record is withheld only when it cites files, every one of them was deleted
 * since the review, no path-like, backticked or emphasised file-name citation in
 * it went unrecognised, and none of its remaining text names a file still present
 * at the current head, matched whole so names with spaces or non-ASCII letters
 * count: the code it describes is gone. When that tree cannot be read
 * in full, applicability is uncertain and the record is applied. A rename or edit is not enough,
 * because the fixing agent reads the current tree and can follow moved code; such
 * records are applied and their changed citations reported in `touchedPaths`.
 */
export async function reanchorFixRecords(
  principal: McpPrincipal,
  target: { repository: string; reviewedHead: string | null; head: string },
  records: FixRecord[],
): Promise<FixReanchorReport> {
  const base = { reviewedHead: target.reviewedHead, resolvedHead: target.head };
  const applyAll = (comparison: FixReanchorReport['comparison']): FixReanchorReport => ({
    ...base, reanchored: comparison !== 'same_head', comparison,
    applied: records.map(({ id, kind }) => ({ id, kind, touchedPaths: [] })), skipped: [],
  });
  if (target.reviewedHead === null || target.reviewedHead === target.head) return applyAll('same_head');
  const files = await changedSince(principal, target.repository, target.reviewedHead, target.head);
  if (!files) return applyAll('unavailable');

  const removed = new Set<string>();
  const touched = new Set<string>();
  for (const file of files) {
    if (file.status === 'removed') removed.add(file.filename);
    else touched.add(file.filename);
    if (file.previous_filename) touched.add(file.previous_filename);
  }
  const report: FixReanchorReport = { ...base, reanchored: true, comparison: 'compared', applied: [], skipped: [] };
  const cited = records.map(record => ({ ...record, paths: citedPaths(record.text) }));
  const allRemoved = ({ text, paths }: { text: string; paths: string[] }) =>
    paths.length > 0 && paths.every(path => removed.has(path)) && !hasUnparsedPath(text, paths);
  // Only a record about to be withheld needs the current tree, so it is read lazily.
  const present = cited.some(allRemoved) ? await filesAt(principal, target.repository, target.head) : null;
  for (const record of cited) {
    const { id, kind, text, paths } = record;
    if (allRemoved(record) && present && !citesPresentFile(text, paths, present)) {
      report.skipped.push({ id, kind, reason: 'code_removed', removedPaths: paths });
    } else report.applied.push({ id, kind, touchedPaths: paths.filter(path => removed.has(path) || touched.has(path)) });
  }
  return report;
}

/** The selection `/fix` is posted with: only the records that still apply. */
export function appliedSelection(report: FixReanchorReport): ReviewFeedbackSelection {
  return {
    findingIds: report.applied.filter(record => record.kind === 'finding').map(record => record.id),
    suggestionIds: report.applied.filter(record => record.kind === 'suggestion').map(record => record.id),
  };
}
