import type { AnalysisResult, AnalyzeOptions } from '../../agents/types.js';

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
  /** True only when applying the patch to baseContent exactly reconstructs headContent. */
  patchComplete: boolean;
  sha: string | null;
  /**
   * Contents at the captured merge-base SHA (falling back to baseSha only when
   * GitHub cannot report a merge base) and immutable head SHA.
   */
  baseContent: string | null;
  headContent: string | null;
  /** False when either required side could not be read in full. */
  contentComplete: boolean;
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
  /** True only after every page of the commit-detail file list was read. */
  filesComplete: boolean;
}

/** A repository configuration file discovered at the immutable PR head. */
export interface PrSnapshotRepositoryFile {
  path: string;
  content: string | null;
  contentComplete: boolean;
}

/** Immutable input used by split analysis. */
export interface PrSnapshot {
  owner: string;
  repo: string;
  pullNumber: number;
  baseRef: string;
  baseSha: string;
  /** Merge base reported by GitHub's comparison API, when it could be resolved. */
  mergeBaseSha: string | null;
  headRef: string;
  headSha: string;
  sourceHeadRepository: PrSplitRepository | null;
  title: string;
  body: string;
  commits: PrSnapshotCommit[];
  changedFiles: PrSnapshotFile[];
  repositoryFiles: PrSnapshotRepositoryFile[];
  repositoryTreeComplete: boolean;
  unifiedDiff: string;
  /** False because GitHub's PR diff response does not guarantee complete hunks. */
  unifiedDiffComplete: boolean;
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
  workingDirectory: string;
  confidence: 'high' | 'medium' | 'low';
  /** Only constructed, allowlisted commands may enter ValidationPlan.commands. */
  executable: boolean;
}

export interface ValidationCommand {
  command: string;
  workingDirectory: string;
  /** PR code and its configuration are untrusted, so execution always requires isolation. */
  requiresSandbox: true;
}

/** Commands are untrusted execution requests, not evidence that validation passed or security approval. */
export interface ValidationPlan {
  commands: ValidationCommand[];
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
  changedLines: number;
  score: number;
  rankingReasons: string[];
  riskNotes: string[];
  validationPlan: ValidationPlan;
  rejected: boolean;
  rejectionReasons: string[];
  /** Scope-level deterministic checks passed; this is not a guarantee that the diff is secret-free. */
  safeToCreatePr: boolean;
}

export interface SplitCandidateSafetyAssessment {
  rejected: boolean;
  rejectionReasons: string[];
  riskNotes: string[];
  missingDependencyFiles: string[];
  safeToCreatePr: boolean;
}

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export interface SplitPlannerJudgementInput {
  snapshot: DeepReadonly<PrSnapshot>;
  instruction: string;
  candidates: readonly DeepReadonly<SplitCandidate>[];
  prompt: string;
  /** Aborted when the bounded judgement deadline expires. */
  signal: AbortSignal;
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

/** Agent seam that must propagate planner cancellation to its underlying request. */
export interface SplitPlannerAgent {
  analyze(
    prompt: string,
    options: AnalyzeOptions & { signal: AbortSignal },
  ): Promise<AnalysisResult>;
}

export interface SplitPlannerOptions {
  instruction?: string;
  /** A narrow dependency-injection seam for an LLM or another read-only judge. */
  judge?: SplitCandidateJudge;
  /** Existing Agent-compatible judgement. `judge` takes precedence when both are supplied. */
  agent?: SplitPlannerAgent;
  /** Optional shorter deadline for judgement; the service maximum still applies. */
  judgementTimeoutMs?: number;
}

/** Immutable source coordinates required to reproduce the captured PR delta. */
export interface SplitPlanSourceDiff {
  targetRepository: string;
  headRepository: string;
  baseSha: string;
  headSha: string;
  mergeBaseSha: string | null;
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
  /** Publication must use these immutable coordinates, not moving branch refs. */
  sourceDiff: SplitPlanSourceDiff;
  /** Publication must reconstruct selected file deltas at sourceDiff SHAs; no rewrite is planned. */
  preserveSourceDiff: true;
}
