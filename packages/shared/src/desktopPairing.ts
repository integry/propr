import {
  DEFAULT_PROPR_UI_ORIGIN,
  isProprConnectReservedHostAttempt,
  MAX_PROPR_API_BASE_URL_LENGTH,
  parseProprConnectEndpoint,
} from './proprServiceUrls.js';

const DESKTOP_PAIRING_ID_PATTERN = /^dpr_[A-Za-z0-9_-]{22}$/;

export interface DesktopPairingApprovalUrlInput {
  /** Canonical API origin returned by endpoint discovery. */
  apiBaseUrl: string;
  /** Pairing id returned by the same pairing bootstrap response. */
  pairingId: string;
  /** Approval URL returned by the API. Renderer input must never be used here. */
  approvalUrl: string;
}

const rawAuthority = (value: string): string | null =>
  /^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i.exec(value)?.[1] ?? null;

const isLoopbackHostname = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  if (normalized === 'localhost' || normalized.endsWith('.localhost') || normalized === '[::1]') return true;
  const parts = normalized.split('.');
  return parts.length === 4
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
    && Number(parts[0]) === 127;
};

const bareHttpOrigin = (value: string): URL | null => {
  if (value.length > MAX_PROPR_API_BASE_URL_LENGTH) return null;
  const connectEndpoint = parseProprConnectEndpoint(value);
  if (isProprConnectReservedHostAttempt(value) && !connectEndpoint) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.protocol === 'http:' && !isLoopbackHostname(url.hostname)) return null;
    if (url.username || url.password || url.search || url.hash) return null;
    if (/[^/]/.test(url.pathname)) return null;
    // Callers must supply the already-normalized discovery origin. Binding an
    // approval response to a second spelling would reintroduce encoded-host or
    // explicit-default-port ambiguity at the browser boundary.
    if (value !== url.origin || rawAuthority(value)?.toLowerCase() !== url.host.toLowerCase()) return null;
    return url;
  } catch {
    return null;
  }
};

const hasExactSearchParameters = (url: URL, names: readonly string[]): boolean => {
  const actual = [...url.searchParams.keys()];
  return actual.length === names.length
    && names.every(name => actual.filter(candidate => candidate === name).length === 1);
};

/**
 * Validate an API-returned browser approval URL against the pairing bootstrap
 * that supplied it. Two existing server contracts are accepted:
 *
 * - the hosted approval page on `https://app.propr.dev/desktop/pairing`, bound
 *   to the exact verified Connect hostname; and
 * - the exact `/api/desktop/pairings/<id>/browser` route on the API origin.
 *
 * No URL is synthesized. Unknown query parameters, fragments, credentials,
 * alternate origins, private paths, and pairing ids are rejected.
 */
export function normalizeDesktopPairingApprovalUrl(
  input: DesktopPairingApprovalUrlInput,
): string | null {
  if (!DESKTOP_PAIRING_ID_PATTERN.test(input.pairingId)) return null;
  const apiBase = bareHttpOrigin(input.apiBaseUrl);
  if (!apiBase) return null;

  let approval: URL;
  try {
    approval = new URL(input.approvalUrl);
  } catch {
    return null;
  }
  if (approval.username || approval.password || approval.hash) return null;
  const approvalAuthority = rawAuthority(input.approvalUrl)?.toLowerCase();

  const fallbackPath = `/api/desktop/pairings/${input.pairingId}/browser`;
  if (
    approval.origin === apiBase.origin
    && approvalAuthority === apiBase.host.toLowerCase()
    && approval.pathname === fallbackPath
    && !approval.search
  ) {
    return approval.toString();
  }

  const connectEndpoint = parseProprConnectEndpoint(input.apiBaseUrl);
  if (
    !connectEndpoint
    || approval.origin !== DEFAULT_PROPR_UI_ORIGIN
    || approvalAuthority !== new URL(DEFAULT_PROPR_UI_ORIGIN).host
  ) return null;
  if (approval.pathname !== '/desktop/pairing') return null;
  if (!hasExactSearchParameters(approval, ['pairing_id', 'tunnel'])) return null;
  if (approval.searchParams.get('pairing_id') !== input.pairingId) return null;
  if (approval.searchParams.get('tunnel') !== connectEndpoint.hostname) return null;
  return approval.toString();
}
