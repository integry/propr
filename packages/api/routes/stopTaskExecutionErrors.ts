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
  return error instanceof StopTaskExecutionError;
}
