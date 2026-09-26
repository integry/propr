export interface DeepLinkFailurePolicyActions {
  exit(code: number): void;
  log(
    level: 'error',
    event: string,
    fields: Readonly<Record<string, string>>,
  ): void;
}

/** Keeps renderer acknowledgement failures observable without exposing the link or renderer output. */
export const handleDeepLinkDeliveryFailure = (
  nativeArtifactSmoke: boolean,
  actions: DeepLinkFailurePolicyActions,
): void => {
  const fields = { failure: 'renderer_acknowledgement' } as const;
  try {
    actions.log('error', 'desktop.deeplink.delivery_failed', fields);
  } catch {
    // A diagnostic sink must not turn an ordinary production delivery failure into a crash.
  }
  if (nativeArtifactSmoke) {
    try {
      actions.log('error', 'desktop.app.start_failed', fields);
    } catch {
      // Native evidence remains fail-closed even if its diagnostic sink is unavailable.
    }
    actions.exit(1);
  }
};
