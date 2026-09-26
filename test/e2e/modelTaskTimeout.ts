// Live coding-agent runs can legitimately spend more than 20 minutes on a task,
// especially when the provider is under load. Keep this comfortably below the
// model-matrix (60 minute) and nightly-job (120 minute) timeouts while leaving
// enough headroom for a slow, but still progressing, implementation.
export const DEFAULT_MODEL_TASK_TIMEOUT_MS = 30 * 60 * 1000;

/** Resolve the live model-task polling budget while always retaining a finite fallback. */
export function parseModelTaskTimeoutMs(
  raw: string | undefined,
  fallback = DEFAULT_MODEL_TASK_TIMEOUT_MS,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;

  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
