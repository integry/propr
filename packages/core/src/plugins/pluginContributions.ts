import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import {
  EXTENSION_LIBRARY_VERSION, extensionLibraryInputSchema, extensionPackageSecretKey, PLUGIN_LIBRARY_HREF, PLUGIN_TEMPLATE_CATALOG_HREF,
  type ExtensionLibraryItems, type ExtensionLibraryRevision, type ExtensionLibraryServer, type ExtensionLibrarySkill, type ExtensionManagedBy,
  type ExtensionSkillBundle, type PluginContributionViews, type PluginInstallationRecord, type PluginManifest, type PluginMcpServer,
} from '@propr/shared';
import { ExtensionError, type ExtensionLibraryStore } from '../extensions/extensionProfileStore.js';
import { credentialOwner } from '../extensions/extensionCredentials.js';
import { discardStaleOAuthConnections } from '../extensions/extensionOAuthState.js';
import type { ManagedAcknowledgements } from '../extensions/extensionPackageLibrary.js';
import { validateSkillFiles } from '../extensions/skillBundles.js';
import { officialPluginAssets, type PluginAssetSource } from './pluginAssets.js';
import { PluginError, pendingAcknowledgements } from './pluginState.js';

/** What the sync applies: the installation (null once uninstalled) and the values of its token connections. */
export interface PluginSyncInput {
  pluginId: string;
  manifest: PluginManifest | null;
  record: PluginInstallationRecord | null;
  /** Stored `token` connection values by connection name. Core-internal; never returned. */
  connections: Record<string, string>;
  actor: string;
  /** The plugin's repository limit changed: managed items take it as their repository limit. */
  resetRepositories?: boolean;
}

type Item = ExtensionLibraryServer | ExtensionLibrarySkill;
const ownedBy = (pluginId: string) => (item: Item): boolean => item.managedBy?.plugin === pluginId;
const MAX_NAME = 48;

/**
 * Managed items of a plugin as library items: what an installed plugin
 * contributes (MCP servers and skills) kept in sync with its manifest and
 * installation. Items are written through the extension library's own
 * revisions, so resolution, the launch fence, package installation and
 * verification, write authorization and the gateway treat them exactly like
 * any other library item. Their credentials are the plugin's connections,
 * sealed into the library revision like administrator-entered ones.
 */
export class PluginContributions {
  constructor(readonly library: ExtensionLibraryStore, readonly assets: PluginAssetSource = officialPluginAssets) {}

  /**
   * Bring the library in line with one plugin inside `trx`: create, update,
   * activate or deactivate its managed items, or remove them on uninstall.
   * Writes nothing when nothing changed. An uninstall or a manifest that drops
   * an item is refused while an automation adds that item explicitly.
   */
  async sync(trx: Knex.Transaction, input: PluginSyncInput): Promise<void> {
    const head = await this.library.head(trx);
    const { snapshot } = head;
    const owned = ownedBy(input.pluginId);
    const previous = { servers: snapshot.servers.filter(owned), skills: snapshot.skills.filter(owned) };
    if (!input.record && !previous.servers.length && !previous.skills.length) return;
    const desired = input.record && input.manifest
      ? await this.desired(trx, snapshot, input as PluginSyncInput & { manifest: PluginManifest; record: PluginInstallationRecord })
      // Removed from the registry by an upgrade: keep the items, never apply them.
      : input.record ? { servers: previous.servers.map(deactivate), skills: previous.skills.map(deactivate), secrets: null, acknowledgements: {} } : { servers: [], skills: [], secrets: {}, acknowledgements: {} };
    await this.refuseReferencedRemoval(trx, input, previous, desired);
    const items = composeItems(snapshot, input.pluginId, desired);
    const stored = this.library.unseal(head);
    const secrets = desired.secrets === null ? stored : { ...withoutManaged(stored, previous.servers), ...desired.secrets };
    if (unchanged(snapshot, items, stored, secrets, desired.acknowledgements)) return;
    let written: ExtensionLibraryRevision;
    try { written = await this.library.writeRevision(trx, input.actor, head, items, secrets, new Map(), 'carry', desired.acknowledgements); }
    catch (error) { throw error instanceof ExtensionError ? new PluginError(error.status, error.message) : error; }
    await discardStaleOAuthConnections(trx, written.instanceId, written.servers, input.actor);
  }

  private async desired(trx: Knex.Transaction, snapshot: ExtensionLibraryRevision, input: PluginSyncInput & { manifest: PluginManifest; record: PluginInstallationRecord }) {
    const { manifest, record, pluginId } = input;
    const owned = ownedBy(pluginId);
    const pending = new Set(pendingAcknowledgements(manifest, record.acknowledgements).map(item => item.server));
    const names = new ManagedNames(pluginId, snapshot.servers);
    const limits = (existing: Item | undefined) => ({
      enabled: existing?.enabled ?? true,
      repositories: !existing || input.resetRepositories ? [...(record.repositories ?? [])] : existing.repositories,
      agents: existing?.agents ?? [], autoApply: existing?.autoApply ?? true,
    });
    const servers: ExtensionLibraryServer[] = []; const secrets: Record<string, string> = {}; const acknowledgements: ManagedAcknowledgements = {};
    for (const server of manifest.contributes.mcpServers) {
      const existing = snapshot.servers.find(s => owned(s) && s.managedBy!.item === server.name);
      const name = existing?.name ?? names.allocate(server.name);
      const active = record.enabled && !pending.has(server.name);
      const managedBy: ExtensionManagedBy = { plugin: pluginId, item: server.name, active };
      servers.push(libraryServer(manifest, server, name, { ...limits(existing), managedBy }));
      for (const [key, connection] of credentialConnections(server, name)) if (input.connections[connection]) secrets[key] = input.connections[connection];
      if (server.kind === 'package' && server.secretEnv.length) {
        const recorded = Object.hasOwn(record.acknowledgements, server.name) && !pending.has(server.name) ? record.acknowledgements[server.name] : undefined;
        acknowledgements[name] = recorded ? { actor: recorded.actor, at: recorded.at, package: recorded.package, version: recorded.version, secretEnv: [...recorded.secretEnv] } : undefined;
      }
    }
    const skills: ExtensionLibrarySkill[] = [];
    for (const skill of manifest.contributes.skills) {
      const existing = snapshot.skills.find(s => owned(s) && s.managedBy!.item === skill.name);
      const bundleId = await this.bundleFor(trx, snapshot, input, skill, existing);
      skills.push({ bundleId, ...limits(existing), managedBy: { plugin: pluginId, item: skill.name, active: record.enabled } });
    }
    return { servers, skills, secrets, acknowledgements };
  }

  /** The skill bundle of a plugin skill: the current one while its files are unchanged, otherwise a new bundle. */
  // eslint-disable-next-line max-params -- the transaction, library, sync input, skill and existing item are explicit inputs
  private async bundleFor(trx: Knex.Transaction, snapshot: ExtensionLibraryRevision, input: PluginSyncInput & { manifest: PluginManifest }, skill: { name: string; path: string }, existing: ExtensionLibrarySkill | undefined): Promise<string> {
    let validated: ReturnType<typeof validateSkillFiles>;
    try { validated = validateSkillFiles(await this.assets.skillFiles(input.manifest, skill.path)); }
    catch { throw new PluginError(409, `Skill ${skill.name} of the plugin is unavailable or invalid`); }
    const current = existing && snapshot.skillBundles.find(b => b.id === existing.bundleId);
    if (current && current.digest === validated.digest) return current.id;
    const descriptor: ExtensionSkillBundle = {
      id: randomUUID(), instanceId: snapshot.instanceId, digest: validated.digest, name: validated.name, files: validated.files.length, bytes: validated.bytes,
      source: { kind: 'plugin', plugin: input.pluginId, version: input.manifest.version, path: skill.path }, requirements: validated.requirements, createdAt: Date.now(), auditActor: input.actor,
    };
    await trx('extension_skill_bundles').insert({ id: descriptor.id, instance_id: descriptor.instanceId, descriptor: JSON.stringify(descriptor), files_json: JSON.stringify(validated.files) });
    return descriptor.id;
  }

  /** Managed items the change drops while an automation still adds them explicitly refuse it, naming the automations. */
  private async refuseReferencedRemoval(trx: Knex.Transaction, input: PluginSyncInput, previous: { servers: ExtensionLibraryServer[]; skills: ExtensionLibrarySkill[] }, desired: { servers: ExtensionLibraryServer[]; skills: ExtensionLibrarySkill[] }): Promise<void> {
    // A skill whose files changed gets a new bundle; that replacement is not a removal of the plugin's skill.
    const servers = previous.servers.filter(s => !desired.servers.some(d => d.name === s.name)).map(s => s.name);
    const skills = previous.skills.filter(s => !desired.skills.some(d => d.managedBy?.item === s.managedBy?.item)).map(s => s.bundleId);
    const using = await this.library.automationsAdding({ servers, skills }, trx);
    if (!using.length) return;
    const what = input.record ? 'before upgrading it' : 'before uninstalling it';
    throw new PluginError(409, `Automations add items of plugin ${input.pluginId} explicitly; remove them from ${using.map(a => `"${a.name}" (${[...a.servers, ...a.skills].join(', ')})`).join(', ')} ${what}`);
  }
}

/** Library names for new managed servers: the manifest name, or `<plugin>-<name>` when that is taken. */
class ManagedNames {
  private readonly taken: Set<string>;
  constructor(private readonly pluginId: string, servers: readonly ExtensionLibraryServer[]) { this.taken = new Set(servers.map(s => s.name)); }
  allocate(name: string): string {
    const prefixed = `${this.pluginId}-${name}`.slice(0, MAX_NAME);
    const chosen = !this.taken.has(name) ? name : !this.taken.has(prefixed) ? prefixed : null;
    if (!chosen) throw new PluginError(409, `The extension library already has servers named ${name} and ${prefixed}; rename one before enabling this plugin`);
    this.taken.add(chosen);
    return chosen;
  }
}

type Limits = Pick<ExtensionLibraryServer, 'enabled' | 'repositories' | 'agents' | 'autoApply'> & { managedBy: ExtensionManagedBy };
/** The library item of a manifest server under its library name. */
function libraryServer(manifest: PluginManifest, server: PluginMcpServer, name: string, limits: Limits): ExtensionLibraryServer {
  if (server.kind === 'https') {
    const connection = server.authentication === 'oauth' ? manifest.connections.find(c => c.name === server.connection) : undefined;
    const scopes = connection?.type === 'oauth' ? connection.scopes : undefined;
    return { kind: 'https', name, url: server.url, enabled: limits.enabled, tools: [...server.tools], capability: server.capability, authentication: server.authentication, ...(scopes ? { scopes: [...scopes] } : {}), repositories: limits.repositories, agents: limits.agents, autoApply: limits.autoApply, managedBy: limits.managedBy };
  }
  return {
    name, enabled: limits.enabled, tools: [...server.tools], capability: server.capability, kind: 'package', ecosystem: server.ecosystem, package: server.package, version: server.version,
    integrity: server.integrity, ...(server.bin ? { bin: server.bin } : {}), args: [...server.args], env: server.env.map(e => ({ ...e })), secretEnv: server.secretEnv.map(e => e.name),
    repositories: limits.repositories, agents: limits.agents, autoApply: limits.autoApply, managedBy: limits.managedBy,
  };
}

/** Sealed-credential keys of a managed server and the plugin connection each comes from. */
function credentialConnections(server: PluginMcpServer, name: string): [string, string][] {
  if (server.kind === 'package') return server.secretEnv.map(secret => [extensionPackageSecretKey(name, secret.name), secret.connection]);
  return server.authentication === 'bearer' && server.connection ? [[name, server.connection]] : [];
}

const deactivate = <T extends Item>(item: T): T => (item.managedBy ? { ...item, managedBy: { ...item.managedBy, active: false } } : item);
const withoutManaged = (secrets: Record<string, string>, servers: readonly ExtensionLibraryServer[]) => Object.fromEntries(Object.entries(secrets).filter(([key]) => !servers.some(s => s.name === credentialOwner(key))));

/** The next library items: other items unchanged and in place, the plugin's items replaced in place, new ones appended. */
function composeItems(snapshot: ExtensionLibraryRevision, pluginId: string, desired: { servers: ExtensionLibraryServer[]; skills: ExtensionLibrarySkill[] }): ExtensionLibraryItems {
  const owned = ownedBy(pluginId);
  const place = <T extends Item>(current: readonly T[], next: readonly T[], same: (a: T, b: T) => boolean): T[] => {
    const result: T[] = [];
    for (const item of current) {
      if (!owned(item)) { result.push(item); continue; }
      const replacement = next.find(n => same(n, item));
      if (replacement) result.push(replacement);
    }
    return [...result, ...next.filter(n => !result.includes(n))];
  };
  const parsed = extensionLibraryInputSchema.safeParse({
    version: EXTENSION_LIBRARY_VERSION,
    servers: place(snapshot.servers, desired.servers, (a, b) => a.managedBy?.item === b.managedBy?.item),
    skills: place(snapshot.skills, desired.skills, (a, b) => a.managedBy?.item === b.managedBy?.item),
  });
  if (!parsed.success) throw new PluginError(409, 'The extension library cannot hold this plugin\'s items; it holds at most 32 servers and 32 skills with unique names');
  return parsed.data;
}

// eslint-disable-next-line max-params -- the base revision, next items, stored and next credentials and acknowledgements are compared together
function unchanged(snapshot: ExtensionLibraryRevision, items: ExtensionLibraryItems, stored: Record<string, string>, secrets: Record<string, string>, acknowledgements: ManagedAcknowledgements): boolean {
  const sorted = (value: Record<string, string>) => JSON.stringify(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)));
  if (JSON.stringify({ servers: snapshot.servers, skills: snapshot.skills }) !== JSON.stringify({ servers: items.servers, skills: items.skills })) return false;
  if (sorted(stored) !== sorted(secrets)) return false;
  return Object.entries(acknowledgements).every(([name, value]) => JSON.stringify(value) === JSON.stringify(snapshot.acknowledgements?.[name]));
}

/** What a plugin contributes and where its managed items are in the library. */
// eslint-disable-next-line max-params -- the manifest, plugin id, library, template ids and availability are explicit inputs
export function pluginContributionViews(manifest: PluginManifest | null, pluginId: string, library: Pick<ExtensionLibraryRevision, 'servers' | 'skills'> | null, templateIds: Map<string, string>, templatesAvailable: boolean): PluginContributionViews {
  const owned = ownedBy(pluginId);
  const servers = library?.servers.filter(owned) ?? []; const skills = library?.skills.filter(owned) ?? [];
  const active = (item: Item) => item.managedBy?.active === true;
  return {
    mcpServers: (manifest?.contributes.mcpServers ?? []).map(server => {
      const item = servers.find(s => s.managedBy?.item === server.name);
      return { name: server.name, kind: server.kind, managed: item ? { kind: 'server', name: item.name, enabled: item.enabled, active: active(item) } : null, href: PLUGIN_LIBRARY_HREF };
    }),
    skills: (manifest?.contributes.skills ?? []).map(skill => {
      const item = skills.find(s => s.managedBy?.item === skill.name);
      return { name: skill.name, managed: item ? { kind: 'skill', bundleId: item.bundleId, enabled: item.enabled, active: active(item) } : null, href: PLUGIN_LIBRARY_HREF };
    }),
    automationTemplates: (manifest?.contributes.automationTemplates ?? []).map(template => ({ id: template.id, catalogId: templateIds.get(template.id) ?? template.id, available: templatesAvailable, href: PLUGIN_TEMPLATE_CATALOG_HREF })),
  };
}

/** The managed servers of a plugin that use one of its `oauth` connections, by library name. */
export function oauthServersOf(manifest: PluginManifest, pluginId: string, library: Pick<ExtensionLibraryRevision, 'servers'>, connection: string): ExtensionLibraryServer[] {
  const items = manifest.contributes.mcpServers.filter(s => s.kind === 'https' && s.authentication === 'oauth' && s.connection === connection).map(s => s.name);
  return library.servers.filter(s => s.managedBy?.plugin === pluginId && items.includes(s.managedBy.item) && s.kind === 'https' && s.authentication === 'oauth');
}
