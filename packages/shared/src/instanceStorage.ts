/** Instance-local contract. Never contains host paths, filenames or credentials. */
export const INSTANCE_STORAGE_VERSION = 1 as const;
/** Structured error code: the request was bound to a different instance or generation. */
export const STORAGE_INSTANCE_CHANGED_CODE = 'instance_changed' as const;
/** Structured error code: the cleanup confirmation expired or was consumed; retrying it can never succeed. */
export const STORAGE_CONFIRMATION_INVALID_CODE = 'confirmation_invalid' as const;
/** Storage error body; `code` is authoritative where present, `error` is display text only. */
export interface StorageErrorBody { error: string; code?: typeof STORAGE_INSTANCE_CHANGED_CODE | typeof STORAGE_CONFIRMATION_INVALID_CODE }
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
  /** Validated repository identity, when this candidate is a repository cache. */
  name?: string;
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

/** Additive capability negotiation; older v1 runtimes need not support these features. */
export interface StorageCapabilities {
  version: 1;
  instanceId: string;
  generation: string;
  features: Array<'repository_inventory' | 'database_export' | 'repository_cleanup'>;
}
export interface RepositoryStorageInventory {
  version: 1;
  instanceId: string;
  state: StorageState;
  observedAt: string;
  /** Conservative instance-wide use clock, not filesystem mtime. */
  lastUseAt: string | null;
  repositories: Array<StorageCandidate & { name: string }>;
}
export interface DatabaseExportStatus {
  version: 1;
  instanceId: string;
  generation: string;
  operationId: string;
  state: 'running' | 'ready' | 'failed' | 'redeemed';
  expiresAt: string;
  scope: 'customer_database';
  sizeBytes?: number;
  sha256?: string;
  schemaVersion?: number;
  migration?: string | null;
}
