/** Instance-local contract. Never contains host paths, filenames or credentials. */
export const INSTANCE_STORAGE_VERSION = 1 as const;
export type StorageCategory = 'database_config' | 'repository_caches' | 'worktrees' | 'salvage' | 'logs_artifacts' | 'provider_credentials' | 'task_history';
export type StorageState = 'complete' | 'partial' | 'unknown' | 'unsupported';
export interface StorageObservation {
  version: 1;
  instanceId: string;
  observedAt: string | null;
  state: StorageState;
  scanning: boolean;
  ownedBytes: number | null;
  categories: Array<{ category: StorageCategory; bytes: number | null; state: StorageState }>;
  filesystems: Array<{ id: string; totalBytes: number; availableBytes: number }>;
}
export interface StoragePolicy { enabled: boolean; idleHours: number }
export const DEFAULT_STORAGE_POLICY: StoragePolicy = { enabled: false, idleHours: 24 };
export type StorageProtection = 'busy' | 'unknown_use' | 'recent_use' | 'unknown_ownership' | 'unsafe_path' | 'private_work' | 'worktrees' | 'local_history' | 'salvage' | 'remote_unavailable' | 'unknown_git_state' | 'changed' | 'unsupported';
export interface StorageCandidate {
  id: string;
  category: StorageCategory;
  estimatedBytes: number | null;
  protectedReasons: StorageProtection[];
}
export interface StorageCleanupPreview {
  version: 1;
  instanceId: string;
  confirmation: string;
  expiresAt: string;
  categories: StorageCategory[];
  candidates: StorageCandidate[];
  impact: string;
}
export interface StorageCleanupResult {
  version: 1;
  instanceId: string;
  operationId: string;
  state: 'completed' | 'interrupted';
  deleted: string[];
  retained: Array<{ id: string; reasons: StorageProtection[] }>;
}
