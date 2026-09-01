import { GOAL_CURSOR_MAX_LENGTH, GOAL_ERROR_CODES } from '@propr/shared';
import { GoalError, characterLength } from './goalRepositorySupport.js';

export interface GoalPageCursorBinding {
  type: 'goal-events' | 'goal-messages';
  goalId: string;
  ownerUserId: string;
  repository: string;
  filter: string | null;
}

export interface GoalPageCursorValue {
  sequence: number;
  createdAt: string;
}

function canonicalInstant(value: unknown): value is string {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && new Date(value).toISOString() === value;
}

function serialize(binding: GoalPageCursorBinding, value: GoalPageCursorValue): string {
  return JSON.stringify({
    v: 1,
    t: binding.type,
    g: binding.goalId,
    o: binding.ownerUserId,
    r: binding.repository,
    f: binding.filter,
    a: value.createdAt,
    s: value.sequence,
  });
}

export function encodeGoalPageCursor(
  binding: GoalPageCursorBinding,
  value: GoalPageCursorValue
): string {
  if (!canonicalInstant(value.createdAt) || !Number.isSafeInteger(value.sequence) || value.sequence < 0) {
    throw invalidCursor();
  }
  return Buffer.from(serialize(binding, value), 'utf8').toString('base64url');
}

export function decodeGoalPageCursor(
  cursor: string | null | undefined,
  binding: GoalPageCursorBinding
): GoalPageCursorValue | null {
  if (cursor === null || cursor === undefined) return null;
  if (!cursor || characterLength(cursor) > GOAL_CURSOR_MAX_LENGTH || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw invalidCursor();
  }
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    if (Buffer.from(decoded, 'utf8').toString('base64url') !== cursor) throw invalidCursor();
    const value = JSON.parse(decoded) as Record<string, unknown>;
    if (Object.keys(value).join(',') !== 'v,t,g,o,r,f,a,s'
      || value.v !== 1 || value.t !== binding.type || value.g !== binding.goalId
      || value.o !== binding.ownerUserId || value.r !== binding.repository
      || value.f !== binding.filter || !canonicalInstant(value.a)
      || !Number.isSafeInteger(value.s) || (value.s as number) < 0) throw invalidCursor();
    const result = { sequence: value.s as number, createdAt: value.a };
    if (serialize(binding, result) !== decoded) throw invalidCursor();
    return result;
  } catch (error) {
    if (error instanceof GoalError) throw error;
    throw invalidCursor();
  }
}

function invalidCursor(): GoalError {
  return new GoalError(GOAL_ERROR_CODES.invalidCursor, 'Goal cursor is invalid', 400);
}
