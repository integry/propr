import { GOAL_CURSOR_MAX_LENGTH, GOAL_ERROR_CODES } from '@propr/shared';
import { GoalError, characterLength } from './goalRepositorySupport.js';

interface Binding { goalId: string; ownerUserId: string; repository: string }
export interface ChecklistCursorValue { orderIndex: number; nodeId: string; createdAt: string }

function canonicalInstant(value: unknown): value is string {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && new Date(value).toISOString() === value;
}

function serialize(binding: Binding, value: ChecklistCursorValue): string {
  return JSON.stringify({
    v: 1, t: 'goal-checklist', g: binding.goalId, o: binding.ownerUserId,
    r: binding.repository, a: value.createdAt, i: value.orderIndex, n: value.nodeId,
  });
}

export function encodeChecklistCursor(binding: Binding, value: ChecklistCursorValue): string {
  if (!canonicalInstant(value.createdAt) || !Number.isSafeInteger(value.orderIndex)
    || value.orderIndex < 0 || !value.nodeId) throw invalid();
  return Buffer.from(serialize(binding, value), 'utf8').toString('base64url');
}

export function decodeChecklistCursor(cursor: string | null | undefined, binding: Binding): ChecklistCursorValue | null {
  if (cursor === null || cursor === undefined) return null;
  if (!cursor || characterLength(cursor) > GOAL_CURSOR_MAX_LENGTH || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalid();
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    if (Buffer.from(decoded, 'utf8').toString('base64url') !== cursor) throw invalid();
    const parsed = JSON.parse(decoded) as Record<string, unknown>;
    if (Object.keys(parsed).join(',') !== 'v,t,g,o,r,a,i,n'
      || parsed.v !== 1 || parsed.t !== 'goal-checklist' || parsed.g !== binding.goalId
      || parsed.o !== binding.ownerUserId || parsed.r !== binding.repository
      || !canonicalInstant(parsed.a) || !Number.isSafeInteger(parsed.i) || (parsed.i as number) < 0
      || typeof parsed.n !== 'string' || !parsed.n) throw invalid();
    const value = { createdAt: parsed.a, orderIndex: parsed.i as number, nodeId: parsed.n };
    if (serialize(binding, value) !== decoded) throw invalid();
    return value;
  } catch (error) {
    if (error instanceof GoalError) throw error;
    throw invalid();
  }
}

function invalid(): GoalError {
  return new GoalError(GOAL_ERROR_CODES.invalidCursor, 'Goal checklist cursor is invalid', 400);
}
