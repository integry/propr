import type {
  ProprApiCompatibilityResult,
  ProprDesktopAuthenticationCapabilities,
} from '@propr/shared';
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

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProprClientError('The ProPR desktop protocol returned an invalid response.', {
      kind: 'invalid_response',
    });
  }
  return value as Record<string, unknown>;
};

const string = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
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

export const parseDesktopPairingStart = (value: unknown): ProprDesktopPairingStart => {
  const body = record(value);
  if (!string(body.pairingId) || !/^dpr_[A-Za-z0-9_-]{22}$/.test(body.pairingId)
    || !string(body.deviceSecret) || !/^[A-Za-z0-9_-]{43}$/.test(body.deviceSecret)
    || !string(body.approvalUrl)
    || !string(body.expiresAt) || !Number.isFinite(body.interval) || Number(body.interval) <= 0
    || Number.isNaN(Date.parse(body.expiresAt))) {
    throw new ProprClientError('The ProPR instance returned an invalid pairing request.', {
      kind: 'invalid_response',
    });
  }
  try {
    const approvalUrl = new URL(body.approvalUrl);
    if (approvalUrl.protocol !== 'https:' && !(approvalUrl.protocol === 'http:'
      && ['localhost', '127.0.0.1', '[::1]'].includes(approvalUrl.hostname))) throw new Error();
    if (approvalUrl.username || approvalUrl.password) throw new Error();
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
    interval: Number(body.interval),
  };
};

const defaultSleep = (milliseconds: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  const aborted = () => {
    clearTimeout(timer);
    reject(new ProprClientError('Desktop pairing was cancelled.', { kind: 'aborted' }));
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
  let intervalSeconds = start.interval;
  await options.onApprovalRequired?.(start.approvalUrl, start.expiresAt);

  while (true) {
    if (options.signal?.aborted) {
      throw new ProprClientError('Desktop pairing was cancelled.', { kind: 'aborted' });
    }
    if (now() >= Date.parse(start.expiresAt)) {
      throw new ProprClientError('Desktop pairing expired before it was approved.', {
        kind: 'authentication', code: 'PAIRING_EXPIRED',
      });
    }
    await sleep(intervalSeconds * 1000, options.signal);
    if (now() >= Date.parse(start.expiresAt)) {
      throw new ProprClientError('Desktop pairing expired before it was approved.', {
        kind: 'authentication', code: 'PAIRING_EXPIRED',
      });
    }
    const value = await client.request<unknown>(
      `/api/desktop/pairings/${encodeURIComponent(start.pairingId)}/poll`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceSecret: start.deviceSecret }),
        signal: options.signal,
      },
    );
    const body = record(value);
    if (body.status === 'pending' && Number.isFinite(body.interval) && Number(body.interval) > 0) {
      intervalSeconds = Number(body.interval);
      continue;
    }
    if (body.status === 'complete' && string(body.token)
      && /^propr_it_[A-Za-z0-9_-]{43}$/.test(body.token) && body.tokenType === 'Bearer'
      && (body.expiresAt === null || string(body.expiresAt))) {
      return { token: body.token, tokenType: 'Bearer', expiresAt: body.expiresAt as string | null };
    }
    throw new ProprClientError('The ProPR instance returned an invalid pairing status.', {
      kind: 'invalid_response',
    });
  }
};
