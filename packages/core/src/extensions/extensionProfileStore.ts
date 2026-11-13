 
import logger from '../utils/logger.js';
import { OperatorCatalog, operatorCatalogDigest } from './operatorCatalog.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import {
  EXTENSION_LIMITS, EXTENSION_LIBRARY_VERSION, extensionItemSkipReason, extensionLibraryInputSchema, publicExtensionProfile, resolveExtensionSet,
  type AutomationExtensions, type ExtensionLibraryInput, type ExtensionLibraryItems, type ExtensionLibraryRevision, type ExtensionLibraryServer,
  type ExtensionLibrarySkill, type ExtensionResolutionContext, type ExtensionSecretStatus, type ExtensionSkillBundle, type LegacyExtensionProfileRevision,
  type ResolvedExtensionSet,
} from '@propr/shared';
import { extensionEndpoint, resolveExtensionEndpoint } from './endpointPolicy.js';
import { sealExtensionSecrets, unsealExtensionSecrets } from './privateSecrets.js';
import { validateSkillFiles, type SkillFile } from './skillBundles.js';
import { extensionResolutionReason, type ExtensionResolutionEvent } from './extensionRunResolution.js';
import { discardStaleOAuthConnections, withOAuthStates } from './extensionOAuthState.js';
import { bearerServers, credentialBinding, credentialBindings, credentialField, credentialServers } from './extensionCredentials.js';

export interface ExtensionGrantNetwork { mode: 'open' | 'restricted'; allow: string[]; instanceAllow: string[] }
export class ExtensionError extends Error { constructor(readonly status: number, message: string) { super(message); } }
export const extensionTokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
/** Authenticated binding of sealed library credentials: they open only for that instance and the revision that sealed them. */
export const libraryIdentity = (instanceId: string, revision: number) => `library/${instanceId}/${revision}`;
/**
 * A revision that changes no credential (enabling or disabling an item) carries
 * its base revision's sealed bytes forward unchanged, as
 * `<sealing revision>:<sealed>`, so it never needs to decrypt them. Carried
 * credentials open only under the identity of the earlier revision that sealed them.
 */
const carriedSecretsPattern = /^([1-9][0-9]*):([^:]+)$/;
export function unsealLibrarySecrets(encrypted: string, instanceId: string, revision: number, environment: NodeJS.ProcessEnv): Record<string, string> {
  if (encrypted === '') return {};
  const carried = carriedSecretsPattern.exec(encrypted);
  const sealedAt = carried ? Number(carried[1]) : revision;
  if (carried && !(sealedAt < revision)) throw new Error('Private extension credentials unavailable');
  return unsealExtensionSecrets(carried ? carried[2] : encrypted, libraryIdentity(instanceId, sealedAt), environment);
}
/** A revision's sealed credentials as a later revision carries them, naming the revision that sealed them. */
const carriedSecrets = (head: Head) => (head.secretsEncrypted === '' || carriedSecretsPattern.test(head.secretsEncrypted) ? head.secretsEncrypted : `${head.snapshot.revision}:${head.secretsEncrypted}`);
/** Passed instead of credentials by a change that alters none: the base revision's sealed credentials carry over. */
const UNCHANGED_CREDENTIALS = Symbol('unchanged library credentials');
const legacyIdentity = (s: { instanceId: string; profileId: string; revision: number }) => `${s.instanceId}/${s.profileId}/${s.revision}`;
const tokenPattern = /^[\x21-\x7e]{1,4096}$/;

export type ExtensionLibraryItemRef = { kind: 'server'; name: string } | { kind: 'skill'; bundleId: string };
/** What the run's launch was prepared with; the fence compares it with the current library. */
export interface PreparedExtensionLaunch {
  snapshot: ExtensionLibraryRevision;
  set: ResolvedExtensionSet;
}
export interface ExtensionLaunchContext {
  agentAlias: string; runtime: string; repositories: string[]; allowWrite: boolean;
  additional?: AutomationExtensions | null; autoApply?: boolean;
  /** Per-run server budget left after the run's own MCP servers. */
  maxServers?: number;
}
export interface GrantSnapshot {
  snapshot: { instanceId: string; revision: number; servers: ExtensionLibraryServer[]; skillBundles: ExtensionSkillBundle[] };
  secrets: Record<string, string>; network: ExtensionGrantNetwork; taskId: string; allowWrite: boolean;
}
interface Head { snapshot: ExtensionLibraryRevision; secretsEncrypted: string }

const emptyLibrary = (instanceId: string): ExtensionLibraryRevision => ({
  version: EXTENSION_LIBRARY_VERSION, instanceId, revision: 0, createdAt: 0, updatedAt: 0, auditActor: '',
  servers: [], skills: [], secrets: {}, skillBundles: [],
});
const resolutionContext = (context: ExtensionLaunchContext): ExtensionResolutionContext => ({
  repository: context.repositories, agentAlias: context.agentAlias, runtime: context.runtime, allowWrite: context.allowWrite,
  additional: context.additional ?? null, autoApply: context.autoApply !== false,
  limits: { servers: context.maxServers ?? EXTENSION_LIMITS.servers, bundles: EXTENSION_LIMITS.bundles },
});
const itemKey = (item: ExtensionLibraryServer | ExtensionLibrarySkill) => ('kind' in item ? `server:${item.name}` : `skill:${item.bundleId}`);
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const withoutBundle = (resolved: ResolvedExtensionSet['skills'][number]): ExtensionLibrarySkill => {
  const skill: Partial<typeof resolved> = { ...resolved }; delete skill.bundle; return skill as ExtensionLibrarySkill;
};

export class ExtensionLibraryStore {
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

  /** The current library revision; revision 0 when nothing was saved yet. Never authorizes; Core-internal. */
  async head(database: Knex = this.database): Promise<Head> {
    const instanceId = await this.instanceId(database);
    const pointer = await database('extension_library').where({ instance_id: instanceId }).first('revision');
    if (!pointer) return { snapshot: emptyLibrary(instanceId), secretsEncrypted: '' };
    return this.revisionRow(instanceId, Number(pointer.revision), database);
  }
  private async revisionRow(instanceId: string, revision: number, database: Knex = this.database): Promise<Head> {
    const row = await database('extension_library_revisions').where({ instance_id: instanceId, revision }).first('snapshot', 'secrets_encrypted');
    if (!row) throw new ExtensionError(409, 'Extension library revision unavailable');
    const snapshot = JSON.parse(row.snapshot) as ExtensionLibraryRevision;
    if (snapshot.version !== EXTENSION_LIBRARY_VERSION || snapshot.instanceId !== instanceId || snapshot.revision !== revision) throw new ExtensionError(409, 'Extension library revision identity mismatch');
    // Native exports erase credential custody; erased bearer secrets are not configured.
    if (row.secrets_encrypted === '') for (const server of credentialServers(snapshot.servers)) snapshot.secrets[server.name] = { fields: credentialField(server), configured: false };
    return { snapshot: publicExtensionProfile(snapshot), secretsEncrypted: row.secrets_encrypted as string };
  }
  private unseal(head: Head): Record<string, string> {
    return unsealLibrarySecrets(head.secretsEncrypted, head.snapshot.instanceId, head.snapshot.revision, this.environment);
  }

  async readLibrary(actor: string): Promise<ExtensionLibraryRevision> {
    await this.authorize(actor);
    const { snapshot } = await this.head();
    await this.authorize(actor);
    return snapshot;
  }
  async history(actor: string, limit = 50): Promise<ExtensionLibraryRevision[]> {
    await this.authorize(actor);
    const rows = await this.database('extension_library_revisions').where({ instance_id: await this.instanceId() }).orderBy('revision', 'desc').limit(Math.min(Math.max(limit, 1), 200)).select('snapshot');
    return rows.map(row => publicExtensionProfile(JSON.parse(row.snapshot) as ExtensionLibraryRevision));
  }
  async listSkillBundles(actor: string): Promise<ExtensionSkillBundle[]> {
    await this.authorize(actor);
    const rows = await this.database('extension_skill_bundles').where({ instance_id: await this.instanceId() }).select('descriptor');
    await this.authorize(actor);
    return rows.map(row => JSON.parse(row.descriptor) as ExtensionSkillBundle);
  }
  /** Automations whose `extensions` name any of the given items. */
  async automationsAdding(items: { servers: string[]; skills: string[] }, database: Knex = this.database): Promise<{ id: string; name: string; servers: string[]; skills: string[] }[]> {
    if (!items.servers.length && !items.skills.length) return [];
    if (!await database.schema.hasTable('agent_definitions') || !await database.schema.hasColumn('agent_definitions', 'extensions')) return [];
    const rows = await database('agent_definitions').whereNotNull('extensions').select('id', 'name', 'extensions');
    return rows.flatMap(row => {
      let extensions: AutomationExtensions; try { extensions = JSON.parse(row.extensions); } catch { return []; }
      const servers = (extensions.servers ?? []).filter(name => items.servers.includes(name));
      const skills = (extensions.skills ?? []).filter(id => items.skills.includes(id));
      return servers.length || skills.length ? [{ id: row.id as string, name: (row.name as string) ?? row.id, servers, skills }] : [];
    });
  }
  /** Confirm that every named item exists in the current library, read through `database`. */
  async assertItemsExist(extensions: AutomationExtensions, database: Knex = this.database): Promise<void> {
    const { snapshot } = await this.head(database);
    const missingServers = extensions.servers.filter(name => !snapshot.servers.some(s => s.name === name));
    const missingSkills = extensions.skills.filter(id => !snapshot.skills.some(s => s.bundleId === id));
    if (missingServers.length || missingSkills.length) throw new ExtensionError(400, `Extension library items not found: ${[...missingServers, ...missingSkills].join(', ')}`);
  }
  /**
   * Inside the transaction that persists an automation adding `extensions`:
   * take the library's write lock first, then recheck the actor and that every
   * added item exists. A library save checks automation references under the
   * same lock, so either it sees this automation's reference and refuses the
   * removal, or the removal commits first and this check refuses the addition.
   */
  async assertAdditionInTransaction(trx: Knex.Transaction, actor: string, extensions: AutomationExtensions): Promise<void> {
    await trx('extension_library').update({ revision: trx.ref('revision') });
    await this.authorize(actor, trx);
    await this.assertItemsExist(extensions, trx);
  }
  /**
   * Migrated item names of a removed profile, for queued submissions that
   * still carry it, with the profile revision they were migrated from (null
   * when unrecorded). The items are only those of that revision.
   */
  async legacyProfileExtensions(profileId: string, database: Knex = this.database): Promise<(AutomationExtensions & { revision: number | null }) | null> {
    if (!await database.schema.hasTable('extension_legacy_profile_items')) return null;
    const row = await database('extension_legacy_profile_items').where({ profile_id: profileId }).first();
    return row ? { revision: row.revision ?? null, servers: JSON.parse(row.servers), skills: JSON.parse(row.skills) } : null;
  }

  /** Validate public fields, endpoints and catalog identities of enabled servers before any write. */
  private async validateServers(servers: ExtensionLibraryServer[]): Promise<Map<string, { count: number; configured: boolean }>> {
    for (const server of servers) if (server.kind === 'https') extensionEndpoint(server.url);
    const operatorSecretValues: string[] = [];
    const catalogSecrets = new Map<string, { count: number; configured: boolean }>();
    for (const server of servers.filter(s => s.enabled)) {
      if (server.kind === 'catalog') {
        const entry = await this.catalog.resolve(server.catalogId, server.digest, server.tools, server.capability, false);
        const values = Object.values(this.catalog.secrets(entry));
        operatorSecretValues.push(...values);
        catalogSecrets.set(server.name, { count: values.length, configured: values.every(Boolean) });
      } else await resolveExtensionEndpoint(server.url);
    }
    if (operatorSecretValues.some(value => value && JSON.stringify(servers).includes(value))) throw new ExtensionError(400, 'Secrets cannot appear in public library fields');
    return catalogSecrets;
  }

  /**
   * Persist the next revision on top of `head`; the head pointer write is the
   * concurrency fence. With `UNCHANGED_CREDENTIALS` the base revision's sealed
   * credentials and their statuses carry over without decryption; they stay
   * bound to the same Bearer servers and endpoints.
   */
  // eslint-disable-next-line max-params -- the transaction, actor, base head, items, credentials and catalog status are explicit revision inputs
  private async writeRevision(trx: Knex.Transaction, actor: string, head: Head, items: ExtensionLibraryItems, secrets: Record<string, string> | typeof UNCHANGED_CREDENTIALS, catalogSecrets: Map<string, { count: number; configured: boolean }>): Promise<ExtensionLibraryRevision> {
    const { instanceId } = head.snapshot; const previous = head.snapshot; const revision = previous.revision + 1; const now = Date.now();
    const bundleIds = items.skills.map(s => s.bundleId);
    const bundleRows = bundleIds.length ? await trx('extension_skill_bundles').where({ instance_id: instanceId }).whereIn('id', bundleIds) : [];
    if (bundleRows.length !== bundleIds.length) throw new ExtensionError(404, 'Skill bundle unavailable');
    const unchanged = secrets === UNCHANGED_CREDENTIALS;
    if (unchanged && !sameJson(credentialBindings(items.servers), credentialBindings(previous.servers))) throw new Error('Carried extension credentials must keep their servers');
    if (!unchanged && Object.values(secrets).some(token => token && JSON.stringify(items).includes(token))) throw new ExtensionError(400, 'Secrets cannot appear in public library fields');
    const statuses: Record<string, ExtensionSecretStatus> = {};
    for (const server of items.servers) {
      if (server.kind === 'https') {
        if (credentialServers([server]).length) statuses[server.name] = unchanged ? previous.secrets[server.name] ?? { fields: credentialField(server), configured: false } : { fields: credentialField(server), configured: Boolean(secrets[server.name]) };
        continue;
      }
      const same = previous.servers.find(s => s.kind === 'catalog' && s.name === server.name && s.catalogId === server.catalogId && s.digest === server.digest);
      statuses[server.name] = catalogSecrets.get(server.name) ?? (same ? previous.secrets[server.name] : undefined) ?? { count: 0, configured: false };
    }
    const descriptors = new Map(bundleRows.map(row => [row.id as string, JSON.parse(row.descriptor) as ExtensionSkillBundle]));
    const snapshot: ExtensionLibraryRevision = {
      version: EXTENSION_LIBRARY_VERSION, instanceId, revision, createdAt: previous.revision ? previous.createdAt : now, updatedAt: now, auditActor: actor,
      servers: items.servers, skills: items.skills, secrets: statuses, skillBundles: bundleIds.map(id => descriptors.get(id)!),
    };
    const sealed = unchanged ? carriedSecrets(head) : sealExtensionSecrets(Object.fromEntries(Object.entries(secrets).filter(([name, token]) => token && statuses[name])), libraryIdentity(instanceId, revision), this.environment);
    if (previous.revision === 0 && !await trx('extension_library').where({ instance_id: instanceId }).first()) await trx('extension_library').insert({ instance_id: instanceId, revision });
    else if (!await trx('extension_library').where({ instance_id: instanceId, revision: previous.revision }).update({ revision })) throw new ExtensionError(409, 'Library revision changed; refresh before saving');
    await trx('extension_library_revisions').insert({ instance_id: instanceId, revision, snapshot: JSON.stringify(snapshot), secrets_encrypted: sealed });
    return snapshot;
  }

  /** Items removed by this change that automations still add explicitly are refused, naming the automations. */
  private async refuseReferencedRemoval(trx: Knex, previous: ExtensionLibraryRevision, next: ExtensionLibraryItems): Promise<void> {
    const servers = previous.servers.map(s => s.name).filter(name => !next.servers.some(s => s.name === name));
    const skills = previous.skills.map(s => s.bundleId).filter(id => !next.skills.some(s => s.bundleId === id));
    const using = await this.automationsAdding({ servers, skills }, trx);
    if (using.length) throw new ExtensionError(409, `Automations add these extensions explicitly; remove them from ${using.map(a => `"${a.name}" (${[...a.servers, ...a.skills].join(', ')})`).join(', ')} before removing or renaming them`);
  }

  async saveLibrary(actor: string, input: ExtensionLibraryInput, replacements: Record<string, string | null> = {}, expectedRevision?: number): Promise<ExtensionLibraryRevision> {
    let parsed: ExtensionLibraryItems; try { parsed = extensionLibraryInputSchema.parse(input); } catch { throw new ExtensionError(400, 'Invalid extension library'); }
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision! < 0) throw new ExtensionError(400, 'Invalid expected library revision');
    if (!replacements || typeof replacements !== 'object' || Array.isArray(replacements) || Object.entries(replacements).some(([name, token]) => !credentialServers(parsed.servers).some(s => s.name === name) || (token !== null && (typeof token !== 'string' || !tokenPattern.test(token))))) throw new ExtensionError(400, 'Invalid secret replacement');
    await this.authorize(actor);
    const catalogSecrets = await this.validateServers(parsed.servers);
    return this.database.transaction(async trx => {
      await this.authorize(actor, trx);
      const head = await this.head(trx);
      if (head.snapshot.revision !== expectedRevision) throw new ExtensionError(409, 'Library revision changed; refresh before saving');
      await this.refuseReferencedRemoval(trx, head.snapshot, parsed);
      const secrets = this.unseal(head); const next: Record<string, string> = {};
      // Checked before credentials are cleared, dropped with their server or
      // withheld from a changed endpoint: none may become a public field.
      const supplied = [...Object.values(secrets), ...Object.values(replacements).filter((token): token is string => token !== null)];
      if (supplied.some(token => token && JSON.stringify(parsed).includes(token))) throw new ExtensionError(400, 'Secrets cannot appear in public library fields');
      for (const server of credentialServers(parsed.servers)) {
        if (server.kind !== 'https') continue;
        // Changing an endpoint, authentication type or client must never transfer a credential silently.
        const previous = head.snapshot.servers.find(s => s.name === server.name && sameJson(credentialBinding(s), credentialBinding(server)));
        const token = Object.hasOwn(replacements, server.name) ? replacements[server.name] : previous ? secrets[server.name] : undefined;
        if (token) next[server.name] = token;
      }
      const written = await this.writeRevision(trx, actor, head, parsed, next, catalogSecrets);
      // OAuth connections are credential state outside the revision: a changed URL, authentication or client discards them.
      await discardStaleOAuthConnections(trx, written.instanceId, written.servers, actor); return written;
    });
  }
  /** Replace or clear one server's write-only credential; a new revision with unchanged items. */
  async replaceSecret(actor: string, name: string, token: string | null, expectedRevision?: number): Promise<ExtensionLibraryRevision> {
    if (typeof name !== 'string' || (token !== null && (typeof token !== 'string' || !tokenPattern.test(token)))) throw new ExtensionError(400, 'Invalid secret replacement');
    await this.authorize(actor);
    return this.database.transaction(async trx => {
      await this.authorize(actor, trx);
      const head = await this.head(trx);
      if (expectedRevision !== undefined && head.snapshot.revision !== expectedRevision) throw new ExtensionError(409, 'Library revision changed; refresh before saving');
      if (!credentialServers(head.snapshot.servers).some(s => s.name === name)) throw new ExtensionError(404, 'Bearer-authenticated or pre-registered OAuth library server unavailable');
      const secrets = { ...this.unseal(head) };
      if (token) secrets[name] = token; else delete secrets[name];
      return this.writeRevision(trx, actor, head, { version: EXTENSION_LIBRARY_VERSION, servers: head.snapshot.servers, skills: head.snapshot.skills }, secrets, new Map());
    });
  }
  /**
   * Change only `enabled` of one item. Configuration, limits and the stored
   * credential are untouched: the sealed credentials carry over without
   * decryption, so an item can be disabled even when they cannot be decrypted,
   * as after a raw restore under another encryption root. Disabling is never
   * refused, even when an automation adds the item: that automation then runs without it.
   */
  async setItemEnabled(actor: string, ref: ExtensionLibraryItemRef, enabled: boolean): Promise<ExtensionLibraryRevision> {
    if (typeof enabled !== 'boolean' || !ref || !['server', 'skill'].includes(ref.kind)) throw new ExtensionError(400, 'Invalid extension item');
    await this.authorize(actor);
    const find = (snapshot: ExtensionLibraryRevision) => (ref.kind === 'server' ? snapshot.servers.find(s => s.name === ref.name) : snapshot.skills.find(s => s.bundleId === ref.bundleId));
    const before = find((await this.head()).snapshot);
    if (!before) throw new ExtensionError(404, 'Extension library item unavailable');
    // Re-enabling a server revalidates its endpoint or catalog entry, as a save does.
    const catalogSecrets = enabled && 'kind' in before ? await this.validateServers([{ ...before, enabled: true }]) : new Map<string, { count: number; configured: boolean }>();
    return this.database.transaction(async trx => {
      await this.authorize(actor, trx);
      const head = await this.head(trx);
      const current = find(head.snapshot);
      if (!current || !sameJson({ ...current, enabled: before.enabled }, before)) throw new ExtensionError(409, 'Library revision changed; refresh before saving');
      if (current.enabled === enabled) return head.snapshot;
      const toggle = <T extends ExtensionLibraryServer | ExtensionLibrarySkill>(item: T): T => (itemKey(item) === itemKey(current) ? { ...item, enabled } : item);
      return this.writeRevision(trx, actor, head, { version: EXTENSION_LIBRARY_VERSION, servers: head.snapshot.servers.map(toggle), skills: head.snapshot.skills.map(toggle) }, UNCHANGED_CREDENTIALS, catalogSecrets);
    });
  }
  /** Enabled HTTPS servers and their credentials for connectivity validation; credentials stay in Core callers. */
  async validationTargets(actor: string): Promise<{ servers: ExtensionLibraryServer[]; secrets: Record<string, string> }> {
    await this.authorize(actor);
    const head = await this.head();
    return { servers: head.snapshot.servers.filter(s => s.enabled), secrets: this.unseal(head) };
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

  /**
   * Resolve the run's extension set against the current library revision. The
   * authority is the revision itself, saved only by an administrator; no
   * selecting administrator is needed. With `validateResources`, endpoint DNS
   * and catalog digests of the resolved servers are checked.
   */
  async resolveLaunch(context: ExtensionLaunchContext, validateResources = true): Promise<PreparedExtensionLaunch> {
    if (!['claude', 'codex'].includes(context.runtime)) throw new ExtensionError(400, 'Extensions require Claude or Codex task execution');
    const { snapshot } = await this.head();
    const set = resolveExtensionSet(await withOAuthStates(this.database, await this.withCurrentCatalogSecrets(snapshot)), resolutionContext(context));
    if (validateResources) {
      for (const server of set.servers) {
        if (server.kind === 'catalog') await this.catalog.resolve(server.catalogId, server.digest, server.tools, server.capability);
        else await resolveExtensionEndpoint(server.url);
      }
    }
    return { snapshot, set };
  }
  /**
   * Names of the library items that would apply automatically to an issue task
   * for this repository and agent, for the New Task form. Read-only and
   * available to task creators: names and capabilities only, never URLs,
   * credentials or limits. Write servers are listed; they apply only with the
   * submission's write opt-in.
   */
  async taskPreview(context: { repository: string; agentAlias: string; runtime: string }): Promise<{ qualified: boolean; revision: number; servers: { name: string; capability: 'read' | 'write' }[]; skills: { name: string }[] }> {
    const { snapshot } = await this.head();
    if (!['claude', 'codex'].includes(context.runtime)) return { qualified: false, revision: snapshot.revision, servers: [], skills: [] };
    const set = resolveExtensionSet(await withOAuthStates(this.database, await this.withCurrentCatalogSecrets(snapshot)), { repository: context.repository, agentAlias: context.agentAlias, runtime: context.runtime });
    return { qualified: true, revision: snapshot.revision, servers: set.servers.map(s => ({ name: s.name, capability: s.capability })), skills: set.skills.map(s => ({ name: s.bundle.name })) };
  }
  /**
   * The library view resolution uses: catalog credential availability is read
   * from the operator environment now, since the saved status may be stale. A
   * catalog server whose entry is unavailable or changed gets no status, so it
   * is not skipped and its use still refuses on identity, as before.
   */
  private async withCurrentCatalogSecrets(snapshot: ExtensionLibraryRevision): Promise<ExtensionLibraryRevision> {
    const catalogServers = snapshot.servers.filter(s => s.kind === 'catalog' && s.enabled);
    if (!catalogServers.length) return snapshot;
    const catalog = this.catalog;
    let entries: Awaited<ReturnType<OperatorCatalog['entries']>> = [];
    try { entries = await catalog.entries(); } catch { /* an unavailable catalog refuses when an item is used */ }
    const secrets = { ...snapshot.secrets };
    for (const server of catalogServers) {
      if (server.kind !== 'catalog') continue;
      const entry = entries.find(e => e.id === server.catalogId && operatorCatalogDigest(e) === server.digest);
      if (!entry) { delete secrets[server.name]; continue; }
      const values = Object.values(catalog.secrets(entry));
      secrets[server.name] = { count: values.length, configured: values.every(Boolean) };
    }
    return { ...snapshot, secrets };
  }
  /**
   * The prepared items must be unchanged, still enabled, still within their
   * limits and hold the same credentials in the current revision. Edits to
   * other items, or additions, do not affect this launch.
   */
  async assertPreparedLaunch(prepared: PreparedExtensionLaunch, context: ExtensionLaunchContext, database: Knex = this.database): Promise<number> {
    const head = await this.head(database);
    if (head.snapshot.revision === prepared.snapshot.revision) return head.snapshot.revision;
    const changed = () => new ExtensionError(409, 'Extension library changed before launch');
    const ctx = resolutionContext(context); const view = await this.withCurrentCatalogSecrets(head.snapshot);
    for (const item of [...prepared.set.servers, ...prepared.set.skills.map(withoutBundle)]) {
      const current = 'kind' in item ? head.snapshot.servers.find(s => s.name === item.name) : head.snapshot.skills.find(s => s.bundleId === item.bundleId);
      if (!current || !sameJson(current, item) || extensionItemSkipReason(view, current, ctx)) throw changed();
    }
    for (const skill of prepared.set.skills) if (!sameJson(head.snapshot.skillBundles.find(b => b.id === skill.bundleId), skill.bundle)) throw changed();
    const bearer = bearerServers(prepared.set.servers);
    const preparedRow = bearer.length ? await this.revisionRow(prepared.snapshot.instanceId, prepared.snapshot.revision, database) : undefined;
    // The same sealed bytes of the same sealing revision hold the same
    // credentials, as after a toggle; only re-sealed ones are decrypted to compare.
    if (preparedRow && carriedSecrets(preparedRow) !== carriedSecrets(head)) {
      const before = this.unseal(preparedRow); const after = this.unseal(head);
      if (bearer.some(s => before[s.name] !== after[s.name])) throw changed();
    }
    return head.snapshot.revision;
  }
  async activateGrant(token: string, prepared: PreparedExtensionLaunch, context: ExtensionLaunchContext): Promise<void> {
    await this.database.transaction(async trx => {
      const seen = await this.assertPreparedLaunch(prepared, context, trx);
      // A conditional write is the launch linearization point. A disable,
      // removal or rotation that wins first blocks this launch. Later edits
      // apply to later launches and cannot mutate the now-running snapshot.
      const fenced = await trx('extension_library').where({ instance_id: prepared.snapshot.instanceId, revision: seen }).update({ revision: seen });
      if (!fenced) throw new ExtensionError(409, 'Extension library changed before launch');
      // Repeated launches for this same run token retain their snapshot and
      // still recheck the library; helper containers never reach here.
      const claimed = await trx('extension_run_grants').where({ token_hash: extensionTokenHash(token), revision: prepared.snapshot.revision }).whereNull('profile_id').where('expires_at', '>', Date.now()).update({ active: true });
      if (!claimed) throw new ExtensionError(409, 'Extension launch grant unavailable');
    });
  }
   
  // eslint-disable-next-line max-params -- grant inputs mirror the launch record
  async createGrant(prepared: PreparedExtensionLaunch, taskId: string, network: ExtensionGrantNetwork = { mode: 'open', allow: [], instanceAllow: [] }, allowWrite = false, source: 'auto' | 'additional' | 'mixed' = 'auto'): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await this.database('extension_run_grants').where('expires_at', '<=', Date.now()).delete();
    // The revision's audit actor is provenance only.
    await this.database('extension_run_grants').insert({
      token_hash: extensionTokenHash(token), profile_id: null, revision: prepared.snapshot.revision, actor: prepared.snapshot.auditActor || 'library', task_id: taskId,
      network_policy: JSON.stringify(network), allow_write: allowWrite === true, expires_at: Date.now() + 12 * 60 * 60 * 1000,
      selection: JSON.stringify({ servers: prepared.set.servers.map(s => s.name), skills: prepared.set.skills.map(s => s.bundleId), source }),
    });
    return token;
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
  /** Record which library items a run launched with and which it skipped. Never fails the run. */
  async recordResolution(taskId: string, event: ExtensionResolutionEvent): Promise<void> {
    if (!await this.database.schema.hasTable('task_history') || !await this.database('tasks').where({ task_id: taskId }).first()) return;
    await this.database('task_history').insert({
      task_id: taskId, state: 'processing', timestamp: new Date().toISOString(), reason: extensionResolutionReason(event), metadata: JSON.stringify(event),
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
   
  async grantSnapshot(token: string): Promise<GrantSnapshot> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new ExtensionError(401, 'Extension grant unavailable');
    // Each request reserves a full response budget; concurrency cannot overspend.
    const hash = extensionTokenHash(token);
    const changed = await this.database('extension_run_grants').where({ token_hash: hash, active: true }).where('connections', '<', 4).where('expires_at', '>', Date.now()).where('calls', '<', EXTENSION_LIMITS.calls).where('bytes', '<=', EXTENSION_LIMITS.egressBytes - EXTENSION_LIMITS.responseBytes).increment({ calls: 1, bytes: EXTENSION_LIMITS.responseBytes, connections: 1 });
    if (!changed) throw new ExtensionError(401, 'Extension grant expired or exhausted');
    try {
      const grant = await this.database('extension_run_grants').where({ token_hash: hash }).first();
      if (!grant) throw new ExtensionError(401, 'Extension grant unavailable');
      if (!grant.network_policy) throw new ExtensionError(401, 'Extension network policy unavailable');
      const instanceId = await this.instanceId(); const revision = Number(grant.revision);
      const base = { network: JSON.parse(grant.network_policy) as ExtensionGrantNetwork, taskId: grant.task_id as string, allowWrite: Boolean(grant.allow_write) };
      // Running snapshots survive library edits, disabling and removal. Credentials never leave Core.
      if (grant.profile_id) {
        // A task launched before the upgrade keeps its profile snapshot.
        const row = await this.database('extension_profile_revisions').where({ profile_id: grant.profile_id, revision }).first();
        if (!row) throw new ExtensionError(401, 'Extension grant unavailable');
        const snapshot = JSON.parse(row.snapshot) as LegacyExtensionProfileRevision;
        const expected = { instanceId, profileId: grant.profile_id as string, revision };
        if (snapshot.version !== 1 || snapshot.instanceId !== expected.instanceId || snapshot.profileId !== expected.profileId || snapshot.revision !== expected.revision) throw new ExtensionError(401, 'Extension revision identity mismatch');
        const servers = snapshot.mcpServers.filter(s => s.enabled).map(s => ({ ...s, repositories: [], agents: [], autoApply: false }) as ExtensionLibraryServer);
        return { ...base, snapshot: { instanceId, revision, servers, skillBundles: snapshot.skillBundles }, secrets: row.secrets_encrypted === '' ? {} : unsealExtensionSecrets(row.secrets_encrypted, legacyIdentity(expected), this.environment) };
      }
      const row = await this.database('extension_library_revisions').where({ instance_id: instanceId, revision }).first();
      if (!row || !grant.selection) throw new ExtensionError(401, 'Extension grant unavailable');
      const snapshot = JSON.parse(row.snapshot) as ExtensionLibraryRevision;
      if (snapshot.version !== EXTENSION_LIBRARY_VERSION || snapshot.instanceId !== instanceId || snapshot.revision !== revision) throw new ExtensionError(401, 'Extension revision identity mismatch');
      const selection = JSON.parse(grant.selection) as { servers: string[]; skills: string[] };
      // Only the servers resolved for this run are reachable through its grant.
      const servers = snapshot.servers.filter(s => selection.servers.includes(s.name));
      return { ...base, snapshot: { instanceId, revision, servers, skillBundles: snapshot.skillBundles.filter(b => selection.skills.includes(b.id)) }, secrets: unsealLibrarySecrets(row.secrets_encrypted, instanceId, revision, this.environment) };
    } catch (error) {
      // The reservation belongs to this call even if snapshot loading fails.
      // Keep the failed-call byte charge but release its connection slot.
      await this.finishGatewayCall(token, EXTENSION_LIMITS.responseBytes);
      throw error;
    }
  }
}
/** @deprecated Extension profiles were replaced by the library; use ExtensionLibraryStore. */
export const ExtensionProfileStore = ExtensionLibraryStore;
export type ExtensionProfileStore = ExtensionLibraryStore;
