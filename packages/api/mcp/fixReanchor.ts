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
 * Repository-relative path tokens as reviews cite them, e.g. `src/config.ts:10`,
 * `docker/entrypoint`, `.env` or `Dockerfile`. Over-matching prose (`and/or`) is
 * harmless: an unrecognised token is never "removed", so it only keeps a record
 * applied. Under-matching is what would wrongly withhold one.
 */
const CITED_PATH = new RegExp(String.raw`(?:^|[\s\`'"([])(` + [
  String.raw`(?:[\w.-]+\/)+[\w.-]*[\w-]`,
  String.raw`[\w.-]+\.[A-Za-z][A-Za-z0-9]*`,
  String.raw`\.[\w-](?:[\w.-]*[\w-])?`,
  String.raw`[\w.-]*(?:${EXTENSIONLESS_FILES})`,
].join('|') + String.raw`)(?=[:#\s\`'",;)\]]|\.(?:\s|$)|$)`, 'g');

export function citedPaths(text: string): string[] {
  return [...new Set([...text.replace(/\\/g, '/').matchAll(CITED_PATH)].map(match => match[1].replace(/^(?:\.\/)+/, '')))];
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
 * A record is withheld only when it cites files and every one of them was deleted
 * since the review: the code it describes is gone. A rename or edit is not enough,
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
  for (const { id, kind, text } of records) {
    const paths = citedPaths(text);
    const gone = paths.filter(path => removed.has(path));
    if (paths.length > 0 && gone.length === paths.length) report.skipped.push({ id, kind, reason: 'code_removed', removedPaths: gone });
    else report.applied.push({ id, kind, touchedPaths: paths.filter(path => removed.has(path) || touched.has(path)) });
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
