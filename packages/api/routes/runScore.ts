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
