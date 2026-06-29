import {
  evaluateProprApiCompatibility,
  type ProprApiCompatibilityResult,
  type ProprCompatibilityMetadata,
} from '@propr/shared';
import { getApiBaseUrl } from '../config/runtimeConfig';

const API_BASE_URL = getApiBaseUrl();

// Bound the pre-render compatibility probe so a slow/unreachable API can't trap
// the user on a spinner waiting out the browser's default fetch timeout. On
// timeout we throw a check error, which App treats as transient and renders the
// app anyway.
const COMPATIBILITY_CHECK_TIMEOUT_MS = 8000;

export class ProprCompatibilityCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProprCompatibilityCheckError';
  }
}

export async function checkProprApiCompatibility(): Promise<ProprApiCompatibilityResult> {
  let response: Response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), COMPATIBILITY_CHECK_TIMEOUT_MS);
  try {
    response = await fetch(`${API_BASE_URL}/api/compatibility`, {
      credentials: 'include',
      cache: 'no-store',
      signal: controller.signal,
    });
  } catch {
    throw new ProprCompatibilityCheckError('Cannot reach the local ProPR API. Check that the stack is running and the tunnel is connected.');
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    if (response.status === 404) {
      return evaluateProprApiCompatibility({});
    }
    throw new ProprCompatibilityCheckError(`Cannot check local ProPR compatibility: HTTP ${response.status}.`);
  }

  let metadata: Partial<ProprCompatibilityMetadata>;
  try {
    metadata = await response.json() as Partial<ProprCompatibilityMetadata>;
  } catch {
    throw new ProprCompatibilityCheckError('The local ProPR API returned invalid compatibility metadata.');
  }

  return evaluateProprApiCompatibility(metadata);
}
