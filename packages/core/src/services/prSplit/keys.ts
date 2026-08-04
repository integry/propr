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

export function normalizeGitHubId(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive safe integer`);
  }
  return value;
}

export function normalizeSha(sha: string): string {
  return sha.trim().toLowerCase();
}

export function normalizeRef(ref: string): string {
  return ref.trim();
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
    input.sourcePrNumber,
    normalizeRef(input.baseRef),
    normalizeSha(input.baseSha),
    normalizeSha(input.headSha),
    normalizeSplitInstruction(input.instruction),
  ]);
}
