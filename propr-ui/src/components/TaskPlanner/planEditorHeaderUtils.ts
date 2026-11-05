export const isPlanActionDisabled = (
  isFinalizing: boolean,
  isResettingToSetup: boolean,
  isDeleting: boolean,
  isReadOnly: boolean
) => isFinalizing || isResettingToSetup || isDeleting || isReadOnly;

export const getReadOnlyTitle = (isReadOnly: boolean, title: string) => (
  isReadOnly ? 'Demo mode is read-only' : title
);
