export const DESKTOP_MICROPHONE_USAGE_DESCRIPTION =
  'ProPR checks microphone access only when you choose Check microphone. The check immediately releases the microphone; audio is not recorded or sent.';

/** Native consent stays on the explicit check path, never startup or opt-in. */
export async function requestDesktopMicrophoneConsent({
  platform,
  signal,
  confirm,
  askForMacAccess,
}: {
  platform: NodeJS.Platform;
  signal: AbortSignal;
  confirm(): Promise<boolean>;
  askForMacAccess(): Promise<boolean>;
}): Promise<boolean> {
  if (signal.aborted || (platform !== 'linux' && platform !== 'darwin')) return false;
  if (!await confirm() || signal.aborted) return false;
  if (platform === 'linux') return true;
  // macOS owns this OS prompt and cannot dismiss it on our behalf. Revocation
  // still invalidates the attempt, and a late approval never opens a stream.
  const allowed = await askForMacAccess();
  return !signal.aborted && allowed;
}
