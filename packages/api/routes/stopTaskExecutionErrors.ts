export class StopTaskExecutionError extends Error {
  status: number;
  body: Record<string, unknown>;

  constructor(status: number, body: Record<string, unknown>) {
    super(typeof body.message === 'string' ? body.message : typeof body.error === 'string' ? body.error : 'Task stop failed');
    this.name = 'StopTaskExecutionError';
    this.status = status;
    this.body = body;
  }
}

export function isStopTaskExecutionError(error: unknown): error is {
  status: number;
  body: Record<string, unknown>;
  message?: unknown;
} {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const candidate = error as Record<string, unknown>;
  return candidate.name === 'StopTaskExecutionError'
    && typeof candidate.status === 'number'
    && Number.isInteger(candidate.status)
    && candidate.status >= 400
    && candidate.status < 600
    && !!candidate.body
    && typeof candidate.body === 'object'
    && !Array.isArray(candidate.body);
}
