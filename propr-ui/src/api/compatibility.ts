import {
  evaluateProprApiCompatibility,
  type ProprApiCompatibilityResult,
  type ProprCompatibilityMetadata,
} from '@propr/shared';
import { getApiBaseUrl } from '../config/runtimeConfig';

const API_BASE_URL = getApiBaseUrl();

export class ProprCompatibilityCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProprCompatibilityCheckError';
  }
}

export async function checkProprApiCompatibility(): Promise<ProprApiCompatibilityResult> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/api/compatibility`, {
      credentials: 'include',
      cache: 'no-store',
    });
  } catch {
    throw new ProprCompatibilityCheckError('Cannot reach the local ProPR API. Check that the stack is running and the tunnel is connected.');
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
