import { createHash } from 'node:crypto';
import { normalizeSplitInstruction } from './command.js';

export interface SplitEventKeyInput {
  repositoryId: number;
  originalCommentId: number;
}

export interface SplitDedupeKeyInput {
  repositoryId: number;
  sourcePrNumber: number;
  baseRef: string;
  baseSha: string;
  headSha: string;
  instruction: string;
}

export function normalizePositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive safe integer`);
  }
  return value;
}

export function normalizeGitHubId(value: number, field: string): number {
  return normalizePositiveInteger(value, field);
}

function normalizeNonEmptyString(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new RangeError(`${field} must not be empty`);
  return normalized;
}

export function normalizeSha(sha: string): string {
  return normalizeNonEmptyString(sha, 'sha').toLowerCase();
}

export function normalizeRef(ref: string): string {
  return normalizeNonEmptyString(ref, 'ref');
}

function hashCanonicalInput(parts: readonly (string | number)[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/** Stable identity for one GitHub issue comment across webhook retries and repository renames. */
export function buildSplitOperationEventKey(input: SplitEventKeyInput): string {
  return hashCanonicalInput([
    normalizeGitHubId(input.repositoryId, 'repositoryId'),
    normalizeGitHubId(input.originalCommentId, 'originalCommentId'),
  ]);
}

/** Stable semantic key for equivalent split inputs, independent of event identity. */
export function buildSplitOperationDedupeKey(input: SplitDedupeKeyInput): string {
  return hashCanonicalInput([
    normalizeGitHubId(input.repositoryId, 'repositoryId'),
    normalizePositiveInteger(input.sourcePrNumber, 'sourcePrNumber'),
    normalizeRef(input.baseRef),
    normalizeSha(input.baseSha),
    normalizeSha(input.headSha),
    normalizeSplitInstruction(input.instruction),
  ]);
}
