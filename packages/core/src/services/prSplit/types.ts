import type { Agent } from '../../agents/types.js';

/** A repository containing the source pull request head. */
export interface PrSplitRepository {
  owner: string;
  name: string;
  fullName: string;
  cloneUrl: string | null;
  defaultBranch: string | null;
  private: boolean;
}

export type PrSnapshotFileStatus =
  | 'added'
  | 'modified'
  | 'removed'
  | 'renamed'
  | 'copied'
  | 'changed'
  | 'unchanged'
  | 'unknown';

/** A normalized changed file. Patch is GitHub's unified patch for this file when available. */
export interface PrSnapshotFile {
  filename: string;
  previousFilename: string | null;
  status: PrSnapshotFileStatus;
  additions: number;
  deletions: number;
  changes: number;
  patch: string | null;
  sha: string | null;
}

/** A normalized source-PR commit and the changed paths belonging to it. */
export interface PrSnapshotCommit {
  sha: string;
  message: string;
  title: string;
  authoredAt: string | null;
  committedAt: string | null;
  parents: string[];
  files: string[];
}

/** Immutable input used by split analysis. */
export interface PrSnapshot {
  owner: string;
  repo: string;
  pullNumber: number;
  baseRef: string;
  baseSha: string;
  headRef: string;
  headSha: string;
  sourceHeadRepository: PrSplitRepository | null;
  title: string;
  body: string;
  commits: PrSnapshotCommit[];
  changedFiles: PrSnapshotFile[];
  unifiedDiff: string;
}

export type PullRequestSnapshot = PrSnapshot;
export type PullRequestSnapshotFile = PrSnapshotFile;
export type PullRequestSnapshotCommit = PrSnapshotCommit;

export type ValidationHintSource =
  | 'workflow'
  | 'package-script'
  | 'language-convention'
  | 'repository-convention';

export interface ValidationHint {
  command: string;
  reason: string;
  source: ValidationHintSource;
  relatedFiles: string[];
}

/** Commands are hints for the later execution layer, not evidence that validation passed. */
export interface ValidationPlan {
  commands: string[];
  hints: ValidationHint[];
  inferred: boolean;
  explanation: string;
}

export type SplitCandidateKind =
  | 'instruction'
  | 'atomic-commit'
  | 'module-boundary'
  | 'dependency-closed';

/** A deterministic, source-diff-preserving split option. */
export interface SplitCandidate {
  id: string;
  kind: SplitCandidateKind;
  summary: string;
  includedFiles: string[];
  excludedScope: string[];
  commitShas: string[];
  dependencyFiles: string[];
  instructionMatchScore: number;
  score: number;
  rankingReasons: string[];
  riskNotes: string[];
  validationPlan: ValidationPlan;
  rejected: boolean;
  rejectionReasons: string[];
  safeToCreatePr: boolean;
}

export interface SplitCandidateSafetyAssessment {
  rejected: boolean;
  rejectionReasons: string[];
  riskNotes: string[];
  missingDependencyFiles: string[];
  safeToCreatePr: boolean;
}

export interface SplitPlannerJudgementInput {
  snapshot: PrSnapshot;
  instruction: string;
  candidates: readonly SplitCandidate[];
  prompt: string;
}

export interface SplitPlannerChoice {
  candidateId: string;
  reason?: string;
  /** If supplied by a model, this must exactly equal the candidate's files. */
  includedFiles?: string[];
}

export type SplitCandidateJudge = (
  input: SplitPlannerJudgementInput,
) => Promise<unknown>;

export type SplitPlannerAgent = Pick<Agent, 'analyze'>;

export interface SplitPlannerOptions {
  instruction?: string;
  /** A narrow dependency-injection seam for an LLM or another read-only judge. */
  judge?: SplitCandidateJudge;
  /** Existing Agent-compatible judgement. `judge` takes precedence when both are supplied. */
  agent?: SplitPlannerAgent;
}

/** The complete analysis result consumed by the later branch/publication layer. */
export interface SplitPlan {
  selectedCandidateId: string | null;
  selectedSummary: string;
  includedFiles: string[];
  excludedScope: string[];
  riskNotes: string[];
  validationPlan: ValidationPlan;
  safeToCreatePr: boolean;
  failureReason: string | null;
  selectionReason: string;
  /** Publication must apply these files from the source PR; no rewrite is planned. */
  preserveSourceDiff: true;
}
