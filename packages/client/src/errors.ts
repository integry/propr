export type ProprClientErrorKind =
  | 'configuration'
  | 'authentication'
  | 'network'
  | 'timeout'
  | 'aborted'
  | 'http'
  | 'invalid_response'
  | 'compatibility';

/** The exact credential-free public discovery request was authentication-gated. */
export const DESKTOP_DISCOVERY_AUTHENTICATION_REQUIRED =
  'DESKTOP_DISCOVERY_AUTHENTICATION_REQUIRED' as const;

export interface ProprClientErrorOptions {
  kind: ProprClientErrorKind;
  status?: number;
  code?: string;
  body?: unknown;
  cause?: unknown;
}

/** A transport-safe error shape shared by browser, desktop, and CLI clients. */
export class ProprClientError extends Error {
  readonly kind: ProprClientErrorKind;
  readonly status?: number;
  readonly code?: string;
  readonly body?: unknown;
  readonly cause?: unknown;

  constructor(message: string, options: ProprClientErrorOptions) {
    super(message);
    this.name = 'ProprClientError';
    this.kind = options.kind;
    this.status = options.status;
    this.code = options.code;
    this.body = options.body;
    this.cause = options.cause;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      kind: this.kind,
      status: this.status,
      code: this.code,
    };
  }
}

export const isProprClientError = (error: unknown): error is ProprClientError =>
  error instanceof ProprClientError || (
    error instanceof Error
    && error.name === 'ProprClientError'
    && 'kind' in error
  );
