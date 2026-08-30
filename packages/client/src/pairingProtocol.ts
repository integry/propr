import { ProprClientError } from './errors.js';

const CONNECT_HEADER_TIMEOUT_MS = 8_000;
const BODY_TIMEOUT_MS = 8_000;
const OVERALL_TIMEOUT_MS = CONNECT_HEADER_TIMEOUT_MS + BODY_TIMEOUT_MS;
const MAX_RESPONSE_BYTES = 4_096;

type TimeoutPhase = 'connect-header' | 'body' | 'overall';

export interface PairingProtocolRequestOptions {
  overallTimeoutMs?: number;
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

const contentLength = (response: Response): number | undefined => {
  const raw = response.headers.get('content-length');
  if (raw === null) return undefined;
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) throw invalidResponse(response.status);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw invalidResponse(response.status);
  return value;
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
  const controller = new AbortController();
  let timeoutPhase: TimeoutPhase | undefined;
  let headerTimer: ReturnType<typeof setTimeout> | undefined;
  let bodyTimer: ReturnType<typeof setTimeout> | undefined;
  let overallTimer: ReturnType<typeof setTimeout> | undefined;
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let completed = false;

  const abortForCaller = (): void => controller.abort(callerSignal?.reason);
  const abortForTimeout = (phase: TimeoutPhase): void => {
    if (controller.signal.aborted) return;
    timeoutPhase = phase;
    controller.abort(new DOMException('Desktop pairing deadline exceeded', 'TimeoutError'));
  };
  const raceCancellation = <T>(operation: PromiseLike<T>): Promise<T> => new Promise<T>((resolve, reject) => {
    const aborted = () => reject(controller.signal.reason ?? new DOMException('Aborted', 'AbortError'));
    if (controller.signal.aborted) aborted();
    else controller.signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(operation).then(resolve, reject).finally(() => {
      controller.signal.removeEventListener('abort', aborted);
    }).catch(() => undefined);
  });
  const cancelResponse = async (): Promise<void> => {
    if (!controller.signal.aborted) controller.abort();
    try {
      if (reader) await reader.cancel();
      else if (response?.body) await response.body.cancel();
    } catch {
      // Cancellation is best-effort after the owning network signal is aborted.
    }
  };

  if (callerSignal?.aborted) abortForCaller();
  else callerSignal?.addEventListener('abort', abortForCaller, { once: true });
  overallTimer = setTimeout(() => abortForTimeout('overall'), overallTimeoutMs);
  headerTimer = setTimeout(
    () => abortForTimeout('connect-header'),
    Math.min(CONNECT_HEADER_TIMEOUT_MS, overallTimeoutMs),
  );

  try {
    response = await raceCancellation(fetchImplementation(target, {
      ...init,
      redirect: 'manual',
      signal: controller.signal,
    }));
    if (headerTimer) clearTimeout(headerTimer);
    headerTimer = undefined;

    // Browsers may expose a manual cross-origin redirect as opaqueredirect
    // rather than preserving its 3xx status. Both forms are terminal and their
    // bodies are never parsed.
    if ((response.status >= 300 && response.status < 400)
      || response.type === 'opaqueredirect'
      || response.status === 0) {
      throw invalidResponse(response.status || undefined);
    }

    const declaredLength = contentLength(response);
    if (declaredLength !== undefined && declaredLength > MAX_RESPONSE_BYTES) {
      throw invalidResponse(response.status);
    }
    if (!response.body) {
      completed = true;
      if (!response.ok) {
        throw new ProprClientError(`Desktop pairing request failed with HTTP ${response.status}.`, {
          kind: 'http',
          status: response.status,
        });
      }
      throw invalidResponse(response.status);
    }

    reader = response.body.getReader();
    bodyTimer = setTimeout(
      () => abortForTimeout('body'),
      Math.min(BODY_TIMEOUT_MS, overallTimeoutMs),
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
    if (declaredLength !== undefined && declaredLength !== byteLength) {
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
    completed = true;

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
    if (!completed) await cancelResponse();
    if (cause instanceof ProprClientError) throw cause;
    if (callerSignal?.aborted) throw cancelledError(cause);
    if (timeoutPhase) throw timeoutError(cause);
    if (cause instanceof Error && cause.name === 'AbortError') throw cancelledError(cause);
    throw networkError(cause);
  } finally {
    if (!completed && (response?.body || reader)) await cancelResponse();
    if (headerTimer) clearTimeout(headerTimer);
    if (bodyTimer) clearTimeout(bodyTimer);
    if (overallTimer) clearTimeout(overallTimer);
    callerSignal?.removeEventListener('abort', abortForCaller);
    try { reader?.releaseLock(); } catch { /* The stream may already be errored. */ }
  }
};
