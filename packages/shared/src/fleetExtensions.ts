import { z } from 'zod';
import { canonicalFleetJson } from './fleetData.js';
import { extensionProfileInputSchema, extensionSelectionSchema } from './extensionProfiles.js';

export const FLEET_EXTENSION_CONTRACT = 'propr.fleet-extensions.v1' as const;
export const FLEET_EXTENSION_SCOPE = 'hosted_instance_extensions' as const;
export const FLEET_EXTENSION_LIMITS = { requestBytes: 256 * 1024, responseBytes: 256 * 1024, recipientSeconds: 60, ciphertextBytes: 4112, recipients: 64, operations: 4096 } as const;
const uuid = z.uuid();
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const opaque = z.string().regex(/^[A-Za-z0-9_-]+$/);
const selection = extensionSelectionSchema;
// Bound remote scopes independently of the transport cap; native input remains unchanged.
export const fleetExtensionProfileInputSchema = extensionProfileInputSchema.safeExtend({
  repositoryScope: z.array(z.string().max(200).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)).max(64),
});
const create = z.strictObject({ action: z.literal('profile.create'), input: fleetExtensionProfileInputSchema });
const update = z.strictObject({ action: z.literal('profile.update'), input: fleetExtensionProfileInputSchema, selection });
export const fleetExtensionIntentSchema = z.discriminatedUnion('action', [create, update]);
export type FleetExtensionIntent = z.infer<typeof fleetExtensionIntentSchema>;
const sealed = z.array(z.strictObject({ recipientId: uuid, publicKey: opaque.length(87), iv: opaque.length(16), ciphertext: opaque.max(5483) })).max(8);
export const fleetExtensionRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('profile.list') }),
  z.strictObject({ action: z.literal('profile.read'), selection }),
  z.strictObject({ action: z.literal('profile.history'), profileId: uuid }),
  create.extend({ sealed }), update.extend({ sealed }),
  z.strictObject({ action: z.literal('profile.disable'), selection }),
  z.strictObject({ action: z.literal('profile.delete'), selection }),
  z.strictObject({ action: z.literal('catalog.list') }),
  z.strictObject({ action: z.literal('skill.list') }),
  z.strictObject({ action: z.literal('skill.import'), repository: z.string().max(200).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), commit: z.string().regex(/^[0-9a-f]{40}$/), directory: z.string().min(1).max(240) }),
  z.strictObject({ action: z.literal('profile.validate'), selection }),
  z.strictObject({ action: z.literal('selection.validate'), selection, context: z.strictObject({ agentAlias: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), runtime: z.enum(['claude', 'codex']), repositories: z.array(z.string().max(200).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)).max(64), allowWrite: z.boolean() }) }),
  z.strictObject({ action: z.literal('recipient.issue'), intent: fleetExtensionIntentSchema, mutationOperationId: uuid, server: z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/), field: z.literal('bearerToken') }),
  z.strictObject({ action: z.literal('operation.status'), targetOperationId: uuid }),
]);
export const fleetExtensionAssertionSchema = z.strictObject({
  contract: z.literal(FLEET_EXTENSION_CONTRACT), contractPin: hash, scope: z.literal(FLEET_EXTENSION_SCOPE),
  hostedInstanceId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), storageInstanceId: uuid,
  runtimeGeneration: uuid, storageGeneration: uuid, placementGeneration: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  githubActorId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  action: fleetExtensionRequestSchema.options.reduce((schema, option) => schema.or(option.shape.action), z.never() as z.ZodType<string>),
  requestDigest: hash, operationId: uuid, nonce: hash, issuedAt: z.number().int().nonnegative(), expiresAt: z.number().int().nonnegative(),
});
export const fleetExtensionEnvelopeSchema = z.strictObject({ assertion: fleetExtensionAssertionSchema, request: fleetExtensionRequestSchema, mac: hash });
export type FleetExtensionAssertion = z.infer<typeof fleetExtensionAssertionSchema>;
export type FleetExtensionRequest = z.infer<typeof fleetExtensionRequestSchema>;
export const fleetExtensionRecipientBindingSchema = z.strictObject({
  contract: z.literal(FLEET_EXTENSION_CONTRACT), audience: z.literal('core-extension-mutation'), assertion: fleetExtensionAssertionSchema,
  extensionInstanceId: uuid, action: z.enum(['profile.create', 'profile.update']), intentDigest: hash,
  target: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('create'), intentDigest: hash }), z.strictObject({ kind: z.literal('revision'), selection })]),
  mutationOperationId: uuid, server: z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/), field: z.literal('bearerToken'), recipientId: uuid, expiresAt: z.number().int().nonnegative(),
});
export const fleetExtensionRecipientSchema = z.strictObject({
  recipientId: uuid, algorithm: z.literal('P-256-ECDH/HKDF-SHA256/AES-256-GCM'), publicKey: opaque.length(87), binding: fleetExtensionRecipientBindingSchema, signature: opaque.length(86),
});
export type FleetExtensionRecipient = z.infer<typeof fleetExtensionRecipientSchema>;
export const FLEET_EXTENSION_SCHEMA = canonicalFleetJson({
  contract: FLEET_EXTENSION_CONTRACT, envelope: z.toJSONSchema(fleetExtensionEnvelopeSchema), limits: FLEET_EXTENSION_LIMITS,
  canonical: 'sorted-keys-utf8-json', authentication: 'HMAC-SHA256-canonical-assertion', assertionSeconds: 60, clockSkewSeconds: 5,
  secret: 'P-256-ECDH/HKDF-SHA256/AES-256-GCM', secretEncoding: 'base64url-unpadded', secretPlaintext: 'printable-ASCII-1..4096-padded-with-zero-to-4096',
  secretAAD: 'canonical-recipient-binding', recipientAuthentication: 'Ed25519-independent-native-SPKI-pin-and-exact-expected-binding', secretHKDF: { salt: 'UTF8-recipientId', info: 'UTF8-propr.fleet-extensions.v1' },
  skills: { exactGit: true, upload: false }, error: 'fleet_extensions_unavailable',
  mutationResponsePreflight: { actions: ['profile.create', 'profile.update', 'profile.disable'], policy: 'exact-completed-response-within-responseBytes-before-transaction-commit' },
  result: ['contract', 'operationId', 'state=completed', 'result'], recipient: z.toJSONSchema(fleetExtensionRecipientSchema),
  projections: {
    'profile.list': ['instanceId', 'profiles=public-ExtensionProfileRevision[]'],
    'profile.read|profile.create|profile.update|profile.disable': ['profile=public-ExtensionProfileRevision'],
    'profile.history': ['revisions=public-ExtensionProfileRevision[]'], 'profile.delete': ['deleted=true'],
    'catalog.list': ['catalog=public-ExtensionCatalogEntry[]'], 'skill.list': ['bundles=ExtensionSkillBundle[]'], 'skill.import': ['bundle=ExtensionSkillBundle'],
    'profile.validate': ['results=[{name,status=reachable|unavailable|not_validated}]'],
    'selection.validate': ['selection=ExtensionSelection', 'valid=true'], 'operation.status': ['operationId', 'state=completed|fenced'],
  }, downstreamReady: false,
});

/** Browser WebCrypto producer. Only opaque ciphertext leaves the browser. Fixed padding hides token length. */
export async function encryptFleetExtensionSecret(recipient: { recipientId: string; algorithm: string; publicKey: string; binding: Record<string, unknown>; signature: string }, token: string, trust: { verificationKey: string; expectedBinding: Record<string, unknown> }, cryptoProvider = globalThis.crypto) {
  if (!/^[\x21-\x7e]{1,4096}$/.test(token)) throw new Error('Invalid secret');
  const decode = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  const encode = (bytes: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const { signature, ...signed } = recipient;
  if (recipient.algorithm !== 'P-256-ECDH/HKDF-SHA256/AES-256-GCM' || canonicalFleetJson(trust.expectedBinding) !== canonicalFleetJson(recipient.binding)) throw new Error('Recipient unavailable');
  const verificationKey = await cryptoProvider.subtle.importKey('spki', decode(trust.verificationKey), 'Ed25519', false, ['verify']);
  if (!await cryptoProvider.subtle.verify('Ed25519', verificationKey, decode(signature), new TextEncoder().encode(canonicalFleetJson(signed)))) throw new Error('Recipient unavailable');
  const publicKey = await cryptoProvider.subtle.importKey('raw', decode(recipient.publicKey), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const pair = await cryptoProvider.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const shared = await cryptoProvider.subtle.deriveBits({ name: 'ECDH', public: publicKey }, pair.privateKey, 256);
  const material = await cryptoProvider.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']); new Uint8Array(shared).fill(0);
  const utf8 = new TextEncoder();
  const key = await cryptoProvider.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: utf8.encode(recipient.recipientId), info: utf8.encode(FLEET_EXTENSION_CONTRACT) }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const iv = cryptoProvider.getRandomValues(new Uint8Array(12)); const padded = new Uint8Array(4096); padded.set(utf8.encode(token));
  try {
    const ciphertext = await cryptoProvider.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8.encode(canonicalFleetJson(recipient.binding)), tagLength: 128 }, key, padded);
    return { recipientId: recipient.recipientId, publicKey: encode(await cryptoProvider.subtle.exportKey('raw', pair.publicKey)), iv: encode(iv), ciphertext: encode(ciphertext) };
  } finally { padded.fill(0); }
}
