import { normalizeProprApiOrigin } from './apiOrigin.js';
import {
  DEFAULT_PROPR_UI_ORIGIN,
  isProprConnectReservedHostAttempt,
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

const bareHttpOrigin = (value: string): URL | null => {
  const connectEndpoint = parseProprConnectEndpoint(value);
  if (isProprConnectReservedHostAttempt(value) && !connectEndpoint) return null;
  const normalized = normalizeProprApiOrigin(value);
  if (normalized === null || normalized !== value) return null;
  try {
    const url = new URL(normalized);
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

const hasCanonicalRawSearchParameters = (
  url: URL,
  expected: Readonly<Record<string, string>>,
): boolean => {
  const query = url.search.startsWith('?') ? url.search.slice(1) : url.search;
  const parameters = query.split('&');
  const names = Object.keys(expected);
  if (parameters.length !== names.length) return false;

  const actual = new Map<string, string>();
  for (const parameter of parameters) {
    const separator = parameter.indexOf('=');
    if (separator === -1) return false;
    const name = parameter.slice(0, separator);
    if (!Object.hasOwn(expected, name) || actual.has(name)) return false;
    actual.set(name, parameter.slice(separator + 1));
  }
  return names.every(name => actual.get(name) === expected[name]);
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
  if (!hasCanonicalRawSearchParameters(approval, {
    pairing_id: input.pairingId,
    tunnel: connectEndpoint.hostname,
  })) return null;
  return approval.toString();
}
