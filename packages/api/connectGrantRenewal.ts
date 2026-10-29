import { createHash } from 'node:crypto';

/**
 * Relay renewal for Connect browser sign-in grants (#3387). Connect keeps the
 * GitHub refresh material server-side and renews the instance's credential
 * over the existing relay connection. Nothing here logs token material.
 */

export const RELAY_RENEWAL = 'relay';
export type ConnectGrantRenewal = typeof RELAY_RENEWAL;

const RENEWAL_LEAD_MS = 10 * 60_000;
const RENEWAL_JITTER_MS = 2 * 60_000;
const RENEWAL_TIMEOUT_MS = 20_000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 10 * 60_000;
export const RENEWAL_LEASE_MS = RENEWAL_TIMEOUT_MS + 5_000;

/** Relay codes after which only a browser sign-in restores access. */
export type RenewalReauthCode = 'renewal_revoked' | 'renewal_expired' | 'reauth_required';
const REAUTH_CODES = new Set<string>(['renewal_revoked', 'renewal_expired', 'reauth_required']);

export type RelayRenewalResult =
  | { kind: 'renewed'; accessToken: string; expiresAt: number | null }
  | { kind: 'reauth'; code: RenewalReauthCode }
  | { kind: 'unavailable' }
  | { kind: 'transient'; code: string; retryAfterMs?: number };

/**
 * Parses `access_token_expires_at`: a timestamp in ms, `null` for a
 * non-expiring credential, or `undefined` when absent or malformed.
 */
export function parseConnectExpiry(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** A stable, non-reversible grant identifier for logs. */
export function grantIdHash(githubUserId: string): string {
  return createHash('sha256').update('propr:connect-grant:').update(githubUserId).digest('hex').slice(0, 16);
}

/**
 * When proactive renewal starts: about ten minutes before expiry, plus a
 * per-credential jitter of up to two minutes so many grants issued together
 * do not all renew at once. The jitter is stable for one credential, so every
 * process agrees on the same moment.
 */
export function renewalDueAt(credentialKey: string, expiresAt: number): number {
  const jitter = createHash('sha256').update(credentialKey).digest().readUInt32BE(0) % RENEWAL_JITTER_MS;
  return expiresAt - RENEWAL_LEAD_MS - jitter;
}

/**
 * Exponential backoff after a transient failure. Only the local backoff is
 * capped; the relay's full Retry-After is always honoured.
 */
export function renewalBackoffMs(failures: number, retryAfterMs?: number): number {
  const exponential = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, Math.min(failures - 1, 10)));
  const jittered = exponential / 2 + Math.random() * (exponential / 2);
  return Math.max(jittered, retryAfterMs ?? 0);
}

export function logRenewalOutcome(event: {
  githubUserId: string;
  outcome: 'renewed' | 'reauth_required' | 'renewal_unavailable' | 'transient_failure';
  expiresAt?: number | null;
  errorCode?: string;
  retryAt?: number;
}): void {
  const entry = {
    grant: grantIdHash(event.githubUserId),
    outcome: event.outcome,
    expires_at: typeof event.expiresAt === 'number' ? new Date(event.expiresAt).toISOString() : event.expiresAt ?? undefined,
    error_code: event.errorCode,
    retry_at: event.retryAt === undefined ? undefined : new Date(event.retryAt).toISOString(),
  };
  const log = event.outcome === 'renewed' ? console.info : console.warn;
  log('[connect-grant-renewal]', JSON.stringify(entry));
}

function renewalEndpoint(environment: NodeJS.ProcessEnv): { url: string; token: string } {
  const relayUrl = environment.PROPR_GH_RELAY_URL?.trim().replace(/\/+$/, '');
  const relayToken = environment.PROPR_GH_RELAY_TOKEN?.trim();
  if (!relayUrl || !relayToken) throw new Error('ProPR Connect credentials are unavailable for grant renewal');
  const url = new URL(`${relayUrl}/instance-auth/renew`);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error('PROPR_GH_RELAY_URL must use HTTPS');
  }
  return { url: url.toString(), token: relayToken };
}

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after')?.trim();
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

async function errorCode(response: Response): Promise<string | undefined> {
  try {
    const body = await response.json() as { error?: unknown; code?: unknown };
    const code = typeof body?.error === 'string' ? body.error : body?.code;
    return typeof code === 'string' && /^[a-z_]{1,64}$/.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

/** One `POST /v1/instance-auth/renew` call, classified by the relay's stable error codes. */
export async function requestRelayRenewal(
  environment: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
  githubUserId: string,
): Promise<RelayRenewalResult> {
  let response: Response;
  try {
    const endpoint = renewalEndpoint(environment);
    response = await fetchImpl(endpoint.url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${endpoint.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ github_user_id: githubUserId }),
      redirect: 'error',
      signal: AbortSignal.timeout(RENEWAL_TIMEOUT_MS),
    });
  } catch {
    return { kind: 'transient', code: 'network' };
  }
  if (!response.ok) {
    const code = await errorCode(response);
    if (code && REAUTH_CODES.has(code)) return { kind: 'reauth', code: code as RenewalReauthCode };
    if (code === 'renewal_unavailable') return { kind: 'unavailable' };
    return { kind: 'transient', code: code ?? `http_${response.status}`, retryAfterMs: retryAfterMs(response) };
  }
  try {
    const body = await response.json() as { access_token?: unknown; access_token_expires_at?: unknown };
    const expiresAt = body.access_token_expires_at === undefined ? null : parseConnectExpiry(body.access_token_expires_at);
    if (typeof body.access_token !== 'string' || !body.access_token.trim() || expiresAt === undefined) {
      return { kind: 'transient', code: 'invalid_response' };
    }
    return { kind: 'renewed', accessToken: body.access_token.trim(), expiresAt };
  } catch {
    return { kind: 'transient', code: 'invalid_response' };
  }
}
