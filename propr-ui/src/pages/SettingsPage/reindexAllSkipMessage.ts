import type { TriggerReindexAllResponse } from '../../api/proprApi';

export function buildReindexAllSkipMessage(result: TriggerReindexAllResponse): string {
  const skippedCooldown = result.repositoriesSkippedCooldown ?? 0;
  const skippedAlreadyQueued = result.repositoriesSkippedAlreadyQueued ?? 0;
  const failedClone = result.repositoriesFailedClone ?? 0;
  const skipped = [
    skippedCooldown > 0 ? `${skippedCooldown} in cooldown` : '',
    skippedAlreadyQueued > 0 ? `${skippedAlreadyQueued} already queued` : '',
    failedClone > 0 ? `${failedClone} failed clone` : ''
  ].filter(Boolean).join(', ');
  return skipped
    ? `No repositories were queued for reindexing (${skipped}).`
    : 'No repositories were queued for reindexing.';
}
