import { logger } from '@propr/core';
import { classifyError } from './errorEnvelope.js';

/**
 * A tool failure the caller only sees as INTERNAL_ERROR (or an uncertain
 * outcome caused by one) carries no detail in its envelope, by design. The
 * underlying error is logged here with its stack and the operation, so an
 * operator can find out what happened.
 */
export function logInternalToolFailure(error: unknown, context: { tool: string; operationId?: string; repository?: string }): void {
  const envelope = classifyError(error, { sideEffectsPossible: false });
  if (envelope.status < 500) return;
  const err = error instanceof Error ? error : new Error(String(error));
  logger.error({
    tool: context.tool,
    operationId: context.operationId ?? null,
    repository: context.repository ?? null,
    errorCode: envelope.code,
    errName: err.name,
    errMessage: err.message,
    stack: err.stack,
  }, 'MCP tool failed internally');
}
