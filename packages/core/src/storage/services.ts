import type { StorageCandidate } from '@propr/shared';
import type { StorageLifecycle } from './lifecycle.js';
import type { StorageRoot } from './observation.js';
import type { auditRepository } from './repositorySafety.js';

export interface StorageServices {
  databaseFile?: string;
  lifecycle: StorageLifecycle;
  clonesRoot: string;
  storageRoot?: string;
  roots: StorageRoot[];
  /** Called under the lifecycle barrier. Any unavailable authority must return true or throw. */
  hasPendingTasks: () => Promise<boolean>;
  remoteToken?: () => Promise<string>;
  repositoryInventory?: () => Promise<string[]>;
  auditRepository?: typeof auditRepository;
  taskHistory?: {
    inspect(ids: string[]): Promise<Array<{ candidate: StorageCandidate; fingerprint: string | null }>>;
    erase(id: string, expected: string): Promise<boolean>;
  };
}

