import { buildSplitCandidates } from './candidatePlanner.js';
import type {
  PrSnapshot,
  SplitCandidate,
  SplitPlan,
  SplitPlannerChoice,
  SplitPlannerJudgementInput,
  SplitPlannerOptions,
  ValidationPlan,
} from './types.js';

type UnknownRecord = Record<string, unknown>;

export class SplitPlannerResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SplitPlannerResponseError';
  }
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strictJsonValue(value: string): unknown {
  const trimmed = value.trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const json = fence ? fence[1] : trimmed;
  try {
    return JSON.parse(json);
  } catch (error) {
    throw new SplitPlannerResponseError(`response is not valid JSON: ${(error as Error).message}`);
  }
}

function sameFiles(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((file, index) => file === sortedRight[index]);
}

function validatedCandidateId(parsed: UnknownRecord): string {
  const candidateIdValue = parsed.candidateId ?? parsed.selectedCandidateId;
  if (typeof candidateIdValue !== 'string' || !candidateIdValue.trim()) {
    throw new SplitPlannerResponseError('response must include a non-empty candidateId');
  }
  if (
    typeof parsed.candidateId === 'string'
    && typeof parsed.selectedCandidateId === 'string'
    && parsed.candidateId !== parsed.selectedCandidateId
  ) {
    throw new SplitPlannerResponseError('candidateId and selectedCandidateId disagree');
  }
  return candidateIdValue.trim();
}

function validatedIncludedFiles(
  value: unknown,
  candidate: SplitCandidate,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every(file => typeof file === 'string')) {
    throw new SplitPlannerResponseError('includedFiles must be an array of file paths');
  }
  const includedFiles = value as string[];
  if (!sameFiles(includedFiles, candidate.includedFiles)) {
    throw new SplitPlannerResponseError(
      'includedFiles invents files or omits files from the selected deterministic candidate',
    );
  }
  return includedFiles;
}

/** Strictly validate model output and resolve it to an existing deterministic candidate. */
export function parseSplitPlannerChoice(
  response: unknown,
  candidates: readonly SplitCandidate[],
): { choice: SplitPlannerChoice; candidate: SplitCandidate } {
  const parsed = typeof response === 'string' ? strictJsonValue(response) : response;
  if (!isRecord(parsed)) {
    throw new SplitPlannerResponseError('response must be a JSON object');
  }
  const supportedFields = new Set(['candidateId', 'selectedCandidateId', 'reason', 'includedFiles']);
  const unknownFields = Object.keys(parsed).filter(field => !supportedFields.has(field));
  if (unknownFields.length > 0) {
    throw new SplitPlannerResponseError(`response contains unsupported fields: ${unknownFields.join(', ')}`);
  }
  const candidateId = validatedCandidateId(parsed);
  const candidate = candidates.find(item => item.id === candidateId);
  if (!candidate) {
    throw new SplitPlannerResponseError(`response selected unknown candidate ${candidateId}`);
  }
  if (candidate.rejected || !candidate.safeToCreatePr) {
    throw new SplitPlannerResponseError(`response selected unsafe candidate ${candidate.id}`);
  }

  const includedFiles = validatedIncludedFiles(parsed.includedFiles, candidate);
  if (parsed.reason !== undefined && typeof parsed.reason !== 'string') {
    throw new SplitPlannerResponseError('reason must be a string');
  }
  const reason = typeof parsed.reason === 'string' ? parsed.reason.trim() : undefined;
  return {
    choice: {
      candidateId: candidate.id,
      ...(reason ? { reason } : {}),
      ...(includedFiles ? { includedFiles } : {}),
    },
    candidate,
  };
}

function plannerPrompt(
  snapshot: PrSnapshot,
  instruction: string,
  candidates: readonly SplitCandidate[],
): string {
  const options = candidates.map(candidate => ({
    candidateId: candidate.id,
    kind: candidate.kind,
    summary: candidate.summary,
    includedFiles: candidate.includedFiles,
    excludedScope: candidate.excludedScope,
    riskNotes: candidate.riskNotes,
    validationCommands: candidate.validationPlan.commands,
    deterministicScore: candidate.score,
    instructionMatchScore: candidate.instructionMatchScore,
  }));
  return `Choose the strongest independently reviewable split from the deterministic candidates below.

The split must preserve the source PR diff against base ${snapshot.baseRef} (${snapshot.baseSha}).
Do not propose code rewrites and do not add, remove, or invent files. Prefer the user's instruction when supplied, then atomicity, cohesion, dependency completeness, test coverage, and reviewability. A useful coherent unit is better than the smallest file count.

Requested instruction: ${instruction || '(none)'}
Source PR: ${snapshot.title}

Candidates:
${JSON.stringify(options, null, 2)}

Return only strict JSON in this form:
{"candidateId":"one candidateId above","reason":"brief reason"}`;
}

function failedValidationPlan(reason: string): ValidationPlan {
  return {
    commands: [],
    hints: [],
    inferred: false,
    explanation: reason,
  };
}

function failedPlan(snapshot: PrSnapshot, reason: string): SplitPlan {
  return {
    selectedCandidateId: null,
    selectedSummary: 'No safe split candidate was selected.',
    includedFiles: [],
    excludedScope: snapshot.changedFiles.map(file => file.filename).sort(),
    riskNotes: [reason],
    validationPlan: failedValidationPlan('Validation is not planned because no safe split candidate was selected.'),
    safeToCreatePr: false,
    failureReason: reason,
    selectionReason: 'Split planning failed closed.',
    preserveSourceDiff: true,
  };
}

function selectedPlan(candidate: SplitCandidate, selectionReason: string): SplitPlan {
  return {
    selectedCandidateId: candidate.id,
    selectedSummary: candidate.summary,
    includedFiles: [...candidate.includedFiles],
    excludedScope: [...candidate.excludedScope],
    riskNotes: [...candidate.riskNotes],
    validationPlan: candidate.validationPlan,
    safeToCreatePr: candidate.safeToCreatePr,
    failureReason: null,
    selectionReason,
    preserveSourceDiff: true,
  };
}

async function requestJudgement(
  input: SplitPlannerJudgementInput,
  options: SplitPlannerOptions,
): Promise<unknown> {
  if (options.judge) return options.judge(input);
  if (!options.agent) return undefined;
  const result = await options.agent.analyze(input.prompt, {
    executionType: 'pr-split-analysis',
    responseFormat: 'json',
    repository: `${input.snapshot.owner}/${input.snapshot.repo}`,
    prNumber: input.snapshot.pullNumber,
    metadata: { callType: 'pr_split_candidate_selection' },
  });
  if (!result.success) {
    throw new SplitPlannerResponseError(result.error || 'agent judgement failed');
  }
  return result.response;
}

/**
 * Plan a focused PR. Deterministic ranking works alone; when a judge is supplied,
 * invalid judgement fails closed rather than silently publishing the top candidate.
 */
export async function createSplitPlan(
  snapshot: PrSnapshot,
  optionsOrInstruction: SplitPlannerOptions | string = {},
): Promise<SplitPlan> {
  const options = typeof optionsOrInstruction === 'string'
    ? { instruction: optionsOrInstruction }
    : optionsOrInstruction;
  const instruction = options.instruction?.trim() ?? '';
  const candidates = buildSplitCandidates(snapshot, instruction);
  const safeCandidates = candidates.filter(candidate => candidate.safeToCreatePr && !candidate.rejected);
  if (safeCandidates.length === 0) {
    const firstReason = candidates.flatMap(candidate => candidate.rejectionReasons)[0];
    return failedPlan(
      snapshot,
      firstReason ? `No safe split candidate: ${firstReason}` : 'No split candidates could be constructed.',
    );
  }

  if (!options.judge && !options.agent) {
    return selectedPlan(safeCandidates[0], 'Selected by deterministic candidate ranking.');
  }
  const prompt = plannerPrompt(snapshot, instruction, safeCandidates);
  try {
    const response = await requestJudgement({ snapshot, instruction, candidates: safeCandidates, prompt }, options);
    const { choice, candidate } = parseSplitPlannerChoice(response, safeCandidates);
    return selectedPlan(
      candidate,
      choice.reason || 'Selected by optional planner judgement from deterministic candidates.',
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failedPlan(snapshot, `Planner judgement failed closed: ${message}`);
  }
}

export const planSplit = createSplitPlan;
export const planPrSplit = createSplitPlan;
