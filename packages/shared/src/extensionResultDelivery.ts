import { z } from 'zod';
import { canonicalFleetJson as canonical } from './fleetData.js';
import { authorityV2ResponseSchema, type AuthorityV2Request } from './extensionAuthorityV2.js';
import { EXTENSION_LIMITS, extensionSelectionSchema } from './extensionProfiles.js';
import { FLEET_EXTENSION_CONTRACT, FLEET_EXTENSION_LIMITS, fleetExtensionProfileInputSchema, fleetExtensionRecipientSchema, fleetExtensionSkillBundleSchema, type FleetExtensionRequest } from './fleetExtensions.js';

export const EXTENSION_RESULT_DELIVERY = 'propr.extension-result-delivery.v1' as const;
export const EXTENSION_RESULT_DELIVERY_LIMITS = { nativeBytes: FLEET_EXTENSION_LIMITS.responseBytes, responseBytes: 288 * 1024, entries: 4096 } as const;
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const name = z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/);
const bundle = fleetExtensionSkillBundleSchema.extend({
  name: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), files: z.number().int().nonnegative().max(EXTENSION_LIMITS.files),
  bytes: z.number().int().nonnegative().max(EXTENSION_LIMITS.bytes),
  source: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('github'), repository: z.string().max(200), commit: z.string().regex(/^[0-9a-f]{40}$/), directory: z.string().max(240) }),
    z.strictObject({ kind: z.literal('archive'), filename: z.string().max(240) }),
  ]), requirements: z.array(z.string().max(256)).max(64), createdAt: time, auditActor: z.string().regex(/^[1-9][0-9]{0,19}$/),
});
const profile = fleetExtensionProfileInputSchema.safeExtend({
  ...extensionSelectionSchema.shape, createdAt: time, updatedAt: time, auditActor: z.string().regex(/^[1-9][0-9]{0,19}$/),
  secrets: z.record(name, z.union([
    z.strictObject({ fields: z.tuple([z.literal('bearerToken')]).meta({ minItems: 1, maxItems: 1 }), configured: z.boolean() }),
    z.strictObject({ count: z.number().int().nonnegative().max(64), configured: z.boolean() }),
  ])).refine(v => Object.keys(v).length <= EXTENSION_LIMITS.servers).meta({ maxProperties: EXTENSION_LIMITS.servers }),
  skillBundles: z.array(bundle).max(EXTENSION_LIMITS.bundles),
});
const catalog = z.strictObject({ id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), digest: hash,
  tools: z.array(z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/)).max(EXTENSION_LIMITS.tools), capability: z.enum(['read', 'write']),
  secrets: z.strictObject({ count: z.number().int().nonnegative().max(64), configured: z.boolean() }),
});
const list = <T extends z.ZodType>(s: T) => z.array(s).max(EXTENSION_RESULT_DELIVERY_LIMITS.entries);
/** Public projection vocabulary only. No arbitrary objects or native diagnostics. */
export const extensionPublicResultSchemas = {
  'profile.list': z.strictObject({ instanceId: z.uuid(), profiles: list(profile) }),
  'profile.read': z.strictObject({ profile }), 'profile.create': z.strictObject({ profile }),
  'profile.update': z.strictObject({ profile }), 'profile.disable': z.strictObject({ profile }),
  'profile.history': z.strictObject({ revisions: list(profile) }), 'profile.delete': z.strictObject({ deleted: z.literal(true) }),
  'catalog.list': z.strictObject({ catalog: list(catalog) }), 'skill.list': z.strictObject({ bundles: list(bundle) }),
  'skill.import': z.strictObject({ bundle }),
  'profile.validate': z.strictObject({ results: z.array(z.strictObject({ name, status: z.enum(['reachable', 'unavailable', 'not_validated']) })).max(EXTENSION_LIMITS.servers) }),
  'selection.validate': z.strictObject({ selection: extensionSelectionSchema, valid: z.literal(true) }),
  'recipient.issue': fleetExtensionRecipientSchema,
  'operation.status': z.strictObject({ operationId: z.uuid(), state: z.enum(['completed', 'fenced']) }),
} as const;
const nativeEnvelope = (result: z.ZodType) => z.strictObject({ contract: z.literal(FLEET_EXTENSION_CONTRACT), operationId: z.uuid(), state: z.literal('completed'), result });
const available = Object.entries(extensionPublicResultSchemas).map(([action, result]) => z.strictObject({ state: z.literal('available'), action: z.literal(action), native: nativeEnvelope(result) }));
export const extensionResultDeliverySchema = z.strictObject({
  contract: z.literal(EXTENSION_RESULT_DELIVERY), receipt: authorityV2ResponseSchema,
  delivery: z.union([z.strictObject({ state: z.literal('unavailable') }), ...available]),
});
export type ExtensionResultDelivery = z.infer<typeof extensionResultDeliverySchema>;
export const EXTENSION_RESULT_DELIVERY_SCHEMA = canonical({
  contract: EXTENSION_RESULT_DELIVERY, response: z.toJSONSchema(extensionResultDeliverySchema), limits: EXTENSION_RESULT_DELIVERY_LIMITS,
  path: '/extensions/authority/v2/invoke', canonical: 'sorted-keys-utf8-json',
  delivery: 'first-completed-dispatch-only-after-SQLite-commit', replay: 'retained-receipt-delivery-unavailable',
  publicReady: false, downstreamReady: false, selectedRuntimeQualified: false,
});

/** Validate against caller-retained coordinates, never response-selected expectations.
 * The caller must independently verify the v2 receipt and recipient Ed25519 signatures. */
export function parseExtensionResultDelivery(raw: string, expected: AuthorityV2Request, native: FleetExtensionRequest | undefined,
  digest: (value: unknown) => string, verifyRecipient: (recipient: z.infer<typeof fleetExtensionRecipientSchema>) => void): ExtensionResultDelivery {
  try {
    const bytes = (s: string) => new TextEncoder().encode(s).length;
    if (bytes(raw) > EXTENSION_RESULT_DELIVERY_LIMITS.responseBytes) throw Error();
    const value = extensionResultDeliverySchema.parse(JSON.parse(raw));
    const { receipt, delivery } = value;
    if (canonical(value) !== raw || canonical(receipt.statement.request) !== canonical(expected)) throw Error();
    if (delivery.state === 'unavailable') return value;
    const a = expected.work.extension;
    if (!native || expected.phase !== 'dispatch' || receipt.statement.result.state !== 'completed'
      || native.action !== a.action || digest(native) !== a.requestDigest || delivery.action !== native.action
      || delivery.native.operationId !== a.operationId || bytes(canonical(delivery.native)) > EXTENSION_RESULT_DELIVERY_LIMITS.nativeBytes
      || digest(delivery.native) !== receipt.statement.result.nativeResultDigest) throw Error();
    // The action-specific schema is selected using the retained native request.
    extensionPublicResultSchemas[native.action].parse(delivery.native.result);
    const result = delivery.native.result as Record<string, any>;
    const checkProfile = (p: any) => {
      if (p.instanceId !== expected.work.extensionInstanceId || p.name.trim() !== p.name
        || new Set(p.mcpServers.map((s: any) => s.name)).size !== p.mcpServers.length
        || new Set(p.skillBundleIds).size !== p.skillBundleIds.length || Object.keys(p.secrets).length > EXTENSION_LIMITS.servers) throw Error();
      for (const server of p.mcpServers) if (server.kind === 'https') {
        const url = new URL(server.url);
        if (!server.url.startsWith('https://') || /[?#]/.test(server.url) || url.username || url.password || (url.port && url.port !== '443')) throw Error();
      }
      for (const b of p.skillBundles) if (b.instanceId !== expected.work.extensionInstanceId) throw Error();
    };
    if (result.profile) checkProfile(result.profile);
    for (const p of result.profiles ?? result.revisions ?? []) checkProfile(p);
    for (const b of result.bundles ?? (result.bundle ? [result.bundle] : [])) if (b.instanceId !== expected.work.extensionInstanceId) throw Error();
    if (native.action === 'profile.list' && result.instanceId !== expected.work.extensionInstanceId) throw Error();
    if (native.action === 'profile.history' && result.revisions.some((p: any) => p.profileId !== native.profileId)) throw Error();
    if (native.action === 'profile.read' && canonical(extensionSelectionSchema.parse({ instanceId: result.profile.instanceId, profileId: result.profile.profileId, revision: result.profile.revision })) !== canonical(native.selection)) throw Error();
    if ((native.action === 'profile.update' || native.action === 'profile.disable') && (result.profile.profileId !== native.selection.profileId || result.profile.revision !== native.selection.revision + 1)) throw Error();
    if (native.action === 'selection.validate' && canonical(result.selection) !== canonical(native.selection)) throw Error();
    if (native.action === 'operation.status' && result.operationId !== native.targetOperationId) throw Error();
    if (native.action === 'skill.import' && canonical(result.bundle.source) !== canonical({ kind: 'github', repository: native.repository, commit: native.commit, directory: native.directory })) throw Error();
    if (native.action === 'recipient.issue') {
      const p = fleetExtensionRecipientSchema.parse(delivery.native.result);
      // Require canonical unpadded P-256 SEC1 public material and Ed25519 bytes.
      if (!/^B[A-Za-z0-9_-]{85}[AEIMQUYcgkosw048]$/.test(p.publicKey) || !/^[A-Za-z0-9_-]{85}[AQgw]$/.test(p.signature)) throw Error();
      const intentDigest = digest(native.intent);
      const commitment = { operationId: native.mutationOperationId, intentDigest };
      const binding = { contract: FLEET_EXTENSION_CONTRACT, audience: 'core-extension-mutation', assertion: a,
        extensionInstanceId: expected.work.extensionInstanceId, action: native.intent.action, intentDigest,
        target: native.intent.action === 'profile.update' ? { kind: 'revision', selection: native.intent.selection } : { kind: 'create', intentDigest },
        mutationOperationId: native.mutationOperationId, server: native.server, field: native.field, recipientId: p.recipientId, expiresAt: a.expiresAt };
      if (canonical(commitment) !== canonical(receipt.statement.result.recipientCommitment) || canonical(binding) !== canonical(p.binding)) throw Error();
      verifyRecipient(p);
    }
    return value;
  } catch { throw Error('extension_result_delivery_unavailable'); }
}
