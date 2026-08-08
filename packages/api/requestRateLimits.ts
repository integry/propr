import type { Express } from 'express';
import { ipKeyGenerator, rateLimit, type RateLimitRequestHandler } from 'express-rate-limit';

interface RateLimitEnvironment {
  [key: string]: string | undefined;
}

interface RequestRateLimitPolicy {
  identifier: string;
  limit: number;
  windowMs: number;
}

export interface RequestRateLimitPolicies {
  api: RequestRateLimitPolicy;
  auth: RequestRateLimitPolicy;
  webhook: RequestRateLimitPolicy;
}

const DEFAULT_POLICIES: RequestRateLimitPolicies = {
  api: { identifier: 'api', limit: 600, windowMs: 60_000 },
  auth: { identifier: 'auth', limit: 30, windowMs: 15 * 60_000 },
  webhook: { identifier: 'webhook', limit: 300, windowMs: 60_000 },
};

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const TRUSTED_PROXY_PEERS_ENVIRONMENT_VARIABLE = 'PROPR_TRUSTED_PROXY_PEERS';

/**
 * Forwarded addresses are trusted only when the immediate socket peer is
 * explicitly configured as a reverse proxy. Without configuration, all
 * clients are keyed by their socket address.
 */
export function configureApiProxyTrust(
  app: Express,
  environment: RateLimitEnvironment = process.env,
): void {
  const configuredPeers = environment[TRUSTED_PROXY_PEERS_ENVIRONMENT_VARIABLE];
  if (configuredPeers === undefined || configuredPeers.trim() === '') {
    app.set('trust proxy', false);
    return;
  }

  app.set('trust proxy', configuredPeers.split(',').map(peer => peer.trim()).filter(Boolean));
}

function positiveInteger(environment: RateLimitEnvironment, name: string, fallback: number): number {
  const configured = environment[name];
  if (configured === undefined || configured.trim() === '') return fallback;

  const value = Number(configured);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got: ${configured}`);
  }
  return value;
}

function windowMilliseconds(environment: RateLimitEnvironment, name: string, fallback: number): number {
  const value = positiveInteger(environment, name, fallback);
  if (value > MAX_TIMER_DELAY_MS) {
    throw new Error(`${name} must be at most ${MAX_TIMER_DELAY_MS}, got: ${value}`);
  }
  return value;
}

export function resolveRequestRateLimitPolicies(
  environment: RateLimitEnvironment = process.env,
): RequestRateLimitPolicies {
  return {
    api: {
      identifier: 'api',
      limit: positiveInteger(environment, 'PROPR_API_RATE_LIMIT_MAX', DEFAULT_POLICIES.api.limit),
      windowMs: windowMilliseconds(environment, 'PROPR_API_RATE_LIMIT_WINDOW_MS', DEFAULT_POLICIES.api.windowMs),
    },
    auth: {
      identifier: 'auth',
      limit: positiveInteger(environment, 'PROPR_AUTH_RATE_LIMIT_MAX', DEFAULT_POLICIES.auth.limit),
      windowMs: windowMilliseconds(environment, 'PROPR_AUTH_RATE_LIMIT_WINDOW_MS', DEFAULT_POLICIES.auth.windowMs),
    },
    webhook: {
      identifier: 'webhook',
      limit: positiveInteger(environment, 'PROPR_WEBHOOK_RATE_LIMIT_MAX', DEFAULT_POLICIES.webhook.limit),
      windowMs: windowMilliseconds(environment, 'PROPR_WEBHOOK_RATE_LIMIT_WINDOW_MS', DEFAULT_POLICIES.webhook.windowMs),
    },
  };
}

export function createRequestRateLimiter(policy: RequestRateLimitPolicy): RateLimitRequestHandler {
  return rateLimit({
    windowMs: policy.windowMs,
    limit: policy.limit,
    identifier: policy.identifier,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: request => {
      const socketAddress = request.socket.remoteAddress;
      const trustProxySetting: unknown = request.app.get('trust proxy');
      const trustProxyFunction: unknown = request.app.get('trust proxy fn');
      const hasExplicitProxyTrust = typeof trustProxySetting === 'string'
        || Array.isArray(trustProxySetting)
        || typeof trustProxySetting === 'function';
      const immediatePeerIsTrusted = hasExplicitProxyTrust
        && socketAddress !== undefined
        && typeof trustProxyFunction === 'function'
        && trustProxyFunction(socketAddress, 0) === true;

      // Boolean and hop-count proxy settings do not identify a trusted peer.
      const clientAddress = immediatePeerIsTrusted
        ? request.ip
        : socketAddress;

      // A missing socket address must share one fail-closed bucket rather than
      // falling back to a client-controlled forwarding header.
      return ipKeyGenerator(clientAddress ?? 'unknown');
    },
    skip: request => request.method === 'OPTIONS',
    message: {
      code: 'RATE_LIMIT_EXCEEDED',
      error: 'Too many requests. Please try again later.',
    },
  });
}

export function createApiRequestRateLimiter(
  environment: RateLimitEnvironment = process.env,
): RateLimitRequestHandler {
  return createRequestRateLimiter(resolveRequestRateLimitPolicies(environment).api);
}

export function createAuthRequestRateLimiter(
  environment: RateLimitEnvironment = process.env,
): RateLimitRequestHandler {
  return createRequestRateLimiter(resolveRequestRateLimitPolicies(environment).auth);
}

export function createWebhookRequestRateLimiter(
  environment: RateLimitEnvironment = process.env,
): RateLimitRequestHandler {
  return createRequestRateLimiter(resolveRequestRateLimitPolicies(environment).webhook);
}
