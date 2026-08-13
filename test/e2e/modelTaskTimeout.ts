export const DEFAULT_MODEL_TASK_TIMEOUT_MS = 20 * 60 * 1000;

/** Resolve the live model-task polling budget while always retaining a finite fallback. */
export function parseModelTaskTimeoutMs(
  raw: string | undefined,
  fallback = DEFAULT_MODEL_TASK_TIMEOUT_MS,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;

  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
