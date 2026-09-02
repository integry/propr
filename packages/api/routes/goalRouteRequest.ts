import type { Request, Response } from 'express';
import { GoalError } from '@propr/core';
import { GOAL_ERROR_CODES, GOAL_IDEMPOTENCY_KEY_MAX_LENGTH } from '@propr/shared';

export function requireUserId(req: Request, res: Response): string | null {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ code: 'unauthenticated', error: 'User not authenticated' });
    return null;
  }
  return userId;
}

export function sendGoalError(res: Response, error: unknown): void {
  if (error instanceof GoalError) {
    res.status(error.status).json({ code: error.code, error: error.message });
    return;
  }
  console.error('Goal route failure:', error);
  res.status(500).json({ code: 'goal_internal_error', error: 'Internal server error' });
}

export function resolveIdempotencyKey(req: Request): string {
  const header = req.header('Idempotency-Key');
  const body = req.body as { idempotencyKey?: unknown } | undefined;
  const candidate = header !== undefined ? header : body?.idempotencyKey;
  if (typeof candidate === 'string') {
    const normalized = candidate.trim();
    if (normalized && Array.from(normalized).length <= GOAL_IDEMPOTENCY_KEY_MAX_LENGTH) {
      return normalized;
    }
  }
  throw new GoalError(
    GOAL_ERROR_CODES.invalidIdempotencyKey,
    `Idempotency-Key must contain between 1 and ${GOAL_IDEMPOTENCY_KEY_MAX_LENGTH} characters`,
    400
  );
}

export function boundedOptionalText(
  value: unknown,
  field: string,
  maxLength: number
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new GoalError(GOAL_ERROR_CODES.validation, `${field} must be a string`, 400);
  }
  const normalized = value.trim();
  if (!normalized || Array.from(normalized).length > maxLength) {
    throw new GoalError(
      GOAL_ERROR_CODES.validation,
      `${field} must contain between 1 and ${maxLength} characters`,
      400
    );
  }
  return normalized;
}

export function parseLimit(value: unknown, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new GoalError(GOAL_ERROR_CODES.validation, `limit must be an integer from 1 to ${max}`, 400);
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > max) {
    throw new GoalError(GOAL_ERROR_CODES.validation, `limit must be an integer from 1 to ${max}`, 400);
  }
  return limit;
}

export function parseExpectedVersion(req: Request): number | undefined {
  const body = req.body as { expectedVersion?: unknown } | undefined;
  const header = req.header('If-Match');
  const bodyVersion = body?.expectedVersion === undefined
    ? undefined : parseVersionNumber(body.expectedVersion, 'expectedVersion');
  const headerVersion = header === undefined ? undefined : parseIfMatchVersion(header);
  if (bodyVersion !== undefined && headerVersion !== undefined && bodyVersion !== headerVersion) {
    throw new GoalError(GOAL_ERROR_CODES.validation, 'expectedVersion and If-Match must agree', 400);
  }
  return headerVersion ?? bodyVersion;
}

function parseVersionNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new GoalError(GOAL_ERROR_CODES.validation, `${field} must be a positive safe integer`, 400);
  }
  return value;
}

function parseIfMatchVersion(value: string): number {
  const match = value.match(/^\s*(?:"([1-9]\d*)"|([1-9]\d*))\s*$/);
  if (!match) {
    throw new GoalError(GOAL_ERROR_CODES.validation, 'If-Match must contain one positive integer version', 400);
  }
  return parseVersionNumber(Number(match[1] ?? match[2]), 'If-Match');
}
