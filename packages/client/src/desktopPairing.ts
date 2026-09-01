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
  pairingId: string;
  deviceSecret: string;
  activationTicket: string;
  activationExpiresAt: string;
  instanceId: string;
  origin: string;
  scope: 'desktop-instance';
  credentialGeneration: string;
}

export interface ProprDesktopPairingBinding {
  instanceId: string;
  origin: string;
  scope: 'desktop-instance';
  credentialGeneration: string;
}

export interface ProprDesktopPairingActivationReceipt {
  status: 'active';
  receipt: string;
  activatedAt: string;
  expiresAt: string | null;
}

export interface ProprDesktopPairingOptions {
  signal?: AbortSignal;
  binding: ProprDesktopPairingBinding;
  onApprovalRequired?(approvalUrl: string, expiresAt: string): void | Promise<void>;
  /** Injectable only to make protocol tests deterministic. */
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  /** Injectable only to make expiry tests deterministic. */
  now?: () => number;
  /** @internal Deterministic monotonic deadline source for protocol tests. */
  clock?: {
    now(): number;
    setTimeout(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout>;
    clearTimeout(timer: ReturnType<typeof setTimeout>): void;
  };
}

const MIN_POLL_INTERVAL_SECONDS = 1;
const MAX_POLL_INTERVAL_SECONDS = 60;
const MAX_PAIRING_LIFETIME_MS = 30 * 60 * 1000;
const PAIRING_REQUEST_TIMEOUT_MS = 8_000;
const exactKeys = (body: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(body).length === keys.length && Object.keys(body).every(key => keys.includes(key));

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

const validBinding = (value: unknown): value is ProprDesktopPairingBinding => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const binding = value as Record<string, unknown>;
  return typeof binding.instanceId === 'string'
    && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(binding.instanceId)
    && typeof binding.origin === 'string'
    && canonicalProprHttpUrlOrigin(binding.origin) === binding.origin
    && binding.scope === 'desktop-instance'
    && typeof binding.credentialGeneration === 'string'
    && /^[A-Za-z0-9_-]{22}$/.test(binding.credentialGeneration);
};

const validCapabilities = (value: unknown): value is ProprDesktopAuthenticationCapabilities => {
  if (!value || typeof value !== 'object') return false;
  const capabilities = value as Record<string, unknown>;
  return capabilities.protocolVersion === 2
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
  expectedOrigin: string,
  now: () => number = Date.now,
): ProprDesktopPairingStart => {
  const body = record(value);
  if (!exactKeys(body, ['pairingId', 'deviceSecret', 'approvalUrl', 'expiresAt', 'interval'])
    || !string(body.pairingId) || !/^dpr_[A-Za-z0-9_-]{22}$/.test(body.pairingId)
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
    if (!expectedOrigin || approvalUrl.origin !== expectedOrigin) throw new Error();
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
  options: ProprDesktopPairingOptions,
): Promise<ProprDesktopPairingComplete> => {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const clock = options.clock ?? {
    now: () => performance.now(),
    setTimeout: (callback: () => void, milliseconds: number) => setTimeout(callback, milliseconds),
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
  };
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
  const monotonicStartedAt = clock.now();
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
  const deadlineTimer = clock.setTimeout(abortForDeadline, safeDelay(lifetimeMs));
  if (options.signal?.aborted) abortForCaller();
  else options.signal?.addEventListener('abort', abortForCaller, { once: true });

  const terminalError = (cause?: unknown): ProprClientError => terminal === 'caller'
    ? cancelled(cause ?? options.signal?.reason)
    : expired(cause);
  const remainingLifetime = (): number => Math.min(
    deadline - now(),
    lifetimeMs - (clock.now() - monotonicStartedAt),
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
      const requestUsesPairingDeadline = remaining <= PAIRING_REQUEST_TIMEOUT_MS;
      let pairingDeadlineTimedOut = false;
      try {
        // The pairing reader owns cancellation through body drain/cancel. Do
        // not race it with a faster outer rejection: completion here is the
        // operation's guarantee that no response task survives this poll.
        value = await client.requestDesktopPairing(
          `/api/desktop/pairings/${encodeURIComponent(start.pairingId)}/poll`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceSecret: start.deviceSecret }),
            redirect: 'manual',
            signal: lifetimeController.signal,
          },
          Math.min(PAIRING_REQUEST_TIMEOUT_MS, safeDelay(remaining)),
          requestUsesPairingDeadline ? cause => {
            pairingDeadlineTimedOut = true;
            return expired(cause);
          } : undefined,
        );
      } catch (error) {
        // A request clamped to the remaining lifetime owns the same boundary
        // as the pairing deadline. Its timer can run first when the pairing
        // timer's task is delayed, but that must not change expiry into a
        // transport timeout at the exact boundary.
        if (terminal) throw terminalError(error);
        if (pairingDeadlineTimedOut) {
          abortForDeadline();
          throw error;
        }
        if (remainingLifetime() <= 0) {
          abortForDeadline();
          throw terminalError(error);
        }
        throw error;
      }
      requireRemainingLifetime();
      const body = record(value);
      if (body.status === 'pending'
        && exactKeys(body, ['status', 'interval'])
        && validPollInterval(body.interval)) {
        intervalSeconds = body.interval;
        continue;
      }
      if (body.status === 'provisional'
        && exactKeys(body, [
          'status', 'token', 'tokenType', 'activationTicket', 'activationExpiresAt',
          'instanceId', 'origin', 'scope', 'credentialGeneration',
        ])
        && string(body.token)
        && /^propr_it_[A-Za-z0-9_-]{43}$/.test(body.token) && body.tokenType === 'Bearer'
        && string(body.activationTicket) && /^[A-Za-z0-9_-]{43}$/.test(body.activationTicket)
        && validPairingDeadline(body.activationExpiresAt, now())
        && validBinding(body)
        && body.instanceId === options.binding.instanceId
        && body.origin === options.binding.origin
        && body.scope === options.binding.scope
        && body.credentialGeneration === options.binding.credentialGeneration) {
        requireRemainingLifetime();
        return {
          token: body.token,
          tokenType: 'Bearer',
          pairingId: start.pairingId,
          deviceSecret: start.deviceSecret,
          activationTicket: body.activationTicket,
          activationExpiresAt: body.activationExpiresAt,
          instanceId: body.instanceId,
          origin: body.origin,
          scope: body.scope,
          credentialGeneration: body.credentialGeneration,
        };
      }
      throw new ProprClientError('The ProPR instance returned an invalid pairing status.', {
        kind: 'invalid_response',
      });
    }
  } finally {
    clock.clearTimeout(deadlineTimer);
    options.signal?.removeEventListener('abort', abortForCaller);
  }
};

export const parseDesktopPairingActivationReceipt = (value: unknown): ProprDesktopPairingActivationReceipt => {
  const body = record(value);
  if (body.status !== 'active' || !string(body.receipt) || !/^[A-Za-z0-9_-]{22}$/.test(body.receipt)
    || !string(body.activatedAt) || !Number.isFinite(Date.parse(body.activatedAt))
    || !(body.expiresAt === null || (string(body.expiresAt) && Number.isFinite(Date.parse(body.expiresAt))))
    || Object.keys(body).some(key => !['status', 'receipt', 'activatedAt', 'expiresAt'].includes(key))) {
    throw new ProprClientError('The ProPR instance returned an invalid pairing activation receipt.', {
      kind: 'invalid_response',
    });
  }
  return body as unknown as ProprDesktopPairingActivationReceipt;
};
