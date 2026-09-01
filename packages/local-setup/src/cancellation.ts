/** True for both DOM/Node AbortError variants and the setup engine's cancellation sentinel. */
export function isSetupCancellation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { name?: unknown; code?: unknown };
  return value.name === 'AbortError' || value.name === 'SetupCancellation' || value.code === 'ABORT_ERR';
}

/** Generic catches must call this before converting an operation failure into a warning. */
export function rethrowCancellation(error: unknown): void {
  if (isSetupCancellation(error)) throw error;
}
