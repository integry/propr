import { normalizeDesktopPairingApprovalUrl } from '@propr/shared';
import type { DesktopPairingBrowserRequest } from './credential-service';

const REJECTED_PAIRING_URL_ERROR = 'Desktop pairing browser request was rejected';
const OPEN_PAIRING_BROWSER_ERROR = 'Desktop pairing browser could not be opened';

export const supportsAmbiguousPairingLaunchRecovery = (platform: NodeJS.Platform): boolean =>
  platform === 'linux';

/**
 * Identifies an OS browser-launch rejection without exposing the URL or the
 * host-specific portal error across process or logging boundaries.
 */
export class DesktopPairingBrowserOpenError extends Error {
  constructor(_cause: unknown) {
    super(OPEN_PAIRING_BROWSER_ERROR);
    this.name = 'DesktopPairingBrowserOpenError';
  }
}

export const isDesktopPairingBrowserOpenError = (
  error: unknown,
): error is DesktopPairingBrowserOpenError => error instanceof DesktopPairingBrowserOpenError
  || (error instanceof Error && error.name === 'DesktopPairingBrowserOpenError');

interface ExternalShell {
  openExternal(url: string): Promise<unknown>;
}

interface ApprovalClipboard {
  writeText(text: string): void;
}

const approvedDesktopPairingUrl = (request: DesktopPairingBrowserRequest): string => {
  const approved = normalizeDesktopPairingApprovalUrl(request);
  if (approved === null || approved !== request.approvalUrl) {
    throw new Error(REJECTED_PAIRING_URL_ERROR);
  }
  return approved;
};

/** Revalidate the exact API response at the final host sink before navigation. */
export async function openApprovedDesktopPairingUrl(
  request: DesktopPairingBrowserRequest,
  shell: ExternalShell,
  options: { ambiguousOsLaunchFailure?: boolean } = {},
): Promise<void> {
  const approved = approvedDesktopPairingUrl(request);
  try {
    await shell.openExternal(approved);
  } catch (error) {
    if (options.ambiguousOsLaunchFailure) throw new DesktopPairingBrowserOpenError(error);
    throw error;
  }
}

/** Revalidate at the final host sink before placing the main-owned URL on the clipboard. */
export function copyApprovedDesktopPairingUrl(
  request: DesktopPairingBrowserRequest,
  clipboard: ApprovalClipboard,
): void {
  clipboard.writeText(approvedDesktopPairingUrl(request));
}
