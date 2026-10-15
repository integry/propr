import { createHash } from 'node:crypto';
import { z } from 'zod';

export const PROVIDER_AUTHORITY_CONTRACT = 'propr.hosted-provider-authority.v1' as const;
export const PROVIDER_AUTHORITY_MAX_LEASE_MS = 30_000;
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/);
export const providerSchema = z.enum(['claude', 'codex', 'antigravity', 'opencode']);
export const categorySchema = z.enum(['provider-credentials', 'provider-sessions']);
export const sourceSchema = z.enum(['config', 'login', 'run', 'probe', 'migration', 'callback', 'retry']);
export const authorityIdentitySchema = z.strictObject({
  tenantId: id, instanceId: id, predecessorGeneration: id, stateScope: id,
  runtimeGeneration: id, hostId: id, ownerEpoch: id, policyEpoch: id,
});
export type AuthorityIdentity = z.infer<typeof authorityIdentitySchema>;
export type Provider = z.infer<typeof providerSchema>;
export type Category = z.infer<typeof categorySchema>;

/** Symbolic managed resources, never paths, environment contents or operator credentials. */
const credentialResources = {
  claude: ['claude-home', 'claude-settings', 'tenant-env', 'tenant-api-key'],
  codex: ['codex-home', 'tenant-env', 'tenant-api-key'],
  antigravity: ['gemini-home', 'tenant-env', 'tenant-api-key'],
  opencode: ['opencode-config', 'opencode-data', 'tenant-env', 'tenant-api-key'],
} as const;
export const sessionKinds = ['launch', 'provider-login', 'provider-session', 'resume', 'conversation', 'retry-replacement', 'callback'] as const;
export const catalogResourceSchema = z.strictObject({
  key: id, provider: providerSchema, category: categorySchema, kind: id,
});
export type CatalogResource = z.infer<typeof catalogResourceSchema>;
export const PROVIDER_CATALOG: readonly Readonly<CatalogResource>[] = Object.freeze(
  providerSchema.options.flatMap(provider => [
    ...credentialResources[provider].map(kind => ({ key: `${provider}:credential:${kind}`, provider, category: 'provider-credentials' as const, kind })),
    ...sessionKinds.map(kind => ({ key: `${provider}:session:${kind}`, provider, category: 'provider-sessions' as const, kind })),
  ]).map(resource => Object.freeze(resource)),
);
export function classifyProviderCustody(origin: 'managed-tenant' | 'external-path' | 'process-environment' | 'shared-operator') {
  return origin === 'managed-tenant' ? 'requires-authority' as const : 'unowned-unqualified' as const;
}

export const issuerSchema = z.strictObject({
  issuerId: id, implementationRevision: id, catalogRevision: id,
  provider: providerSchema, agentKind: id, sourceKind: sourceSchema,
  resources: z.array(id).min(1),
});
export type Issuer = z.infer<typeof issuerSchema>;
export const enrollmentSchema = z.strictObject({
  identity: authorityIdentitySchema, catalogRevision: id, observerRevision: id, issuers: z.array(issuerSchema).min(1),
});
export type Enrollment = z.infer<typeof enrollmentSchema>;
export const reservationSchema = z.strictObject({
  identity: authorityIdentitySchema, issuer: issuerSchema, category: categorySchema,
  resourceKey: id, operationId: id, attemptId: id,
  replacementOf: id.optional(),
});
export type Reservation = z.infer<typeof reservationSchema>;
export const purposeSchema = z.enum(['config-mutation', 'credential-writer', 'credential-use', 'provider-launch']);
export type Purpose = z.infer<typeof purposeSchema>;
export const resetIntentSchema = z.strictObject({
  operationId: id, predecessor: authorityIdentitySchema, successor: authorityIdentitySchema,
});
export type ResetIntent = z.infer<typeof resetIntentSchema>;
export const readbackSchema = z.strictObject({
  identity: authorityIdentitySchema, binding: reservationSchema, recordId: id, incarnation: id, intentId: id,
  observerRevision: id,
  result: z.discriminatedUnion('state', [
    z.strictObject({ state: z.literal('unproven') }),
    z.strictObject({ state: z.literal('revoked-and-quiescent'), evidenceCommitment: z.string().regex(/^[0-9a-f]{64}$/) }),
  ]),
});
export type AuthorityReadback = z.infer<typeof readbackSchema>;

export class ProviderAuthorityRefusal extends Error {
  constructor() { super('provider_authority_unavailable'); }
}
export const refuseAuthority = (): never => { throw new ProviderAuthorityRefusal(); };
/** Never expose validation diagnostics: inputs may contain private custody data. */
export function parseProviderAuthority<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : refuseAuthority();
}
export function canonicalAuthority(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalAuthority).join(',')}]`;
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return refuseAuthority();
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalAuthority(object[key])}`).join(',')}}`;
}
export type AuthorityReadonly<T> = T extends readonly (infer U)[] ? readonly AuthorityReadonly<U>[]
  : T extends object ? { readonly [K in keyof T]: AuthorityReadonly<T[K]> } : T;
export function immutableAuthority<T>(value: T): AuthorityReadonly<T> {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) immutableAuthority(child);
    Object.freeze(value);
  }
  return value as AuthorityReadonly<T>;
}
export const AUTHORITY_SCHEMA = canonicalAuthority({
  contract: PROVIDER_AUTHORITY_CONTRACT, maxLeaseMs: PROVIDER_AUTHORITY_MAX_LEASE_MS,
  identity: z.toJSONSchema(authorityIdentitySchema), enrollment: z.toJSONSchema(enrollmentSchema),
  purpose: z.toJSONSchema(purposeSchema), issuer: z.toJSONSchema(issuerSchema),
  reservation: z.toJSONSchema(reservationSchema), reset: z.toJSONSchema(resetIntentSchema),
  readback: z.toJSONSchema(readbackSchema), catalog: PROVIDER_CATALOG,
});
export const PROVIDER_CATALOG_REVISION = createHash('sha256').update(AUTHORITY_SCHEMA).digest('hex');
export function validateEnrollment(value: unknown): Enrollment {
  const enrollment = parseProviderAuthority(enrollmentSchema, value);
  if (enrollment.catalogRevision !== PROVIDER_CATALOG_REVISION) return refuseAuthority();
  const seen = new Set<string>();
  const covered = new Set<string>();
  for (const issuer of enrollment.issuers) {
    if (seen.has(issuer.issuerId) || issuer.catalogRevision !== enrollment.catalogRevision
      || new Set(issuer.resources).size !== issuer.resources.length) return refuseAuthority();
    seen.add(issuer.issuerId);
    for (const key of issuer.resources) {
      const resource = PROVIDER_CATALOG.find(entry => entry.key === key && entry.provider === issuer.provider);
      if (!resource || (resource.category === 'provider-sessions' && issuer.sourceKind === 'config')
        || (resource.category === 'provider-credentials' && ['callback', 'retry'].includes(issuer.sourceKind))) return refuseAuthority();
      covered.add(key);
    }
  }
  if (PROVIDER_CATALOG.some(entry => !covered.has(entry.key))) return refuseAuthority();
  return enrollment;
}
