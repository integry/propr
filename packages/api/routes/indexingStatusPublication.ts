import { publishIndexingStatus } from '@propr/core';

interface PublishIndexingRunOptions {
  publisher: typeof publishIndexingStatus;
  repository: string;
  branch: string;
  phase: 'indexing' | 'idle';
  transition: { runId: string; transitionAt: string };
}

/** Never let ancillary notification projection change queue ownership results. */
export async function publishIndexingRunBestEffort(
  options: PublishIndexingRunOptions
): Promise<void> {
  try {
    await options.publisher(
      options.repository,
      options.branch,
      options.phase,
      options.transition
    );
  } catch (error) {
    console.warn(`Failed to publish ${options.phase} indexing run:`,
      error instanceof Error ? error.message : String(error));
  }
}
