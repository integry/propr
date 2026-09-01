import {
  type ProprApiCompatibilityResult,
} from '@propr/shared';
import { isProprClientError } from '@propr/client';
import { getProprClient } from './apiClient';

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
  try {
    return await getProprClient().negotiateCompatibility({
      timeoutMs: COMPATIBILITY_CHECK_TIMEOUT_MS,
    });
  } catch (error) {
    if (isProprClientError(error)) {
      if (error.kind === 'http') {
        throw new ProprCompatibilityCheckError(
          `Cannot check local ProPR compatibility: HTTP ${error.status}.`
        );
      }
      if (error.kind === 'invalid_response') {
        throw new ProprCompatibilityCheckError(
          'The local ProPR API returned invalid compatibility metadata.'
        );
      }
    }
    throw new ProprCompatibilityCheckError(
      'Cannot reach the local ProPR API. Check that the stack is running and the tunnel is connected.'
    );
  }
}
