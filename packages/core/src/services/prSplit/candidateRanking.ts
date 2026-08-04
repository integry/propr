import { isTestSplitFile } from './candidateFileHeuristics.js';
import type { SplitCandidate, SplitCandidateKind } from './types.js';

export function scoreSplitCandidate(candidate: SplitCandidate): number {
  const kindScore: Record<SplitCandidateKind, number> = {
    instruction: 50,
    'atomic-commit': 40,
    'module-boundary': 35,
    'dependency-closed': 20,
  };
  const fileCount = candidate.includedFiles.length;
  const reviewableUnitScore = fileCount >= 2 && fileCount <= 10 ? 20 : fileCount === 1 ? 5 : 0;
  const changeSizeScore = candidate.changedLines <= 200
    ? 15
    : candidate.changedLines <= 500
      ? 5
      : candidate.changedLines <= 1_000
        ? -10
        : -30;
  const validationScore = candidate.validationPlan.inferred ? 10 : 0;
  const testScore = candidate.includedFiles.some(isTestSplitFile) ? 20 : 0;
  const focusScore = candidate.excludedScope.length > 0 ? 15 : 0;
  const riskPenalty = candidate.riskNotes.length * 8;
  const rejectionPenalty = candidate.rejected ? 1000 : 0;
  return 100 + kindScore[candidate.kind]
    + candidate.instructionMatchScore * 2
    + reviewableUnitScore + changeSizeScore + validationScore + testScore + focusScore
    - riskPenalty - rejectionPenalty;
}

export function buildCandidateRankingReasons(
  candidate: SplitCandidate,
  instruction: string,
): string[] {
  const reasons: string[] = [];
  if (instruction.trim() && candidate.instructionMatchScore > 0) {
    reasons.push(`Matches ${candidate.instructionMatchScore}% of the requested instruction terms.`);
  }
  if (candidate.kind === 'atomic-commit') reasons.push('Preserves an atomic source commit.');
  if (candidate.kind === 'module-boundary') reasons.push('Keeps a cohesive module boundary together.');
  if (candidate.kind === 'dependency-closed') reasons.push('Uses a small dependency-closed source scope.');
  if (candidate.includedFiles.some(isTestSplitFile)) {
    reasons.push('Includes changed tests with the selected scope.');
  }
  if (candidate.changedLines <= 500) {
    reasons.push(`Keeps the selected diff reviewable at ${candidate.changedLines} changed lines.`);
  } else if (candidate.changedLines > 1_000) {
    reasons.push(`Large selected diff: ${candidate.changedLines} changed lines.`);
  }
  if (!candidate.rejected) reasons.push('Passed deterministic scope-completeness checks.');
  return reasons;
}

/** Stable ordering: product score, then stronger source boundary, then candidate id. */
export function rankSplitCandidates(candidates: readonly SplitCandidate[]): SplitCandidate[] {
  const kindOrder: Record<SplitCandidateKind, number> = {
    instruction: 0,
    'atomic-commit': 1,
    'module-boundary': 2,
    'dependency-closed': 3,
  };
  return [...candidates].sort((left, right) =>
    Number(left.rejected) - Number(right.rejected)
    || right.score - left.score
    || kindOrder[left.kind] - kindOrder[right.kind]
    || left.id.localeCompare(right.id));
}
