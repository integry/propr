/** Public diagnostics runtime (`@propr/core/diagnostics`). Root daemon and
 * scripts import this entry, never relative source paths, so the process shares
 * the logger's module instance, spool singleton and credential cache. */
export { managedDiagnostics, nativeDiagnosticStatus, diagnosticsFailure, providerCredentialRoot, flushApplicationRecords } from './managedLogRuntime.js';
export { ManagedLogSpool, DiagnosticPolicyError, MANAGED_LOG_POLICY, MANAGED_LOG_POLICY_MIGRATIONS } from './managedLogSpool.js';
export type { ManagedLogPolicy, ManagedLogPolicyMigration, LogIdentity } from './managedLogSpool.js';
export { collectProvider } from './providerCollector.js';
export { supportedProviderOwners, providerOwnershipStatus, AGENT_CONTAINER_UID } from './providerOwnership.js';
