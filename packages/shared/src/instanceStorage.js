/** Instance-local contract. Never contains host paths, filenames or credentials. */
export const INSTANCE_STORAGE_VERSION = 1;
/** Structured error code: the request was bound to a different instance or generation. */
export const STORAGE_INSTANCE_CHANGED_CODE = 'instance_changed';
/** Structured error code: the cleanup confirmation expired or was consumed; retrying it can never succeed. */
export const STORAGE_CONFIRMATION_INVALID_CODE = 'confirmation_invalid';
export const DEFAULT_STORAGE_POLICY = { enabled: false, idleHours: 24 };
