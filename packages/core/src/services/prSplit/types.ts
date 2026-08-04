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
   * Contents at the authoritative captured merge-base SHA and immutable head SHA.
   * Snapshot collection fails closed when GitHub cannot resolve the merge base.
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
  /** Merge base reported by GitHub's comparison API. Collector snapshots always set it. */
  mergeBaseSha: string;
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
  prompt: string;
  /** Aborted when the bounded judgement deadline expires. */
  signal: AbortSignal;
}

export interface SplitPlannerChoice {
  /** The model may explicitly decide that the source PR has no coherent file-level split. */
  canSplit: boolean;
  /** Model-authored description of the proposed review unit. Empty when canSplit is false. */
  selectedSummary: string;
  /** Exact source-PR paths selected by the model. Empty when canSplit is false. */
  includedFiles: string[];
  reason: string;
  riskNotes: string[];
}

export type SplitPlannerJudge = (
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
  /** A narrow dependency-injection seam for the LLM that authors the split scope. */
  judge?: SplitPlannerJudge;
  /** Existing Agent-compatible planner. `judge` takes precedence when both are supplied. */
  agent?: SplitPlannerAgent;
  /**
   * Optional shorter deadline for judgement; the service ceiling is configured by
   * PR_SPLIT_JUDGEMENT_TIMEOUT_MS and remains capped by a hard safety bound.
   */
  judgementTimeoutMs?: number;
}

export type SplitPlanningOutcome = 'selected' | 'no_split' | 'failed';

/** Immutable source coordinates required to reproduce the captured PR delta. */
export interface SplitPlanSourceDiff {
  targetRepository: string;
  headRepository: string;
  baseSha: string;
  headSha: string;
  mergeBaseSha: string;
}

/** The complete analysis result consumed by the later branch/publication layer. */
export interface SplitPlan {
  /** Distinguishes a valid model decision not to split from an operational/planner failure. */
  planningOutcome: SplitPlanningOutcome;
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
  /**
   * Publication must fetch exact Git objects at sourceDiff SHAs, including modes,
   * symlinks, and binary blobs; snapshot content strings are analysis evidence only.
   */
  preserveSourceDiff: true;
}
