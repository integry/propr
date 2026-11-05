import { z } from 'zod';

export const EXTENSION_PROFILE_VERSION = 1 as const;
export const EXTENSION_LIMITS = { servers: 8, tools: 64, bundles: 8, files: 256, bytes: 4 * 1024 * 1024, archiveBytes: 5 * 1024 * 1024, responseBytes: 1024 * 1024, calls: 256, egressBytes: 16 * 1024 * 1024, timeoutMs: 10_000 } as const;
const name = z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/).refine(v => v !== 'propr', 'Reserved server name');
const repository = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
export const extensionSelectionSchema = z.strictObject({ instanceId: z.uuid(), profileId: z.uuid(), revision: z.number().int().positive() });
export type ExtensionSelection = z.infer<typeof extensionSelectionSchema>;
export const remoteMcpSchema = z.strictObject({
  kind: z.literal('https'), name, url: z.string().max(2048), enabled: z.boolean(),
  tools: z.array(z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/)).max(EXTENSION_LIMITS.tools),
  capability: z.enum(['read', 'write']), authentication: z.enum(['none', 'bearer']),
});
export const catalogMcpSchema = z.strictObject({
  kind: z.literal('catalog'), name, catalogId: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
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
export const extensionProfileInputSchema = z.strictObject({
  version: z.literal(EXTENSION_PROFILE_VERSION), name: z.string().trim().min(1).max(100), enabled: z.boolean(),
  agentScope: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,100}$/)).max(64),
  repositoryScope: z.array(repository).max(64),
  mcpServers: z.array(extensionMcpSchema).max(EXTENSION_LIMITS.servers),
  skillBundleIds: z.array(z.uuid()).max(EXTENSION_LIMITS.bundles),
}).superRefine((v, ctx) => {
  if (new Set(v.mcpServers.map(s => s.name)).size !== v.mcpServers.length) ctx.addIssue({ code: 'custom', message: 'Duplicate server names' });
  if (new Set(v.skillBundleIds).size !== v.skillBundleIds.length) ctx.addIssue({ code: 'custom', message: 'Duplicate bundles' });
});
export type ExtensionProfileInput = z.infer<typeof extensionProfileInputSchema>;
export interface ExtensionSkillBundle {
  id: string; instanceId: string; digest: string; name: string; files: number; bytes: number;
  source: { kind: 'archive'; filename: string } | { kind: 'github'; repository: string; commit: string; directory: string };
  requirements: string[]; createdAt: number; auditActor: string;
}
export interface ExtensionProfileRevision extends ExtensionSelection, ExtensionProfileInput {
  createdAt: number; updatedAt: number; auditActor: string;
  secrets: Record<string, { fields: ['bearerToken']; count?: never; configured: boolean } | { count: number; fields?: never; configured: boolean }>;
  skillBundles: ExtensionSkillBundle[];
}
export const EXTENSION_PROFILE_CONTRACT = {
  version: EXTENSION_PROFILE_VERSION, limits: EXTENSION_LIMITS, runtimes: ['claude', 'codex'],
  transports: ['https', 'catalog'], localStdio: 'operator-installed-catalog-only',
  skills: ['tar', 'tar.gz', 'github-exact-commit'], permission: 'instance.manage_settings',
} as const;

/** Remove implementation field names from catalog snapshots written by older versions. */
export function publicExtensionProfile(snapshot: ExtensionProfileRevision): ExtensionProfileRevision {
  const secrets = { ...snapshot.secrets };
  for (const server of snapshot.mcpServers ?? []) {
    if (server.kind !== 'catalog' || !secrets[server.name]) continue;
    // Historical stored catalog snapshots can still contain private field names.
    const status = secrets[server.name] as { count?: number; fields?: string[]; configured: boolean };
    secrets[server.name] = { count: status.count ?? status.fields?.length ?? 0, configured: status.configured };
  }
  return { ...snapshot, secrets };
}
