import { normalizeDesktopPairingApprovalUrl } from '@propr/shared';
import type { DesktopPairingBrowserRequest } from './credential-service';

const REJECTED_PAIRING_URL_ERROR = 'Desktop pairing browser request was rejected';

interface ExternalShell {
  openExternal(url: string): Promise<unknown>;
}

/** Revalidate the exact API response at the final host sink before navigation. */
export async function openApprovedDesktopPairingUrl(
  request: DesktopPairingBrowserRequest,
  shell: ExternalShell,
): Promise<void> {
  const approved = normalizeDesktopPairingApprovalUrl(request);
  if (approved === null || approved !== request.approvalUrl) {
    throw new Error(REJECTED_PAIRING_URL_ERROR);
  }
  await shell.openExternal(approved);
}
