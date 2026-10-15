import type { Knex } from 'knex';
import { createECDH, createDecipheriv, hkdfSync, randomUUID, createHmac, timingSafeEqual, createPrivateKey, createPublicKey, sign, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { canonicalFleetJson, FLEET_EXTENSION_CONTRACT, FLEET_EXTENSION_SCHEMA, FLEET_EXTENSION_LIMITS, fleetExtensionEnvelopeSchema, type FleetExtensionAssertion, type FleetExtensionRequest, fleetExtensionRecipientSchema, fleetExtensionSkillBundleSchema } from '@propr/shared';
import { digest, FleetRefusal } from './contract.js';
import type { FleetDataPlane } from './dataPlane.js';
import type { ExtensionProfileStore } from '../extensions/extensionProfileStore.js';
import { importExactGitSkill } from '../extensions/remoteGitSkill.js';
import { requestExtensionMcp } from '../extensions/endpointPolicy.js';
import { unsealExtensionSecrets } from '../extensions/privateSecrets.js';

export const extensionContractPin = digest(JSON.parse(FLEET_EXTENSION_SCHEMA));
export class ExtensionRefusal extends Error { constructor() { super('fleet_extensions_unavailable'); } }
interface Recipient {
  assertion: FleetExtensionAssertion; server: string; privateKey: Buffer;
  binding: Record<string, unknown>; timer: NodeJS.Timeout; authorityDigest: string;
}
interface RecordResult { contract: typeof FLEET_EXTENSION_CONTRACT; operationId: string; state: 'completed' | 'fenced'; result?: unknown }
const sameAudience = (a: FleetExtensionAssertion, b: FleetExtensionAssertion) => ['githubActorId', 'hostedInstanceId', 'storageInstanceId', 'runtimeGeneration', 'storageGeneration', 'placementGeneration'].every(k => a[k as keyof typeof a] === b[k as keyof typeof b]);

/** Core-only keys in volatile memory. Durable records contain outcome metadata, never requests or ciphertext. */
export class FleetExtensionPlane {
  private recipients = new Map<string, Recipient>();
  private slots = 0;
  private stopped = false;
  private ready: Promise<void>;
  constructor(readonly fleet: FleetDataPlane, readonly store: ExtensionProfileStore) {
    this.ready = fs.readdir(fleet.files.root).then(names => { this.slots = names.filter(n => n.startsWith('extension-')).length; });
  }
  private async recipientSigningKey(instanceId?: string) {
    const env = this.store.environment;
    const root = env.PROPR_CREDENTIAL_ENCRYPTION_KEY?.trim() || env.SYSTEM_TASK_SECRET?.trim() || env.SESSION_SECRET?.trim();
    if (!root) throw new FleetRefusal();
    const seed = createHash('sha256').update('propr.fleet-extensions.v1.recipient-signing\0').update(instanceId ?? await this.store.instanceId()).update('\0').update(root).digest();
    try { return createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' }); }
    finally { seed.fill(0); }
  }
  /** Provision this public key through an independently authenticated native/operator channel, never trust a relay's pin. */
  async recipientVerificationKey(instanceId?: string) { return createPublicKey(await this.recipientSigningKey(instanceId)).export({ format: 'der', type: 'spki' }).toString('base64url'); }
  shutdown() { this.stopped = true; for (const id of this.recipients.keys()) this.destroyRecipient(id); }
  private destroyRecipient(id: string) {
    const recipient = this.recipients.get(id);
    if (recipient) { this.recipients.delete(id); clearTimeout(recipient.timer); recipient.privateKey.fill(0); }
  }
  private async authorize(a: FleetExtensionAssertion, database?: Knex) {
    if (this.stopped) throw new FleetRefusal();
    const secret = await this.fleet.extensionAuthority(a, database);
    await this.store.authorize(String(a.githubActorId), database);
    // Extension identity and storage identity are independently bound; selections are checked by the native store.
    if (this.stopped || secret !== await this.fleet.extensionAuthority(a, database)) throw new FleetRefusal();
    return secret;
  }
  private async issue(a: FleetExtensionAssertion, r: Extract<FleetExtensionRequest, { action: 'recipient.issue' }>, rawIntent: unknown) {
    const intentDigest = digest(rawIntent);
    const authority = await this.authorize(a);
    if (r.intent.action === 'profile.update') await this.store.read(String(a.githubActorId), r.intent.selection);
    const server = r.intent.input.mcpServers.find(s => s.name === r.server);
    if (!server || server.kind !== 'https' || server.authentication !== 'bearer') throw new FleetRefusal();
    const recipientId = randomUUID(); const key = createECDH('prime256v1'); key.generateKeys();
    const privateKey = key.getPrivateKey();
    let retained = false;
    try {
      const binding = { contract: FLEET_EXTENSION_CONTRACT, audience: 'core-extension-mutation', assertion: a, extensionInstanceId: await this.store.instanceId(), action: r.intent.action,
        intentDigest, target: r.intent.action === 'profile.update' ? { kind: 'revision', selection: r.intent.selection } : { kind: 'create', intentDigest }, mutationOperationId: r.mutationOperationId, server: r.server, field: r.field, recipientId, expiresAt: a.expiresAt };
      if (this.stopped || this.recipients.size >= FLEET_EXTENSION_LIMITS.recipients) throw new FleetRefusal();
      const publicRecipient = { recipientId, algorithm: 'P-256-ECDH/HKDF-SHA256/AES-256-GCM', publicKey: key.getPublicKey().toString('base64url'), binding };
      const signature = sign(null, Buffer.from(canonicalFleetJson(publicRecipient)), await this.recipientSigningKey()).toString('base64url');
      if (this.stopped || this.recipients.size >= FLEET_EXTENSION_LIMITS.recipients) throw new FleetRefusal();
      const response = fleetExtensionRecipientSchema.parse({ ...publicRecipient, signature });
      const timer = setTimeout(() => this.destroyRecipient(recipientId), Math.max(1, a.expiresAt * 1000 - Date.now())); timer.unref();
      this.recipients.set(recipientId, { assertion: a, server: r.server, privateKey, binding, timer, authorityDigest: digest(authority) });
      retained = true;
      return response;
    } finally { if (!retained) privateKey.fill(0); }
  }
  private async decrypt(a: FleetExtensionAssertion, r: Extract<FleetExtensionRequest, { action: 'profile.create' | 'profile.update' }>, rawIntent: unknown) {
    const intentDigest = digest(rawIntent);
    const replacements: Record<string, string> = {};
    // Claim ALL recipients before the first await. Even a malformed/substituted attempt burns the recipient.
    const claimed = r.sealed.map(s => { const recipient = this.recipients.get(s.recipientId); this.recipients.delete(s.recipientId); if (recipient) clearTimeout(recipient.timer); return { s, recipient }; });
    try {
      for (const { s, recipient: p } of claimed) {
        if (!p || !sameAudience(a, p.assertion) || p.binding.mutationOperationId !== a.operationId || p.binding.intentDigest !== intentDigest
          || p.assertion.expiresAt * 1000 <= Date.now() || p.binding.extensionInstanceId !== await this.store.instanceId() || Object.hasOwn(replacements, p.server)) throw new FleetRefusal();
        const authority = await this.authorize(p.assertion); await this.authorize(a);
        if (digest(authority) !== p.authorityDigest) throw new FleetRefusal();
        const ecdh = createECDH('prime256v1'); ecdh.setPrivateKey(p.privateKey);
        const shared = ecdh.computeSecret(Buffer.from(s.publicKey, 'base64url'));
        const key = Buffer.from(hkdfSync('sha256', shared, Buffer.from(s.recipientId), Buffer.from(FLEET_EXTENSION_CONTRACT), 32)); shared.fill(0);
        const ciphertext = Buffer.from(s.ciphertext, 'base64url'); const iv = Buffer.from(s.iv, 'base64url');
        if (ciphertext.length !== FLEET_EXTENSION_LIMITS.ciphertextBytes || iv.length !== 12) { key.fill(0); throw new FleetRefusal(); }
        const decipher = createDecipheriv('aes-256-gcm', key, iv); key.fill(0);
        decipher.setAAD(Buffer.from(canonicalFleetJson(p.binding))); decipher.setAuthTag(ciphertext.subarray(-16));
        let intermediate: Buffer | undefined; let plain: Buffer;
        try { intermediate = decipher.update(ciphertext.subarray(0, -16)); plain = Buffer.concat([intermediate, decipher.final()]); }
        finally { intermediate?.fill(0); }
        try {
          const end = plain.indexOf(0); const length = end < 0 ? plain.length : end;
          if (!length || plain.subarray(length).some(byte => byte !== 0) || plain.subarray(0, length).some(byte => byte < 33 || byte > 126)) throw new FleetRefusal();
          replacements[p.server] = plain.subarray(0, length).toString('ascii');
        } finally { plain.fill(0); }
      }
      return replacements;
    } finally { for (const { recipient } of claimed) recipient?.privateKey.fill(0); }
  }
  private async dispatch(a: FleetExtensionAssertion, r: FleetExtensionRequest, rawIntent: unknown): Promise<unknown> {
    const actor = String(a.githubActorId); const guard = async (database?: Knex) => { await this.authorize(a, database); };
    const preflightProfile = (profile: unknown) => { this.response(a, { profile }); };
    await guard();
    switch (r.action) {
      case 'profile.list': return { instanceId: await this.store.instanceId(), profiles: await this.store.list(actor) };
      case 'profile.read': return { profile: await this.store.read(actor, r.selection) };
      case 'profile.history': return { revisions: await this.store.history(actor, r.profileId) };
      case 'catalog.list': return { catalog: await this.store.catalog.publicEntries() };
      case 'skill.list': return { bundles: await this.store.listSkillBundles(actor) };
      case 'skill.import': return { bundle: await importExactGitSkill(this.store, actor, r, { guard, preflight: bundle => { fleetExtensionSkillBundleSchema.parse(bundle); this.response(a, { bundle }); } }) };
      case 'recipient.issue': return this.issue(a, r, rawIntent);
      case 'profile.create': case 'profile.update': return this.saveProfile(a, r, rawIntent);
      case 'profile.disable': {
        const profile = await this.store.read(actor, r.selection);
        const { version, name, agentScope, repositoryScope, mcpServers, skillBundleIds } = profile;
        return { profile: await this.store.saveWithOptions(actor, { version, name, enabled: false, agentScope, repositoryScope, mcpServers, skillBundleIds }, {}, { expected: r.selection, guard, preflight: preflightProfile }) };
      }
      case 'profile.delete': await this.store.delete(actor, r.selection, guard); return { deleted: true };
      case 'selection.validate': await this.store.assertLaunch(actor, r.selection, r.context); await guard(); return { selection: r.selection, valid: true };
      case 'profile.validate': return this.validateProfile(a, r.selection);
      case 'operation.status': {
        const journal = await this.fleet.files.read(`extension-operation-${r.targetOperationId}.json`);
        if (!journal.endsWith('\n')) throw new FleetRefusal();
        const { recordDigest, ...record } = JSON.parse(journal.trimEnd().split('\n').at(-1)!);
        if (recordDigest !== digest(record) || record.operationId !== r.targetOperationId || !['fenced', 'completed'].includes(record.state)) throw new FleetRefusal();
        if (!sameAudience(a, record.assertion)) throw new FleetRefusal();
        await this.authorize(record.assertion);
        return { operationId: record.operationId, state: record.state };
      }
    }
  }
  private async saveProfile(a: FleetExtensionAssertion, r: Extract<FleetExtensionRequest, { action: 'profile.create' | 'profile.update' }>, rawIntent: unknown) {
    const actor = String(a.githubActorId); const guard = async (database?: Knex) => { await this.authorize(a, database); };
    const preflight = (profile: unknown) => { this.response(a, { profile }); };
    const replacements = await this.decrypt(a, r, rawIntent);
    try {
      await guard();
      return { profile: await this.store.saveWithOptions(actor, r.input, replacements, { expected: r.action === 'profile.update' ? r.selection : undefined, guard, preflight }) };
    } finally { for (const key of Object.keys(replacements)) delete replacements[key]; }
  }
  private async validateProfile(a: FleetExtensionAssertion, selection: Extract<FleetExtensionRequest, { action: 'profile.validate' }>['selection']) {
    const actor = String(a.githubActorId); const guard = async () => { await this.authorize(a); };
    const profile = await this.store.read(actor, selection); await guard();
    const row = await this.store.database('extension_profile_revisions').where({ profile_id: profile.profileId, revision: profile.revision }).first();
    const secrets = row.secrets_encrypted === '' ? {} : unsealExtensionSecrets(row.secrets_encrypted, `${profile.instanceId}/${profile.profileId}/${profile.revision}`, this.store.environment);
    const results = [];
    try {
      for (const server of profile.mcpServers.filter(s => s.enabled)) {
        await guard();
        if (server.kind === 'catalog') { results.push({ name: server.name, status: 'not_validated' }); continue; }
        let reachable = false;
        try { const response = await requestExtensionMcp(server.url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'propr-validation', version: '1' } } }, secrets[server.name]) as { result?: unknown }; reachable = Boolean(response?.result); } catch { /* Upstream details never cross the boundary. */ }
        await guard(); results.push({ name: server.name, status: reachable ? 'reachable' : 'unavailable' });
      }
      return { results };
    } finally { for (const key of Object.keys(secrets)) delete secrets[key]; }
  }
  /** Internal v2 adapter: all store reads/writes use the caller's SQLite transaction.
   * Reuse native dispatch and volatile recipients; never invoke the v1 journal path. */
  async dispatchAtomic(a: FleetExtensionAssertion, r: FleetExtensionRequest, rawIntent: unknown,
    options: { database: Knex; guard: (assertion?: FleetExtensionAssertion) => void; secret: string }): Promise<{ result: unknown; discard: () => void }> {
    const { database, guard, secret } = options;
    // Recovery shares this module but must not initialize the application logger
    // (or its transport worker). Load the store only for a native v2 dispatch.
    const { ExtensionProfileStore } = await import('../extensions/extensionProfileStore.js');
    const scoped = Object.create(this) as FleetExtensionPlane;
    Object.defineProperty(scoped, 'store', { value: new ExtensionProfileStore(database, this.store.environment) });
    scoped.authorize = async assertion => { guard(assertion); return secret; };
    guard();
    const result = await scoped.dispatch(a, r, rawIntent);
    const recipientId = r.action === 'recipient.issue' ? (result as { recipientId: string }).recipientId : undefined;
    const discard = () => { if (recipientId) this.destroyRecipient(recipientId); };
    try { guard(); return { result: this.response(a, result), discard }; }
    catch (error) { discard(); throw error; }
  }
  private response(a: FleetExtensionAssertion, result: unknown): RecordResult {
    const response: RecordResult = { contract: FLEET_EXTENSION_CONTRACT, operationId: a.operationId, state: 'completed', result };
    if (Buffer.byteLength(JSON.stringify(response)) > FLEET_EXTENSION_LIMITS.responseBytes) throw new FleetRefusal();
    return response;
  }
  async invoke(raw: string): Promise<RecordResult> {
    let issuedRecipientId: string | undefined;
    try {
      await this.ready;
      if (Buffer.byteLength(raw) > FLEET_EXTENSION_LIMITS.requestBytes) throw new FleetRefusal();
      const parsed = JSON.parse(raw);
      if (canonicalFleetJson(parsed) !== raw) throw new FleetRefusal();
      const { assertion: a, request: r, mac } = fleetExtensionEnvelopeSchema.parse(parsed);
      // Bind signed digests to the canonical JSON sent by the client, before Zod normalizes names.
      if (a.contractPin !== extensionContractPin || a.action !== r.action || a.requestDigest !== digest(parsed.request)) throw new FleetRefusal();
      const rawIntent = r.action === 'recipient.issue' ? parsed.request.intent
        : r.action === 'profile.create' ? { action: r.action, input: parsed.request.input }
          : r.action === 'profile.update' ? { action: r.action, input: parsed.request.input, selection: parsed.request.selection } : undefined;
      const secret = await this.authorize(a); const now = Math.floor(Date.now() / 1000);
      if (a.issuedAt > now + 5 || a.issuedAt < now - 65 || a.expiresAt <= now || a.expiresAt <= a.issuedAt || a.expiresAt - a.issuedAt > 60
        || !timingSafeEqual(createHmac('sha256', secret).update(canonicalFleetJson(a)).digest(), Buffer.from(mac, 'hex'))) throw new FleetRefusal();
      if (this.slots + 2 > FLEET_EXTENSION_LIMITS.operations * 2) throw new FleetRefusal();
      const release = this.fleet.reserveExtensionEntries(2); this.slots += 2;
      let unattempted = 2;
      const claim = async (name: string, value: unknown) => {
        unattempted--;
        try { await this.fleet.files.create(name, value); }
        catch (error) {
          // O_EXCL refusal proves this attempt created no entry. Other failures
          // may follow a durable create/write: retain their reservation.
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') { release(1); this.slots--; }
          throw error;
        }
      };
      try {
        await claim(`extension-nonce-${a.nonce}`, { operationId: a.operationId });
        const initial = { assertion: a, operationId: a.operationId, state: 'fenced' };
        await claim(`extension-operation-${a.operationId}.json`, { ...initial, recordDigest: digest(initial) });
      } finally { release(unattempted); this.slots -= unattempted; }
      await this.authorize(a);
      const result = await this.dispatch(a, r, rawIntent);
      if (r.action === 'recipient.issue') issuedRecipientId = (result as { recipientId: string }).recipientId;
      await this.authorize(a);
      const response = this.response(a, result);
      // Journal records only outcome metadata. Lost replies require a new operation; no automatic retry.
      const completed = { assertion: a, operationId: a.operationId, state: 'completed' };
      await this.fleet.files.append(`extension-operation-${a.operationId}.json`, { ...completed, recordDigest: digest(completed) });
      return response;
    } catch {
      // A recipient is not issued until the caller can return a completed reply.
      if (issuedRecipientId) this.destroyRecipient(issuedRecipientId);
      // No diagnostics include requests, crypto failures or native error details.
      throw new ExtensionRefusal();
    }
  }
}
