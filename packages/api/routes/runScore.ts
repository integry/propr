import { parseJsonObject, recapFrom, splitReviewRecap } from './dashboardOutcomeQueries.js';

/**
 * The score a completion recorded: the review recap's (`Score 8/10`), else the
 * ultrafix loop's review score. Null when the run was not scored.
 */
export function recordedRunScore(rawMetadata: unknown): number | null {
  const metadata = parseJsonObject(rawMetadata);
  const reviewScore = splitReviewRecap(recapFrom(metadata)).score;
  if (reviewScore !== null) return reviewScore;
  const ultrafixScore = Number(metadata.ultrafixScore);
  return metadata.ultrafixScore != null && Number.isFinite(ultrafixScore) ? ultrafixScore : null;
}

/**
 * What a completed review came to: `clean` when every reviewer succeeded and
 * none reported an actionable finding, `findings` when one did, and
 * `reviewer_failed` when a reviewer did not complete.
 */
export type RunReviewOutcome = 'clean' | 'findings' | 'reviewer_failed';

const ISSUES_FOUND = /\b(\d+) issues? found\b/;
const REVIEWER_FAILED = /\breviewers? failed\b/;

/**
 * The outcome a review completion recorded, read from the typed per-reviewer
 * results and the recap the review job writes (`Score 9/10 · 0 issues found`).
 * A clean outcome needs both: a recap that counts no issues, and a recorded
 * result for every reviewer saying it succeeded. Null when the completion is
 * not a review's or does not say enough, so a score alone never reads as clean.
 */
export function recordedReviewOutcome(rawMetadata: unknown): RunReviewOutcome | null {
  const metadata = parseJsonObject(rawMetadata);
  const recap = recapFrom(metadata);
  const results = Array.isArray(metadata.reviewResults) ? metadata.reviewResults as unknown[] : null;
  const failed = results?.some(result => parseJsonObject(result).success !== true) ?? false;
  if (failed || (recap !== null && REVIEWER_FAILED.test(recap))) return 'reviewer_failed';
  const issues = recap === null ? null : ISSUES_FOUND.exec(recap);
  if (!issues) return null;
  if (Number(issues[1]) > 0) return 'findings';
  return results && results.length > 0 ? 'clean' : null;
}
