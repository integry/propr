import type {
  ProprApiCompatibilityResult,
  ProprDesktopAuthenticationCapabilities,
} from '@propr/shared';
import { canonicalProprHttpUrlOrigin } from '@propr/shared';
import type { ProprClient } from './client.js';
import { ProprClientError } from './errors.js';

export interface ProprDesktopDiscovery {
  product: string;
  version: string;
  apiCompatibility: string;
  uiCompatibility: string;
  desktopAuthentication: ProprDesktopAuthenticationCapabilities;
  compatibility: ProprApiCompatibilityResult;
}

export interface ProprDesktopPairingStart {
  pairingId: string;
  deviceSecret: string;
  approvalUrl: string;
  expiresAt: string;
  interval: number;
}

export interface ProprDesktopPairingComplete {
  token: string;
  tokenType: 'Bearer';
  expiresAt: string | null;
}

export interface ProprDesktopPairingOptions {
  signal?: AbortSignal;
  onApprovalRequired?(approvalUrl: string, expiresAt: string): void | Promise<void>;
  /** Injectable only to make protocol tests deterministic. */
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  /** Injectable only to make expiry tests deterministic. */
  now?: () => number;
}

const MIN_POLL_INTERVAL_SECONDS = 1;
const MAX_POLL_INTERVAL_SECONDS = 60;
const MAX_PAIRING_LIFETIME_MS = 30 * 60 * 1000;
const PAIRING_REQUEST_TIMEOUT_MS = 8_000;

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProprClientError('The ProPR desktop protocol returned an invalid response.', {
      kind: 'invalid_response',
    });
  }
  return value as Record<string, unknown>;
};

const string = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const validPollInterval = (value: unknown): value is number => typeof value === 'number'
  && Number.isInteger(value)
  && value >= MIN_POLL_INTERVAL_SECONDS
  && value <= MAX_POLL_INTERVAL_SECONDS;

const validPairingDeadline = (value: unknown, now: number): value is string => {
  if (!string(value)) return false;
  const deadline = Date.parse(value);
  return Number.isFinite(deadline)
    && Number.isFinite(now)
    && deadline > now
    && deadline - now <= MAX_PAIRING_LIFETIME_MS;
};

const validCapabilities = (value: unknown): value is ProprDesktopAuthenticationCapabilities => {
  if (!value || typeof value !== 'object') return false;
  const capabilities = value as Record<string, unknown>;
  return capabilities.protocolVersion === 1
    && typeof capabilities.browserPairing === 'boolean'
    && typeof capabilities.instanceBearerTokens === 'boolean'
    && typeof capabilities.socketIoBearerAuthentication === 'boolean';
};

export const parseDesktopDiscovery = (
  value: unknown,
  compatibility: ProprApiCompatibilityResult,
): ProprDesktopDiscovery => {
  const body = record(value);
  if (body.product !== 'ProPR' || !string(body.version) || !string(body.apiCompatibility)
    || !string(body.uiCompatibility) || !validCapabilities(body.desktopAuthentication)) {
    throw new ProprClientError('The ProPR instance returned invalid desktop discovery metadata.', {
      kind: 'invalid_response',
    });
  }
  return {
    product: body.product,
    version: body.version,
    apiCompatibility: body.apiCompatibility,
    uiCompatibility: body.uiCompatibility,
    desktopAuthentication: body.desktopAuthentication,
    compatibility,
  };
};

export const parseDesktopPairingStart = (
  value: unknown,
  expectedOrigin?: string,
  now: () => number = Date.now,
): ProprDesktopPairingStart => {
  const body = record(value);
  if (!string(body.pairingId) || !/^dpr_[A-Za-z0-9_-]{22}$/.test(body.pairingId)
    || !string(body.deviceSecret) || !/^[A-Za-z0-9_-]{43}$/.test(body.deviceSecret)
    || !string(body.approvalUrl)
    || !validPollInterval(body.interval)
    || !validPairingDeadline(body.expiresAt, now())) {
    throw new ProprClientError('The ProPR instance returned an invalid pairing request.', {
      kind: 'invalid_response',
    });
  }
  try {
    const approvalUrl = new URL(body.approvalUrl);
    if (canonicalProprHttpUrlOrigin(body.approvalUrl) !== approvalUrl.origin) throw new Error();
    if (approvalUrl.username || approvalUrl.password) throw new Error();
    // Device approval is intentionally same-origin. A future hosted approval
    // service must define and validate a narrow trust contract here first.
    if (expectedOrigin && approvalUrl.origin !== expectedOrigin) throw new Error();
  } catch {
    throw new ProprClientError('The ProPR instance returned an unsafe pairing approval URL.', {
      kind: 'invalid_response',
    });
  }
  return {
    pairingId: body.pairingId,
    deviceSecret: body.deviceSecret,
    approvalUrl: body.approvalUrl,
    expiresAt: body.expiresAt,
    interval: body.interval,
  };
};

const cancelled = (cause?: unknown): ProprClientError =>
  new ProprClientError('Desktop pairing was cancelled.', { kind: 'aborted', cause });

const expired = (cause?: unknown): ProprClientError =>
  new ProprClientError('Desktop pairing expired before it was approved.', {
    kind: 'authentication', code: 'PAIRING_EXPIRED', cause,
  });

const safeDelay = (milliseconds: number): number => Math.max(1, Math.ceil(milliseconds));

const defaultSleep = (milliseconds: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  const aborted = () => {
    clearTimeout(timer);
    reject(cancelled());
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener('abort', aborted);
    resolve();
  }, milliseconds);
  if (signal?.aborted) aborted();
  else signal?.addEventListener('abort', aborted, { once: true });
});

export const completeDesktopPairing = async (
  client: ProprClient,
  start: ProprDesktopPairingStart,
  options: ProprDesktopPairingOptions = {},
): Promise<ProprDesktopPairingComplete> => {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  if (options.signal?.aborted) throw cancelled(options.signal.reason);
  const deadline = Date.parse(start.expiresAt);
  const startedAt = now();
  const lifetimeMs = deadline - startedAt;
  if (!validPollInterval(start.interval)
    || !Number.isFinite(deadline)
    || !Number.isFinite(startedAt)
    || lifetimeMs > MAX_PAIRING_LIFETIME_MS) {
    throw new ProprClientError('The ProPR instance returned an invalid pairing deadline.', {
      kind: 'invalid_response',
    });
  }
  if (lifetimeMs <= 0) throw expired();

  const lifetimeController = new AbortController();
  const monotonicStartedAt = performance.now();
  let terminal: 'caller' | 'deadline' | undefined;
  const abortForCaller = () => {
    if (terminal) return;
    terminal = 'caller';
    lifetimeController.abort(options.signal?.reason);
  };
  const abortForDeadline = () => {
    if (terminal) return;
    terminal = 'deadline';
    lifetimeController.abort(expired());
  };
  const deadlineTimer = setTimeout(abortForDeadline, safeDelay(lifetimeMs));
  if (options.signal?.aborted) abortForCaller();
  else options.signal?.addEventListener('abort', abortForCaller, { once: true });

  const terminalError = (cause?: unknown): ProprClientError => terminal === 'caller'
    ? cancelled(cause ?? options.signal?.reason)
    : expired(cause);
  const remainingLifetime = (): number => Math.min(
    deadline - now(),
    lifetimeMs - (performance.now() - monotonicStartedAt),
  );
  const requireRemainingLifetime = (): number => {
    if (terminal) throw terminalError();
    const remaining = remainingLifetime();
    if (remaining <= 0) {
      abortForDeadline();
      throw terminalError();
    }
    return remaining;
  };
  const raceLifetime = <T>(operation: PromiseLike<T>): Promise<T> => {
    let removeAbortListener: () => void = () => undefined;
    const result = new Promise<T>((resolve, reject) => {
      const rejectForAbort = () => reject(terminalError());
      removeAbortListener = () => {
        lifetimeController.signal.removeEventListener('abort', rejectForAbort);
      };
      if (lifetimeController.signal.aborted) rejectForAbort();
      else lifetimeController.signal.addEventListener('abort', rejectForAbort, { once: true });
      // Always attach both handlers, even if the lifetime already ended, so a
      // callback or transport that settles late cannot become unhandled.
      Promise.resolve(operation).then(resolve, error => {
        reject(terminal ? terminalError(error) : error);
      });
    });
    return result.finally(() => removeAbortListener());
  };

  try {
    let intervalSeconds = start.interval;
    if (options.onApprovalRequired) {
      const approval = Promise.resolve().then(() =>
        options.onApprovalRequired?.(start.approvalUrl, start.expiresAt));
      await raceLifetime(approval);
      requireRemainingLifetime();
    }

    while (true) {
      const remainingBeforeSleep = requireRemainingLifetime();
      const delay = safeDelay(Math.min(intervalSeconds * 1000, remainingBeforeSleep));
      await raceLifetime(sleep(delay, lifetimeController.signal));
      const remaining = requireRemainingLifetime();

      let value: unknown;
      try {
        value = await raceLifetime(client.request<unknown>(
          `/api/desktop/pairings/${encodeURIComponent(start.pairingId)}/poll`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceSecret: start.deviceSecret }),
            signal: lifetimeController.signal,
          },
          { timeoutMs: Math.min(PAIRING_REQUEST_TIMEOUT_MS, safeDelay(remaining)) },
        ));
      } catch (error) {
        if (terminal || remainingLifetime() <= 0) {
          if (!terminal) abortForDeadline();
          throw terminalError(error);
        }
        throw error;
      }
      requireRemainingLifetime();
      const body = record(value);
      if (body.status === 'pending' && validPollInterval(body.interval)) {
        intervalSeconds = body.interval;
        continue;
      }
      if (body.status === 'complete' && string(body.token)
        && /^propr_it_[A-Za-z0-9_-]{43}$/.test(body.token) && body.tokenType === 'Bearer'
        && (body.expiresAt === null || (string(body.expiresAt) && Number.isFinite(Date.parse(body.expiresAt))))) {
        requireRemainingLifetime();
        return { token: body.token, tokenType: 'Bearer', expiresAt: body.expiresAt as string | null };
      }
      throw new ProprClientError('The ProPR instance returned an invalid pairing status.', {
        kind: 'invalid_response',
      });
    }
  } finally {
    clearTimeout(deadlineTimer);
    options.signal?.removeEventListener('abort', abortForCaller);
  }
};
