import { z } from 'zod';

export const EXTENSION_PROFILE_VERSION = 1 as const;
/** Per-run limits: what one launch may carry, whatever the library holds. */
export const EXTENSION_LIMITS = { servers: 8, tools: 64, bundles: 8, files: 256, bytes: 4 * 1024 * 1024, archiveBytes: 5 * 1024 * 1024, responseBytes: 1024 * 1024, calls: 256, egressBytes: 16 * 1024 * 1024, timeoutMs: 10_000 } as const;
export const extensionServerNameSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/).refine(v => v !== 'propr', 'Reserved server name');
export const extensionRepositorySchema = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
export const extensionAgentAliasSchema = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
/**
 * Legacy profile selection. Profiles were replaced by the extension library;
 * the shape remains only so queued New Task submissions recorded before the
 * upgrade still resolve through the migrated legacy mapping.
 */
export const extensionSelectionSchema = z.strictObject({ instanceId: z.uuid(), profileId: z.uuid(), revision: z.number().int().positive() });
export type ExtensionSelection = z.infer<typeof extensionSelectionSchema>;
export const remoteMcpSchema = z.strictObject({
  kind: z.literal('https'), name: extensionServerNameSchema, url: z.string().max(2048), enabled: z.boolean(),
  tools: z.array(z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/)).max(EXTENSION_LIMITS.tools),
  capability: z.enum(['read', 'write']), authentication: z.enum(['none', 'bearer', 'oauth']),
  /**
   * OAuth only: scopes to request at sign-in, and a client pre-registered with
   * the provider. The client secret is write-only, stored like a Bearer token.
   */
  scopes: z.array(z.string().regex(/^[\x21\x23-\x5b\x5d-\x7e]{1,256}$/)).max(32).optional(),
  clientId: z.string().regex(/^[\x21-\x7e]{1,512}$/).optional(),
});
export const catalogMcpSchema = z.strictObject({
  kind: z.literal('catalog'), name: extensionServerNameSchema, catalogId: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  digest: z.string().regex(/^[0-9a-f]{64}$/), enabled: z.boolean(),
  tools: remoteMcpSchema.shape.tools, capability: z.enum(['read', 'write']),
});
export const extensionMcpSchema = z.discriminatedUnion('kind', [remoteMcpSchema, catalogMcpSchema]);
export type ExtensionMcpDescriptor = z.infer<typeof extensionMcpSchema>;
/** Immutable selection metadata only; excludes transport, addresses, commands, paths, environment names/values and secret references. */
export interface ExtensionCatalogEntry {
  id: string; digest: string; tools: string[]; capability: 'read' | 'write';
  secrets: { count: number; configured: boolean };
}
export interface ExtensionSkillBundle {
  id: string; instanceId: string; digest: string; name: string; files: number; bytes: number;
  source: { kind: 'archive'; filename: string } | { kind: 'github'; repository: string; commit: string; directory: string };
  requirements: string[]; createdAt: number; auditActor: string;
}
/**
 * Configured state of a server's write-only credentials. Package servers list
 * the secret variables that hold a value in `configuredEnv`.
 */
export type ExtensionSecretStatus = { fields: ['bearerToken'] | ['clientSecret']; count?: never; configured: boolean } | { count: number; fields?: never; configured: boolean; configuredEnv?: string[] };

/** Legacy profile input, read only by the startup migration to the extension library. */
export interface LegacyExtensionProfileInput {
  version: 1; name: string; enabled: boolean; agentScope: string[]; repositoryScope: string[];
  mcpServers: ExtensionMcpDescriptor[]; skillBundleIds: string[];
}
/** Legacy profile revision snapshot, read only by the migration and native export. */
export interface LegacyExtensionProfileRevision extends ExtensionSelection, LegacyExtensionProfileInput {
  createdAt: number; updatedAt: number; auditActor: string;
  secrets: Record<string, ExtensionSecretStatus>;
  skillBundles: ExtensionSkillBundle[];
}

/** Remove implementation field names from catalog snapshots written by older versions. */
export function publicExtensionProfile<T extends { mcpServers?: { kind: string; name: string }[]; servers?: { kind: string; name: string }[]; secrets: Record<string, ExtensionSecretStatus> }>(snapshot: T): T {
  const secrets = { ...snapshot.secrets };
  for (const server of [...(snapshot.mcpServers ?? []), ...(snapshot.servers ?? [])]) {
    if (server.kind !== 'catalog' || !secrets[server.name]) continue;
    // Historical stored catalog snapshots can still contain private field names.
    const status = secrets[server.name] as { count?: number; fields?: string[]; configured: boolean };
    secrets[server.name] = { count: status.count ?? status.fields?.length ?? 0, configured: status.configured };
  }
  return { ...snapshot, secrets };
}
