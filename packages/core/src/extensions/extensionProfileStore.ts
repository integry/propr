import logger from '../utils/logger.js';
import { OperatorCatalog } from './operatorCatalog.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import { EXTENSION_LIMITS, publicExtensionProfile, extensionProfileInputSchema, extensionSelectionSchema, type ExtensionProfileInput, type ExtensionProfileRevision, type ExtensionSelection, type ExtensionSkillBundle } from '@propr/shared';
import { extensionEndpoint, resolveExtensionEndpoint } from './endpointPolicy.js';
import { sealExtensionSecrets, unsealExtensionSecrets } from './privateSecrets.js';
import { validateSkillFiles, type SkillFile } from './skillBundles.js';

export interface ExtensionGrantNetwork { mode: 'open' | 'restricted'; allow: string[]; instanceAllow: string[] }
export class ExtensionError extends Error { constructor(readonly status: number, message: string) { super(message); } }
export const extensionTokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const identity = (s: ExtensionSelection) => `${s.instanceId}/${s.profileId}/${s.revision}`;
export class ExtensionProfileStore {
  constructor(readonly database: Knex, readonly environment: NodeJS.ProcessEnv = process.env) {}
  get catalog(): OperatorCatalog { return new OperatorCatalog(this.environment); }
  async authorize(actor: string, database = this.database): Promise<void> {
    // Durable, uncached instance authority. No Connect/repository/bootstrap/session fallback.
    if (!/^[1-9][0-9]*$/.test(actor) || !(await database('instance_members').where({ github_user_id: actor, role: 'admin' }).first('github_user_id'))) throw new ExtensionError(403, 'Current durable instance administrator access is required');
  }
  async instanceId(database = this.database): Promise<string> {
    const row = await database('extension_instance_identity').where({ id: 1 }).first('instance_id');
    if (!row) throw new ExtensionError(503, 'Extension instance identity unavailable');
    return row.instance_id as string;
  }
  async list(actor: string): Promise<ExtensionProfileRevision[]> {
    await this.authorize(actor); const instanceId = await this.instanceId();
    const rows = await this.database('extension_profiles as p').join('extension_profile_revisions as r', function () { this.on('p.id', 'r.profile_id').andOn('p.revision', 'r.revision'); }).where({ 'p.instance_id': instanceId, 'p.deleted': false }).select('r.snapshot');
    return rows.map(r => publicExtensionProfile(JSON.parse(r.snapshot)));
  }
  async listSkillBundles(actor: string): Promise<ExtensionSkillBundle[]> {
    await this.authorize(actor);
    const rows = await this.database('extension_skill_bundles').where({ instance_id: await this.instanceId() }).select('descriptor');
    await this.authorize(actor);
    return rows.map(row => JSON.parse(row.descriptor) as ExtensionSkillBundle);
  }
  async read(actor: string, selection: ExtensionSelection, database = this.database): Promise<ExtensionProfileRevision> {
    await this.authorize(actor, database);
    let parsed: ExtensionSelection; try { parsed = extensionSelectionSchema.parse(selection); } catch { throw new ExtensionError(400, 'Invalid extension selection'); }
    if (parsed.instanceId !== await this.instanceId(database)) throw new ExtensionError(404, 'Extension profile unavailable');
    const row = await database('extension_profile_revisions as r').join('extension_profiles as p', 'r.profile_id', 'p.id').where({ 'p.id': parsed.profileId, 'p.instance_id': parsed.instanceId, 'p.deleted': false, 'r.revision': parsed.revision }).first('r.snapshot');
    if (!row) throw new ExtensionError(404, 'Extension profile unavailable');
    const snapshot = JSON.parse(row.snapshot) as ExtensionProfileRevision;
    if (snapshot.version !== 1 || snapshot.instanceId !== parsed.instanceId || snapshot.profileId !== parsed.profileId || snapshot.revision !== parsed.revision) throw new ExtensionError(409, 'Extension revision identity mismatch');
    return publicExtensionProfile(snapshot);
  }
  async history(actor: string, profileId: string): Promise<ExtensionProfileRevision[]> {
    await this.authorize(actor);
    const rows = await this.database('extension_profile_revisions as r').join('extension_profiles as p', 'r.profile_id', 'p.id').where({ 'p.id': profileId, 'p.instance_id': await this.instanceId(), 'p.deleted': false }).orderBy('r.revision', 'desc').select('r.snapshot');
    return rows.map(row => publicExtensionProfile(JSON.parse(row.snapshot)));
  }
  async save(actor: string, input: ExtensionProfileInput, replacements: Record<string, string | null> = {}, expected?: ExtensionSelection | null): Promise<ExtensionProfileRevision> {
    let parsed: ExtensionProfileInput; try { parsed = extensionProfileInputSchema.parse(input); } catch { throw new ExtensionError(400, 'Invalid extension profile'); }
    if (!replacements || typeof replacements !== 'object' || Array.isArray(replacements) || Object.entries(replacements).some(([name, token]) => !parsed.mcpServers.some(s => s.name === name && s.kind === 'https' && s.authentication === 'bearer') || (token !== null && (typeof token !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(token))))) throw new ExtensionError(400, 'Invalid secret replacement');
    await this.authorize(actor);
    for (const server of parsed.mcpServers) if (server.kind === 'https') extensionEndpoint(server.url);
    const operatorSecretValues: string[] = [];
    const catalogSecrets = new Map<string, { count: number; configured: boolean }>();
    for (const server of parsed.mcpServers.filter(s => parsed.enabled && s.enabled)) {
      if (server.kind === 'catalog') {
        const entry = await this.catalog.resolve(server.catalogId, server.digest, server.tools, server.capability, false);
        const values = Object.values(this.catalog.secrets(entry));
        operatorSecretValues.push(...values);
        catalogSecrets.set(server.name, { count: values.length, configured: values.every(Boolean) });
      } else await resolveExtensionEndpoint(server.url);
    }
    if (operatorSecretValues.some(value => value && JSON.stringify(parsed).includes(value))) throw new ExtensionError(400, 'Secrets cannot appear in public profile fields');
    // eslint-disable-next-line complexity -- revision fencing, credential rotation and snapshot persistence share one transaction
    return this.database.transaction(async trx => {
      await this.authorize(actor, trx); const instanceId = await this.instanceId(trx);
      const profileId = expected?.profileId ?? randomUUID(); const now = Date.now();
      let old: ExtensionProfileRevision | undefined; let secrets: Record<string, string> = {};
      if (expected) {
        old = await this.read(actor, expected, trx);
        const previous = await trx('extension_profile_revisions').where({ profile_id: profileId, revision: expected.revision }).first();
        secrets = previous.secrets_encrypted === '' ? {} : unsealExtensionSecrets(previous.secrets_encrypted, identity(expected), this.environment);
        const changed = await trx('extension_profiles').where({ id: profileId, instance_id: instanceId, revision: expected.revision, deleted: false }).update({ revision: expected.revision + 1, enabled: parsed.enabled });
        if (!changed) throw new ExtensionError(409, 'Profile revision changed; refresh before saving');
      } else await trx('extension_profiles').insert({ id: profileId, instance_id: instanceId, revision: 1, enabled: parsed.enabled });
      const bundleRows = await trx('extension_skill_bundles').where({ instance_id: instanceId }).whereIn('id', parsed.skillBundleIds);
      if (bundleRows.length !== parsed.skillBundleIds.length) throw new ExtensionError(404, 'Skill bundle unavailable');
      if ([...Object.values(secrets), ...Object.values(replacements)].some(token => token && JSON.stringify(parsed).includes(token))) throw new ExtensionError(400, 'Secrets cannot appear in public profile fields');
      const nextSecrets: Record<string, string> = {};
      for (const server of parsed.mcpServers) {
        if (server.kind !== 'https' || server.authentication !== 'bearer') continue;
        // Changing an endpoint must never transfer a credential silently.
        const previous = old?.mcpServers.find(s => s.kind === 'https' && s.name === server.name && s.url === server.url);
        const token = Object.hasOwn(replacements, server.name) ? replacements[server.name] : previous ? secrets[server.name] : undefined;
        if (token) nextSecrets[server.name] = token;
      }
      const snapshot: ExtensionProfileRevision = {
        ...parsed, profileId, instanceId, revision: (expected?.revision ?? 0) + 1,
        createdAt: old?.createdAt ?? now, updatedAt: now, auditActor: actor,
        secrets: Object.fromEntries(parsed.mcpServers.filter(s => s.kind === 'https' && s.authentication === 'bearer').map(s => [s.name, { fields: ['bearerToken'] as ['bearerToken'], configured: Boolean(nextSecrets[s.name]) }])),
        skillBundles: bundleRows.map(row => JSON.parse(row.descriptor)),
      };
      for (const server of parsed.mcpServers.filter(s => s.kind === 'catalog')) {
        if (server.kind !== 'catalog') continue;
        const previous = old?.mcpServers.find(s => s.kind === 'catalog' && s.name === server.name && s.catalogId === server.catalogId && s.digest === server.digest);
        snapshot.secrets[server.name] = catalogSecrets.get(server.name) ?? (previous ? old?.secrets[server.name] : undefined) ?? { count: 0, configured: false };
      }
      await trx('extension_profile_revisions').insert({ profile_id: profileId, revision: snapshot.revision, snapshot: JSON.stringify(snapshot), secrets_encrypted: sealExtensionSecrets(nextSecrets, identity(snapshot), this.environment) });
      return snapshot;
    });
  }
  async delete(actor: string, selection: ExtensionSelection): Promise<void> {
    await this.database.transaction(async trx => {
      await this.read(actor, selection, trx);
      const changed = await trx('extension_profiles').where({ id: selection.profileId, instance_id: selection.instanceId, revision: selection.revision, deleted: false }).update({ deleted: true, enabled: false, deleted_at: Date.now(), deleted_by: actor });
      if (!changed) throw new ExtensionError(409, 'Profile revision changed; refresh before deleting');
    });
  }
  async importSkill(actor: string, files: SkillFile[], source: ExtensionSkillBundle['source']): Promise<ExtensionSkillBundle> {
    await this.authorize(actor); const validated = validateSkillFiles(files);
    if (source.kind === 'github' && !/^[0-9a-f]{40}$/.test(source.commit)) throw new ExtensionError(400, 'Skill source must pin an exact Git commit');
    // Project provenance explicitly; TypeScript structural types cannot exclude extra runtime fields.
    const publicSource: ExtensionSkillBundle['source'] = source.kind === 'github'
      ? { kind: 'github', repository: source.repository, commit: source.commit, directory: source.directory }
      : { kind: 'archive', filename: source.filename };
    const descriptor: ExtensionSkillBundle = { id: randomUUID(), instanceId: await this.instanceId(), digest: validated.digest, name: validated.name, files: files.length, bytes: validated.bytes, source: publicSource, requirements: validated.requirements, createdAt: Date.now(), auditActor: actor };
    await this.authorize(actor);
    await this.database.transaction(async trx => {
      await this.authorize(actor, trx);
      if (descriptor.instanceId !== await this.instanceId(trx)) throw new ExtensionError(409, 'Skill instance changed');
      await trx('extension_skill_bundles').insert({ id: descriptor.id, instance_id: descriptor.instanceId, descriptor: JSON.stringify(descriptor), files_json: JSON.stringify(validated.files) });
    });
    return descriptor;
  }
  async assertLaunch(actor: string, selection: ExtensionSelection, context: { agentAlias: string; runtime: string; repositories: string[]; allowWrite: boolean }, validateResources = true): Promise<ExtensionProfileRevision> {
    if (!['claude', 'codex'].includes(context.runtime)) throw new ExtensionError(400, 'Extension profiles require Claude or Codex task execution');
    const snapshot = await this.read(actor, selection);
    const current = await this.database('extension_profiles').where({ id: selection.profileId, instance_id: selection.instanceId, revision: selection.revision, enabled: true, deleted: false }).first('id');
    if (!current || !snapshot.enabled) throw new ExtensionError(409, 'Extension profile disabled, deleted or superseded');
    if (snapshot.agentScope.length && !snapshot.agentScope.includes(context.agentAlias)) throw new ExtensionError(403, 'Profile agent scope does not match');
    if (snapshot.repositoryScope.length && (!context.repositories.length || context.repositories.some(r => !snapshot.repositoryScope.some(scope => scope.toLowerCase() === r.toLowerCase())))) throw new ExtensionError(403, 'Profile repository scope does not match');
    const credentials = await this.database('extension_profile_revisions').where({ profile_id: selection.profileId, revision: selection.revision }).first('secrets_encrypted');
    for (const server of snapshot.mcpServers.filter(s => s.enabled && (context.allowWrite || s.capability !== 'write'))) {
      if (server.kind === 'https' && server.authentication === 'bearer' && (!snapshot.secrets[server.name]?.configured || credentials?.secrets_encrypted === '')) throw new ExtensionError(409, 'MCP authentication is not configured');
      if (!validateResources) continue;
      if (server.kind === 'catalog') await this.catalog.resolve(server.catalogId, server.digest, server.tools, server.capability);
      else await resolveExtensionEndpoint(server.url);
    }
    return snapshot;
  }
  async activateGrant(token: string, actor: string, selection: ExtensionSelection): Promise<void> {
    await this.database.transaction(async trx => {
      await this.authorize(actor, trx);
      const snapshot = await this.read(actor, selection, trx);
      if (!snapshot.enabled) throw new ExtensionError(409, 'Extension profile disabled');
      // A conditional write is the launch linearization point. A disable,
      // delete or rotation that wins first blocks this launch. Later edits
      // apply to later launches and cannot mutate the now-running snapshot.
      const fenced = await trx('extension_profiles').where({ id: selection.profileId, instance_id: selection.instanceId, revision: selection.revision, enabled: true, deleted: false }).update({ enabled: true });
      if (!fenced) throw new ExtensionError(409, 'Extension profile changed before launch');
      // Repeated launches for this same run token retain their snapshot and
      // still recheck authority/revision; helper containers never reach here.
      const claimed = await trx('extension_run_grants').where({ token_hash: extensionTokenHash(token), actor, profile_id: selection.profileId, revision: selection.revision }).where('expires_at', '>', Date.now()).update({ active: true });
      if (!claimed) throw new ExtensionError(409, 'Extension launch grant unavailable');
    });
  }
  async recordGatewayNetwork(token: string, host: string, allowed: boolean): Promise<void> {
    await this.database.transaction(async trx => {
      const key = { token_hash: extensionTokenHash(token) };
      const row = await trx('extension_run_grants').where(key).first();
      if (!row) throw new ExtensionError(401, 'Extension grant unavailable');
      const events = JSON.parse(row.network_events ?? '[]') as unknown[];
      if (events.length < EXTENSION_LIMITS.calls * 2) events.push({ host, allowed });
      await trx('extension_run_grants').where(key).update({ network_events: JSON.stringify(events), network_denials: Number(row.network_denials) + (allowed ? 0 : 1) });
    });
  }
  async retainGatewayTelemetry(token: string): Promise<void> {
    const row = await this.database('extension_run_grants').where({ token_hash: extensionTokenHash(token) }).first();
    if (!row || !await this.database.schema.hasTable('task_history')) return;
    if (!await this.database('tasks').where({ task_id: row.task_id }).first()) return;
    // Persist decisions and accounting, never the operator's allowlists or addresses.
    const network = { mode: (JSON.parse(row.network_policy) as ExtensionGrantNetwork).mode };
    const resolutions = (JSON.parse(row.network_events) as { host: string; allowed: boolean }[]).map(({ host, allowed }) => ({
      allowed,
      ...(/^catalog:[a-z][a-z0-9_-]{0,63}@[0-9a-f]{64}$/.test(host) ? { host } : {}),
    }));
    await this.database('task_history').insert({
      task_id: row.task_id, state: 'processing', timestamp: new Date().toISOString(), reason: 'Extension MCP network accounting',
      metadata: JSON.stringify({ event: 'network.extensions', network, calls: row.calls, responseBytes: row.bytes, requestBytes: row.request_bytes, denied: row.network_denials, resolutions }),
    });
  }
  async finishGatewayCall(token: string, bytes: number): Promise<void> {
    try {
      await this.database('extension_run_grants').where({ token_hash: extensionTokenHash(token) }).where('connections', '>', 0).decrement({ connections: 1, bytes: Math.max(0, EXTENSION_LIMITS.responseBytes - bytes) });
    } catch {
      // Failed bookkeeping retains the full byte/connection reservation, so it
      // cannot grant extra capacity or replace the upstream result or failure.
      logger.warn('Could not release extension gateway reservation; reserved budget retained');
    }
  }
  // eslint-disable-next-line max-params -- actor, immutable snapshot, task identity, network policy and write authority are explicit grant inputs
  async createGrant(actor: string, snapshot: ExtensionProfileRevision, taskId: string, network: ExtensionGrantNetwork = { mode: 'open', allow: [], instanceAllow: [] }, allowWrite = false): Promise<string> {
    await this.read(actor, { instanceId: snapshot.instanceId, profileId: snapshot.profileId, revision: snapshot.revision });
    const token = randomBytes(32).toString('base64url');
    await this.database('extension_run_grants').where('expires_at', '<=', Date.now()).delete();
    await this.database('extension_run_grants').insert({ token_hash: extensionTokenHash(token), profile_id: snapshot.profileId, revision: snapshot.revision, actor, task_id: taskId, network_policy: JSON.stringify(network), allow_write: allowWrite === true, expires_at: Date.now() + 12 * 60 * 60 * 1000 });
    return token;
  }
  async grantSnapshot(token: string): Promise<{ snapshot: ExtensionProfileRevision; secrets: Record<string, string>; network: ExtensionGrantNetwork; taskId: string; allowWrite: boolean }> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new ExtensionError(401, 'Extension grant unavailable');
    // Each request reserves a full response budget; concurrency cannot overspend.
    const hash = extensionTokenHash(token);
    const changed = await this.database('extension_run_grants').where({ token_hash: hash, active: true }).where('connections', '<', 4).where('expires_at', '>', Date.now()).where('calls', '<', EXTENSION_LIMITS.calls).where('bytes', '<=', EXTENSION_LIMITS.egressBytes - EXTENSION_LIMITS.responseBytes).increment({ calls: 1, bytes: EXTENSION_LIMITS.responseBytes, connections: 1 });
    if (!changed) throw new ExtensionError(401, 'Extension grant expired or exhausted');
    try {
      const grant = await this.database('extension_run_grants').where({ token_hash: hash }).first();
      if (!grant) throw new ExtensionError(401, 'Extension grant unavailable');
      const row = await this.database('extension_profile_revisions').where({ profile_id: grant.profile_id, revision: grant.revision }).first();
      if (!row) throw new ExtensionError(401, 'Extension grant unavailable');
      const snapshot = JSON.parse(row.snapshot) as ExtensionProfileRevision;
      const expected = { instanceId: await this.instanceId(), profileId: grant.profile_id as string, revision: Number(grant.revision) };
      if (snapshot.version !== 1 || snapshot.instanceId !== expected.instanceId || snapshot.profileId !== expected.profileId || snapshot.revision !== expected.revision) throw new ExtensionError(401, 'Extension revision identity mismatch');
      // Running snapshots survive profile edits/disable/delete. Credentials never leave Core.
      if (!grant.network_policy) throw new ExtensionError(401, 'Extension network policy unavailable');
      return { snapshot, secrets: row.secrets_encrypted === '' ? {} : unsealExtensionSecrets(row.secrets_encrypted, identity(expected), this.environment), network: JSON.parse(grant.network_policy), taskId: grant.task_id, allowWrite: Boolean(grant.allow_write) };
    } catch (error) {
      // The reservation belongs to this call even if snapshot loading fails.
      // Keep the failed-call byte charge but release its connection slot.
      await this.finishGatewayCall(token, EXTENSION_LIMITS.responseBytes);
      throw error;
    }
  }
}
