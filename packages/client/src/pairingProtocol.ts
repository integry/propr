import { ProprClientError } from './errors.js';

const CONNECT_HEADER_TIMEOUT_MS = 8_000;
const BODY_TIMEOUT_MS = 8_000;
const OVERALL_TIMEOUT_MS = CONNECT_HEADER_TIMEOUT_MS + BODY_TIMEOUT_MS;
const CANCELLATION_TIMEOUT_MS = 100;
const MAX_RESPONSE_BYTES = 4_096;
const CANCELLATION_TIMEOUT_DIAGNOSTIC = 'ProPR pairing response cancellation exceeded its fixed deadline.';

type TimeoutPhase = 'connect-header' | 'body' | 'overall';
type ContentEncoding = 'identity' | 'gzip' | 'br';

export interface PairingProtocolRequestOptions {
  overallTimeoutMs?: number;
  /** @internal Deterministic protocol-test deadlines may only shorten production limits. */
  deadlines?: Partial<{
    headerMs: number;
    bodyMs: number;
    cancellationMs: number;
  }>;
  /** @internal Receives only a fixed, redacted cancellation diagnostic. */
  reportDiagnostic?: (message: string) => void;
  /** @internal Deterministic monotonic timer source for protocol tests. */
  clock?: {
    now(): number;
    setTimeout(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout>;
    clearTimeout(timer: ReturnType<typeof setTimeout>): void;
  };
}

const timeoutError = (cause?: unknown): ProprClientError =>
  new ProprClientError('The ProPR desktop pairing request timed out.', { kind: 'timeout', cause });

const cancelledError = (cause?: unknown): ProprClientError =>
  new ProprClientError('Desktop pairing was cancelled.', { kind: 'aborted', cause });

const invalidResponse = (status?: number, cause?: unknown): ProprClientError =>
  new ProprClientError('The ProPR desktop pairing service returned an invalid response.', {
    kind: 'invalid_response',
    status,
    cause,
  });

const networkError = (cause?: unknown): ProprClientError =>
  new ProprClientError('The ProPR desktop pairing service could not be reached.', {
    kind: 'network',
    cause,
  });

const errorCode = (value: unknown): string | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some(key => !['code', 'error'].includes(key))
    || typeof body.code !== 'string'
    || !/^[A-Z][A-Z0-9_]{0,63}$/.test(body.code)
    || typeof body.error !== 'string'
    || body.error.length < 1
    || body.error.length > 256) return undefined;
  return body.code;
};

const positiveTimeout = (value: number | undefined): number => {
  const timeout = value ?? OVERALL_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > OVERALL_TIMEOUT_MS) {
    throw new ProprClientError('Desktop pairing request deadlines are invalid.', {
      kind: 'configuration',
    });
  }
  return timeout;
};

const boundedDeadline = (value: number | undefined, maximum: number): number => {
  const deadline = value ?? maximum;
  if (!Number.isSafeInteger(deadline) || deadline < 1 || deadline > maximum) {
    throw new ProprClientError('Desktop pairing request deadlines are invalid.', {
      kind: 'configuration',
    });
  }
  return deadline;
};

const contentLength = (response: Response): number | undefined => {
  const raw = response.headers.get('content-length');
  if (raw === null) return undefined;
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) throw invalidResponse(response.status);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw invalidResponse(response.status);
  return value;
};

const contentEncoding = (response: Response): ContentEncoding => {
  const raw = response.headers.get('content-encoding');
  if (raw === null) return 'identity';
  const encoding = raw.trim().toLowerCase();
  if (encoding !== 'identity' && encoding !== 'gzip' && encoding !== 'br') {
    // A comma also makes duplicate and stacked encodings fail closed. Fetch
    // exposes transparently decoded bytes, so only one known wire encoding can
    // be related safely to the remaining response metadata.
    throw invalidResponse(response.status);
  }
  return encoding;
};

/**
 * Reads one pairing response under a single cancellation owner. The caller's
 * signal and all timers remain installed until the response stream is complete
 * or has been cancelled, so receiving headers never releases the operation.
 */
export const requestPairingProtocol = async (
  fetchImplementation: typeof globalThis.fetch,
  target: RequestInfo | URL,
  init: RequestInit,
  options: PairingProtocolRequestOptions = {},
): Promise<unknown> => {
  const callerSignal = init.signal;
  const overallTimeoutMs = positiveTimeout(options.overallTimeoutMs);
  const headerTimeoutMs = boundedDeadline(options.deadlines?.headerMs, CONNECT_HEADER_TIMEOUT_MS);
  const bodyTimeoutMs = boundedDeadline(options.deadlines?.bodyMs, BODY_TIMEOUT_MS);
  const cancellationTimeoutMs = boundedDeadline(
    options.deadlines?.cancellationMs,
    CANCELLATION_TIMEOUT_MS,
  );
  const reportDiagnostic = options.reportDiagnostic ?? ((message: string) => console.warn(message));
  const clock = options.clock ?? {
    now: () => performance.now(),
    setTimeout: (callback: () => void, milliseconds: number) => setTimeout(callback, milliseconds),
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
  };
  const reportCancellationTimeout = (): void => {
    try {
      reportDiagnostic(CANCELLATION_TIMEOUT_DIAGNOSTIC);
    } catch {
      // A diagnostic hook must never change transport or shutdown settlement.
    }
  };
  const controller = new AbortController();
  const startedAt = clock.now();
  let timeoutPhase: TimeoutPhase | undefined;
  let headerTimer: ReturnType<typeof setTimeout> | undefined;
  let bodyTimer: ReturnType<typeof setTimeout> | undefined;
  let overallTimer: ReturnType<typeof setTimeout> | undefined;
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  const abortForCaller = (): void => controller.abort(callerSignal?.reason);
  const abortForTimeout = (phase: TimeoutPhase): void => {
    if (controller.signal.aborted) return;
    timeoutPhase = phase;
    controller.abort(new DOMException('Desktop pairing deadline exceeded', 'TimeoutError'));
  };
  const raceCancellation = <T>(operation: PromiseLike<T>): Promise<T> => new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      controller.signal.removeEventListener('abort', aborted);
      callback();
    };
    const aborted = () => finish(() => reject(
      controller.signal.reason ?? new DOMException('Aborted', 'AbortError'),
    ));
    if (controller.signal.aborted) aborted();
    else controller.signal.addEventListener('abort', aborted, { once: true });
    // Both handlers remain attached to the foreign promise after our abort
    // wins. A later resolve/reject is deliberately consumed and cannot alter
    // endpoint state or become an unhandled rejection.
    Promise.resolve(operation).then(
      value => finish(() => resolve(value)),
      error => finish(() => reject(error)),
    );
  });
  const remainingOverall = (): number => Math.max(
    0,
    overallTimeoutMs - (clock.now() - startedAt),
  );
  const cancelResponse = async (): Promise<void> => {
    const cancelTarget = reader ?? response?.body;
    if (!cancelTarget) return;
    let cancellation: Promise<unknown>;
    try {
      cancellation = Promise.resolve(cancelTarget.cancel());
    } catch {
      return;
    }
    // Attach a rejection handler before doing anything else. The underlying
    // stream controls this promise and may reject long after local shutdown.
    let cancellationSettled = false;
    const settled = cancellation.then(
      () => { cancellationSettled = true; return true; },
      () => { cancellationSettled = true; return true; },
    );
    const budget = Math.min(cancellationTimeoutMs, remainingOverall());
    if (budget <= 0) {
      // Give an already-settled cancellation its queued promise reaction, but
      // never install or await a foreign task beyond the overall boundary.
      await Promise.resolve();
      if (!cancellationSettled) reportCancellationTimeout();
      return;
    }
    let cancellationTimer: ReturnType<typeof setTimeout> | undefined;
    const cancelledInBudget = await Promise.race([
      settled,
      new Promise<false>(resolve => {
        cancellationTimer = clock.setTimeout(() => resolve(false), budget);
      }),
    ]);
    if (cancellationTimer) clock.clearTimeout(cancellationTimer);
    if (!cancelledInBudget) reportCancellationTimeout();
  };

  if (callerSignal?.aborted) abortForCaller();
  else callerSignal?.addEventListener('abort', abortForCaller, { once: true });
  if (!controller.signal.aborted) {
    overallTimer = clock.setTimeout(() => abortForTimeout('overall'), overallTimeoutMs);
    headerTimer = clock.setTimeout(
      () => abortForTimeout('connect-header'),
      Math.min(headerTimeoutMs, overallTimeoutMs),
    );
  }

  try {
    // Promise argument evaluation would otherwise call an untrusted fetch even
    // when disposal/caller cancellation was already complete.
    if (controller.signal.aborted) {
      throw controller.signal.reason ?? new DOMException('Aborted', 'AbortError');
    }
    response = await raceCancellation(fetchImplementation(target, {
      ...init,
      redirect: 'manual',
      signal: controller.signal,
    }));
    if (headerTimer) clock.clearTimeout(headerTimer);
    headerTimer = undefined;

    // Browsers may expose a manual cross-origin redirect as opaqueredirect
    // rather than preserving its 3xx status. Both forms are terminal and their
    // bodies are never parsed.
    if ((response.status >= 300 && response.status < 400)
      || response.type === 'opaqueredirect'
      || response.status === 0) {
      throw invalidResponse(response.status || undefined);
    }

    const encoding = contentEncoding(response);
    const declaredLength = contentLength(response);
    if (encoding === 'identity'
      && declaredLength !== undefined
      && declaredLength > MAX_RESPONSE_BYTES) {
      throw invalidResponse(response.status);
    }
    if (!response.body) {
      if (!response.ok) {
        throw new ProprClientError(`Desktop pairing request failed with HTTP ${response.status}.`, {
          kind: 'http',
          status: response.status,
        });
      }
      throw invalidResponse(response.status);
    }

    reader = response.body.getReader();
    bodyTimer = clock.setTimeout(
      () => abortForTimeout('body'),
      Math.min(bodyTimeoutMs, overallTimeoutMs),
    );
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    while (true) {
      const part = await raceCancellation(reader.read());
      if (part.done) break;
      if (!(part.value instanceof Uint8Array) || part.value.byteLength === 0) {
        throw invalidResponse(response.status);
      }
      byteLength += part.value.byteLength;
      if (byteLength > MAX_RESPONSE_BYTES) throw invalidResponse(response.status);
      chunks.push(part.value);
    }
    // For gzip and Brotli, Fetch retains the wire Content-Length while exposing
    // transparently decoded stream chunks. It is not meaningful to compare the
    // compressed length with byteLength; the decoded cap above remains the
    // authoritative bound. Identity responses still require an exact match.
    if (encoding === 'identity'
      && declaredLength !== undefined
      && declaredLength !== byteLength) {
      throw invalidResponse(response.status);
    }

    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (cause) {
      throw invalidResponse(response.status, cause);
    }

    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch (cause) {
      if (!response.ok) value = undefined;
      else throw invalidResponse(response.status, cause);
    }
    if (!response.ok) {
      throw new ProprClientError(`Desktop pairing request failed with HTTP ${response.status}.`, {
        kind: 'http',
        status: response.status,
        code: errorCode(value),
      });
    }
    const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (contentType !== 'application/json') throw invalidResponse(response.status);
    return value;
  } catch (cause) {
    if (cause instanceof ProprClientError) throw cause;
    if (callerSignal?.aborted) throw cancelledError(cause);
    if (timeoutPhase) throw timeoutError(cause);
    if (cause instanceof Error && cause.name === 'AbortError') throw cancelledError(cause);
    throw networkError(cause);
  } finally {
    // Network ownership ends before touching the untrusted stream primitive.
    // All local timers/listeners are detached first; cancellation then gets a
    // separate short budget which is also clamped to the endpoint deadline.
    if (!controller.signal.aborted) controller.abort();
    if (headerTimer) clock.clearTimeout(headerTimer);
    if (bodyTimer) clock.clearTimeout(bodyTimer);
    if (overallTimer) clock.clearTimeout(overallTimer);
    callerSignal?.removeEventListener('abort', abortForCaller);
    await cancelResponse();
    try { reader?.releaseLock(); } catch { /* The stream may already be errored. */ }
    reader = undefined;
    response = undefined;
  }
};
