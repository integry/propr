import { STORAGE_CONFIRMATION_INVALID_CODE, STORAGE_INSTANCE_CHANGED_CODE, type StorageCategory, type StorageCleanupPreview, type StorageErrorBody } from '@propr/shared';
import type { StorageAuthority } from './databaseExport.js';
import type { CacheRecord } from './registry.js';

export class StorageContractError extends Error {
  constructor(readonly status: number, message: string, readonly code?: StorageErrorBody['code']) { super(message); }
}
export const instanceSelectionChanged = () => new StorageContractError(409, 'Instance selection changed', STORAGE_INSTANCE_CHANGED_CODE);
export const confirmationInvalid = (message: string) => new StorageContractError(409, message, STORAGE_CONFIRMATION_INVALID_CODE);
// Preserve existing positional callers, including the optional task selection.
export type CleanupPreviewArgs = [instanceId: string, categories: StorageCategory[], actor: string, taskIds?: string[], authorize?: StorageAuthority];
export interface CleanupPreviewRequest {
  instanceId: string;
  categories: StorageCategory[];
  actor: string;
  taskIds: string[];
  authorize?: StorageAuthority;
}
export interface CandidateExecution {
  record: CacheRecord | undefined;
  fingerprint: string;
  signal: AbortSignal;
  authorize?: StorageAuthority;
}

export function validatePreviewSelection({ categories, taskIds }: CleanupPreviewRequest): void {
  if (taskIds.length > 10 || new Set(taskIds).size !== taskIds.length || taskIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,255}$/.test(id))) throw new StorageContractError(400, 'Invalid task selection');
  if (taskIds.length && !categories.includes('task_history')) throw new StorageContractError(400, 'Task selection requires task_history category');
  if (!categories.length || new Set(categories).size !== categories.length || categories.length > 7) throw new StorageContractError(400, 'Select explicit categories');
}

export interface SavedPreview {
  actor: string;
  preview: StorageCleanupPreview;
  fingerprints: Record<string, string>;
  useClock: number | null;
  generation: string;
}
