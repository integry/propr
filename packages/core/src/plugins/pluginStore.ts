import { createHash } from 'node:crypto';
import type { Knex } from 'knex';
import {
  PLUGIN_REPOSITORY_LIMIT, PLUGIN_REPOSITORY_PATTERN, PLUGIN_SECRET_PATTERN, defaultPluginSettings, missingRequiredPluginSettings, pluginIdSchema,
  requiredPluginConnections, validatePluginSettings,
  type PluginAuditAction, type PluginAuditEvent, type PluginConnectionState, type PluginDetail, type PluginManifest, type PluginView,
} from '@propr/shared';
import logger from '../utils/logger.js';
import { sealExtensionSecrets, unsealExtensionSecrets } from '../extensions/privateSecrets.js';
import { officialPluginCatalog, type PluginCatalogSource } from './pluginCatalog.js';
import { ExtensionError, ExtensionLibraryStore } from '../extensions/extensionProfileStore.js';
import { extensionOAuth, type ExtensionOAuthUrls } from '../extensions/extensionOAuthStore.js';
import { OAUTH_PENDING, hasOAuthTables, oauthConnectionStates } from '../extensions/extensionOAuthState.js';
import { PluginContributions, oauthServersOf, pluginContributionViews } from './pluginContributions.js';
import { pluginTemplateIds } from './pluginTemplates.js';
import {
  PluginError, enableBlockers, installationRecord, nextAcknowledgements, parseAcknowledgements, pendingAcknowledgements, pendingPermissions, pluginView,
  type PluginInstallationRow, type PluginSecretRow,
} from './pluginState.js';

export { PluginError } from './pluginState.js';

/** Authenticated binding of a sealed connection secret: it opens only for this instance, plugin and connection. */
export const pluginSecretIdentity = (instanceId: string, pluginId: string, connection: string) => `plugin/${instanceId}/${pluginId}/${connection}`;
const AUDIT_LIMIT = 50;
const SECRET_COLUMNS = ['plugin_id', 'connection_name', 'set_by', 'set_at'] as const;

interface Loaded { manifest: PluginManifest | null; row: PluginInstallationRow | undefined; secrets: PluginSecretRow[] }
type Change = { action: PluginAuditAction; detail?: Record<string, unknown>; resetRepositories?: boolean; deactivateOnly?: boolean };
/** Run a library or OAuth operation; its refusals become plugin refusals with the same status and message. */
async function viaLibrary<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); } catch (error) { throw error instanceof ExtensionError ? new PluginError(error.status, error.message) : error; }
}

/**
 * Installation state of plugins on this instance. Every method authorizes a
 * current durable instance administrator; connection secrets are sealed with
 * the extension private-secret mechanism and never returned. Every management
 * action is appended to `plugin_audit`. Every write also brings the plugin's
 * managed extension library items in line with it (`PluginContributions`),
 * in the same transaction.
 */
export class PluginStore {
  // eslint-disable-next-line max-params -- the database, environment, catalog, clock and contribution sync are injectable dependencies
  constructor(
    readonly database: Knex,
    readonly environment: NodeJS.ProcessEnv = process.env,
    readonly catalog: PluginCatalogSource = officialPluginCatalog,
    readonly now: () => number = Date.now,
    readonly contributions: PluginContributions = new PluginContributions(new ExtensionLibraryStore(database, environment)),
  ) {}
  get library(): ExtensionLibraryStore { return this.contributions.library; }

  async authorize(actor: string, database: Knex = this.database): Promise<void> {
    // Durable, uncached instance authority; no session or repository fallback.
    if (!/^[1-9][0-9]*$/.test(actor) || !(await database('instance_members').where({ github_user_id: actor, role: 'admin' }).first('github_user_id'))) throw new PluginError(403, 'Current durable instance administrator access is required');
  }
  private async instanceId(database: Knex): Promise<string> {
    const row = await database('extension_instance_identity').where({ id: 1 }).first('instance_id');
    if (!row) throw new PluginError(503, 'Instance identity unavailable');
    return row.instance_id as string;
  }
  private async manifests(): Promise<readonly PluginManifest[]> { return this.catalog(); }
  private static pluginId(id: unknown): string {
    const parsed = pluginIdSchema.safeParse(id);
    if (!parsed.success) throw new PluginError(404, 'Plugin not found');
    return parsed.data;
  }
  async load(id: string, database: Knex, allowMissing = false): Promise<Loaded> {
    const manifest = (await this.manifests()).find(m => m.id === id) ?? null;
    const row = await database('plugin_installations').where({ plugin_id: id }).first() as PluginInstallationRow | undefined;
    const secrets = row ? await database('plugin_secrets').where({ plugin_id: id }).select(...SECRET_COLUMNS) as PluginSecretRow[] : [];
    if (!manifest && !row && !allowMissing) throw new PluginError(404, 'Plugin not found');
    return { manifest, row, secrets };
  }
  private static installed(loaded: Loaded): PluginInstallationRow {
    if (!loaded.row) throw new PluginError(409, 'The plugin is not installed');
    return loaded.row;
  }
  private static current(loaded: Loaded): PluginManifest {
    if (!loaded.manifest) throw new PluginError(409, 'The plugin is no longer in this ProPR version\'s registry; it can only be disabled or uninstalled');
    return loaded.manifest;
  }
  // eslint-disable-next-line max-params -- the transaction, plugin, action, actor and detail are explicit audit inputs
  private async audit(trx: Knex, pluginId: string, action: PluginAuditAction, actor: string, detail: Record<string, unknown> = {}): Promise<void> {
    await trx('plugin_audit').insert({ plugin_id: pluginId, action, actor, at: this.now(), detail: JSON.stringify(detail) });
    logger.info({ pluginId, action, actor }, '[plugins] Plugin management action');
  }
  /**
   * One management write: authorizes inside the transaction, runs `change`,
   * records the audit event and returns the plugin's new state.
   */
  private async write(actor: string, id: unknown, change: (trx: Knex.Transaction, loaded: Loaded, pluginId: string) => Promise<Change>): Promise<PluginView> {
    const pluginId = PluginStore.pluginId(id);
    await this.database.transaction(async trx => {
      await this.authorize(actor, trx);
      const { action, detail, resetRepositories, deactivateOnly } = await change(trx, await this.load(pluginId, trx), pluginId);
      await this.applyContributions(trx, pluginId, actor, { resetRepositories, deactivateOnly });
      await this.audit(trx, pluginId, action, actor, detail);
    });
    return this.view(pluginId, await this.load(pluginId, this.database, true));
  }
  /** Sync the plugin's managed library items with its installation as it is now inside `trx`. */
  private async applyContributions(trx: Knex.Transaction, pluginId: string, actor: string, options: { resetRepositories?: boolean; deactivateOnly?: boolean } = {}): Promise<void> {
    const loaded = await this.load(pluginId, trx, true);
    const connections: Record<string, string> = {};
    const tokens = loaded.manifest?.connections.filter(c => c.type === 'token').map(c => c.name) ?? [];
    for (const secret of loaded.secrets.filter(s => tokens.includes(s.connection_name))) {
      const value = await this.connectionSecret(pluginId, secret.connection_name, trx);
      if (value) connections[secret.connection_name] = value;
    }
    await viaLibrary(() => this.contributions.sync(trx, { pluginId, manifest: loaded.manifest, record: loaded.row ? installationRecord(loaded.row) : null, connections, actor, resetRepositories: options.resetRepositories ?? false, deactivateOnly: options.deactivateOnly ?? false }));
  }
  /** The state view with OAuth connection states and the managed items and templates the plugin contributes. */
  private async view(pluginId: string, loaded: Loaded, library?: Awaited<ReturnType<ExtensionLibraryStore['head']>>['snapshot'], templateIds?: Map<string, Map<string, string>>): Promise<PluginView> {
    const base = pluginView(pluginId, loaded.manifest, loaded.row, loaded.secrets);
    const { manifest, row } = loaded;
    if (!manifest) return base;
    const snapshot = library ?? (await this.library.head()).snapshot;
    const ids = templateIds ?? pluginTemplateIds(await this.manifests());
    const connections = [];
    for (const status of base.connections) {
      const servers = status.type === 'oauth' && row ? oauthServersOf(manifest, pluginId, snapshot, status.name) : [];
      if (!servers.length) { connections.push(status); continue; }
      const states = Object.values(await oauthConnectionStates(this.database, snapshot.instanceId, servers));
      const state: PluginConnectionState = states.every(s => s === 'connected') ? 'connected' : states.includes('needs_sign_in') ? 'needs_sign_in' : 'not_connected';
      connections.push({ ...status, state });
    }
    return { ...base, connections, contributions: pluginContributionViews(manifest, pluginId, row ? snapshot : null, ids.get(pluginId) ?? new Map(), Boolean(row?.enabled)) };
  }
  /** Columns every update sets. A write with nothing awaiting approval also moves the installed version to the current manifest. */
  private touched(actor: string, loaded: Loaded): Record<string, unknown> {
    const update: Record<string, unknown> = { updated_by: actor, updated_at: this.now() };
    if (loaded.manifest && loaded.row) {
      const record = installationRecord(loaded.row);
      if (!pendingPermissions(loaded.manifest, record.grantedPermissions).length && !pendingAcknowledgements(loaded.manifest, record.acknowledgements).length) update.manifest_version = loaded.manifest.version;
    }
    return update;
  }

  /** Every plugin of the registry plus installed plugins an upgrade removed from it, with state. */
  async list(actor: string): Promise<PluginView[]> {
    await this.authorize(actor);
    const manifests = await this.manifests();
    const rows = await this.database('plugin_installations').select() as PluginInstallationRow[];
    const secrets = await this.database('plugin_secrets').select(...SECRET_COLUMNS) as PluginSecretRow[];
    const ids = [...manifests.map(m => m.id), ...rows.map(r => r.plugin_id).filter(id => !manifests.some(m => m.id === id)).sort()];
    const { snapshot } = await this.library.head(); const templateIds = pluginTemplateIds(manifests);
    const views: PluginView[] = [];
    for (const id of ids) views.push(await this.view(id, { manifest: manifests.find(m => m.id === id) ?? null, row: rows.find(r => r.plugin_id === id), secrets: secrets.filter(s => s.plugin_id === id) }, snapshot, templateIds));
    await this.authorize(actor);
    return views;
  }
  /** One plugin: manifest, state, settings, connection states, pending approvals and its newest audit events. */
  async get(actor: string, id: unknown): Promise<PluginDetail> {
    await this.authorize(actor);
    const pluginId = PluginStore.pluginId(id);
    const view = await this.view(pluginId, await this.load(pluginId, this.database));
    const audit = await this.auditEvents(pluginId);
    await this.authorize(actor);
    return { ...view, audit };
  }
  private async auditEvents(pluginId: string): Promise<PluginAuditEvent[]> {
    const rows = await this.database('plugin_audit').where({ plugin_id: pluginId }).orderBy('id', 'desc').limit(AUDIT_LIMIT).select('action', 'actor', 'at', 'detail');
    return rows.map(row => ({ action: row.action, actor: row.actor, at: Number(row.at), detail: JSON.parse(row.detail || '{}') }));
  }

  /** Install a registry plugin, disabled, with its default settings and its manifest's permissions granted. */
  async install(actor: string, id: unknown, acknowledgementsInput?: unknown): Promise<PluginView> {
    return this.write(actor, id, async (trx, loaded, pluginId) => {
      const manifest = PluginStore.current(loaded);
      if (loaded.row) throw new PluginError(409, 'The plugin is already installed');
      const acknowledged = parseAcknowledgements(acknowledgementsInput, manifest);
      const now = this.now();
      const acknowledgements = nextAcknowledgements(manifest, {}, acknowledged, actor, now);
      await trx('plugin_installations').insert({
        plugin_id: pluginId, manifest_version: manifest.version, enabled: false,
        settings: JSON.stringify(defaultPluginSettings(manifest.settings)), repositories: null,
        granted_permissions: JSON.stringify([...manifest.permissions]), acknowledgements: JSON.stringify(acknowledgements),
        installed_by: actor, installed_at: now, updated_by: actor, updated_at: now,
      });
      return { action: 'install', detail: { version: manifest.version, permissions: [...manifest.permissions], acknowledged: Object.keys(acknowledgements) } };
    });
  }

  /** Replace the settings, validated against the current manifest's settings schema. */
  async updateSettings(actor: string, id: unknown, settings: unknown): Promise<PluginView> {
    return this.write(actor, id, async (trx, loaded, pluginId) => {
      const row = PluginStore.installed(loaded); const manifest = PluginStore.current(loaded);
      const result = validatePluginSettings(manifest.settings, settings);
      if (!result.ok) throw new PluginError(400, result.errors.join('; '));
      const missing = missingRequiredPluginSettings(manifest.settings, result.settings);
      if (row.enabled && missing.length) throw new PluginError(409, `Required settings cannot be removed while the plugin is enabled: ${missing.join(', ')}`);
      const previous = installationRecord(row).settings;
      const changed = [...new Set([...Object.keys(previous), ...Object.keys(result.settings)])].filter(key => JSON.stringify(previous[key]) !== JSON.stringify(result.settings[key])).sort();
      await trx('plugin_installations').where({ plugin_id: pluginId }).update({ settings: JSON.stringify(result.settings), ...this.touched(actor, loaded) });
      return { action: 'update_settings', detail: { changed } };
    });
  }

  /** Limit the plugin to repositories (`owner/repo`); `null` or an empty list means all repositories. */
  async setRepositories(actor: string, id: unknown, repositories: unknown): Promise<PluginView> {
    const limit = parseRepositories(repositories);
    return this.write(actor, id, async (trx, loaded, pluginId) => {
      PluginStore.installed(loaded);
      await trx('plugin_installations').where({ plugin_id: pluginId }).update({ repositories: limit ? JSON.stringify(limit) : null, ...this.touched(actor, loaded) });
      return { action: 'set_repositories', detail: { repositories: limit }, resetRepositories: true };
    });
  }

  /** Set (a string) or clear (`null`) a `token` or `signing_secret` connection. The value is sealed and never returned. */
  async setConnection(actor: string, id: unknown, name: unknown, value: unknown): Promise<PluginView> {
    if (value !== null && (typeof value !== 'string' || !PLUGIN_SECRET_PATTERN.test(value))) throw new PluginError(400, 'A connection secret is 1 to 4096 printable characters without spaces');
    return this.write(actor, id, async (trx, loaded, pluginId) => {
      const row = PluginStore.installed(loaded); const manifest = PluginStore.current(loaded);
      const connection = manifest.connections.find(c => c.name === name);
      if (!connection) throw new PluginError(404, 'Connection not found');
      if (connection.type === 'oauth') throw new PluginError(400, 'An OAuth connection is connected through its sign-in, not with a value');
      if (value === null) {
        if (row.enabled && requiredPluginConnections(manifest).includes(connection.name)) throw new PluginError(409, `Connection ${connection.name} is required while the plugin is enabled; disable it first`);
        await trx('plugin_secrets').where({ plugin_id: pluginId, connection_name: connection.name }).delete();
        await trx('plugin_installations').where({ plugin_id: pluginId }).update(this.touched(actor, loaded));
        return { action: 'clear_connection', detail: { connection: connection.name } };
      }
      const sealed = sealExtensionSecrets({ value }, pluginSecretIdentity(await this.instanceId(trx), pluginId, connection.name), this.environment);
      await trx('plugin_secrets').insert({ plugin_id: pluginId, connection_name: connection.name, sealed, set_by: actor, set_at: this.now() })
        .onConflict(['plugin_id', 'connection_name']).merge();
      await trx('plugin_installations').where({ plugin_id: pluginId }).update(this.touched(actor, loaded));
      return { action: 'set_connection', detail: { connection: connection.name, type: connection.type } };
    });
  }

  /** Enable (refused, with the reasons, while something required is missing) or disable. Disabling keeps settings and connections. */
  async setEnabled(actor: string, id: unknown, enabled: unknown): Promise<PluginView> {
    if (typeof enabled !== 'boolean') throw new PluginError(400, 'enabled must be true or false');
    return this.write(actor, id, async (trx, loaded, pluginId) => {
      const row = PluginStore.installed(loaded);
      if (enabled) {
        const blockers = enableBlockers(loaded.manifest, installationRecord(row), loaded.secrets);
        if (blockers.length) throw new PluginError(409, `The plugin cannot be enabled: ${blockers.join('; ')}`);
      }
      await trx('plugin_installations').where({ plugin_id: pluginId }).update({ enabled, ...this.touched(actor, loaded) });
      // A disable only deactivates the managed items as they are: it never depends on applying an upgraded manifest or its assets.
      return { action: enabled ? 'enable' : 'disable', deactivateOnly: !enabled };
    });
  }

  /** Grant the current manifest's permissions and record the secret acknowledgements it needs again. */
  async approve(actor: string, id: unknown, acknowledgementsInput?: unknown): Promise<PluginView> {
    return this.write(actor, id, async (trx, loaded, pluginId) => {
      const row = PluginStore.installed(loaded); const manifest = PluginStore.current(loaded);
      const record = installationRecord(row);
      const permissions = pendingPermissions(manifest, record.grantedPermissions);
      if (!permissions.length && !pendingAcknowledgements(manifest, record.acknowledgements).length) throw new PluginError(409, 'Nothing awaits approval');
      const acknowledgements = nextAcknowledgements(manifest, record.acknowledgements, parseAcknowledgements(acknowledgementsInput, manifest), actor, this.now());
      await trx('plugin_installations').where({ plugin_id: pluginId }).update({
        granted_permissions: JSON.stringify([...manifest.permissions]), acknowledgements: JSON.stringify(acknowledgements),
        manifest_version: manifest.version, updated_by: actor, updated_at: this.now(),
      });
      return { action: 'approve', detail: { version: manifest.version, permissions: [...manifest.permissions], added: permissions, acknowledged: Object.keys(acknowledgements) } };
    });
  }

  /** Delete the installation, its settings and its connections. `confirm` must repeat the plugin id. The audit trail stays. */
  async uninstall(actor: string, id: unknown, confirm: unknown): Promise<PluginView> {
    return this.write(actor, id, async (trx, loaded, pluginId) => {
      const row = PluginStore.installed(loaded);
      if (confirm !== pluginId) throw new PluginError(400, 'Confirm the uninstall by repeating the plugin id; settings and connections are deleted');
      await trx('plugin_secrets').where({ plugin_id: pluginId }).delete();
      await trx('plugin_installations').where({ plugin_id: pluginId }).delete();
      return { action: 'uninstall', detail: { version: row.manifest_version } };
    });
  }

  /** Core-internal: the stored secret of a connection, for applying contributions. Never exposed through the API. */
  async connectionSecret(pluginId: string, connection: string, database: Knex = this.database): Promise<string | null> {
    const row = await database('plugin_secrets').where({ plugin_id: pluginId, connection_name: connection }).first('sealed');
    if (!row) return null;
    return unsealExtensionSecrets(row.sealed, pluginSecretIdentity(await this.instanceId(database), pluginId, connection), this.environment).value ?? null;
  }

  /** The installed plugin, its current manifest and the managed servers using one of its `oauth` connections. */
  private async oauthTarget(id: unknown, name: unknown) {
    const pluginId = PluginStore.pluginId(id);
    const loaded = await this.load(pluginId, this.database);
    PluginStore.installed(loaded); const manifest = PluginStore.current(loaded);
    const connection = manifest.connections.find(c => c.name === name && c.type === 'oauth');
    if (!connection) throw new PluginError(404, 'OAuth connection not found');
    const { snapshot } = await this.library.head();
    const servers = oauthServersOf(manifest, pluginId, snapshot, connection.name);
    if (!servers.length) throw new PluginError(409, `No MCP server of this plugin uses connection ${connection.name}`);
    return { pluginId, connection: connection.name, servers, instanceId: snapshot.instanceId };
  }
  private async auditOnly(pluginId: string, action: PluginAuditAction, actor: string, detail: Record<string, unknown>): Promise<void> {
    await this.database.transaction(async trx => { await this.authorize(actor, trx); await this.audit(trx, pluginId, action, actor, detail); });
  }
  /**
   * Start the extension OAuth sign-in of an `oauth` connection, for the first
   * of its managed servers not yet connected. ProPR identifies itself as it
   * does for library servers; the provider redirects to the extension callback.
   */
  // eslint-disable-next-line max-params -- the actor, plugin, connection, browser session and instance URLs are explicit inputs
  async startOAuth(actor: string, id: unknown, name: unknown, sessionId: string, urls: ExtensionOAuthUrls): Promise<{ authorizationUrl: string; server: string }> {
    await this.authorize(actor);
    const target = await this.oauthTarget(id, name);
    const states = await oauthConnectionStates(this.database, target.instanceId, target.servers);
    const server = target.servers.find(s => states[s.name] !== 'connected') ?? target.servers[0];
    const { authorizationUrl } = await viaLibrary(() => extensionOAuth(this.library).startSignIn(actor, sessionId, server.name, urls));
    await this.auditOnly(target.pluginId, 'start_oauth', actor, { connection: target.connection, server: server.name });
    return { authorizationUrl, server: server.name };
  }
  /** Complete a sign-in this plugin connection started (the callback's `state` and `code`); the extension callback completes it too. */
  // eslint-disable-next-line max-params -- the actor, plugin, connection, browser session and callback query are explicit inputs
  async completeOAuth(actor: string, id: unknown, name: unknown, sessionId: string, query: { state?: unknown; code?: unknown; error?: unknown; iss?: unknown }): Promise<PluginView> {
    await this.authorize(actor);
    const target = await this.oauthTarget(id, name);
    // Only a sign-in pending for one of this connection's servers; checked before the single-use state is consumed.
    const pending = typeof query.state === 'string' && await hasOAuthTables(this.database) ? await this.database(OAUTH_PENDING).where({ state_hash: createHash('sha256').update(query.state).digest('hex') }).first('server_name') : undefined;
    if (!pending || !target.servers.some(s => s.name === pending.server_name)) throw new PluginError(400, 'Unknown, used or expired sign-in request');
    const { name: server } = await viaLibrary(() => extensionOAuth(this.library).completeSignIn(actor, sessionId, query));
    await this.auditOnly(target.pluginId, 'complete_oauth', actor, { connection: target.connection, server });
    return this.view(target.pluginId, await this.load(target.pluginId, this.database, true));
  }
  /** Disconnect every managed server of an `oauth` connection: tokens are revoked where possible and deleted. */
  async disconnectOAuth(actor: string, id: unknown, name: unknown): Promise<PluginView> {
    await this.authorize(actor);
    const target = await this.oauthTarget(id, name);
    for (const server of target.servers) await viaLibrary(() => extensionOAuth(this.library).disconnect(actor, server.name));
    await this.auditOnly(target.pluginId, 'disconnect_oauth', actor, { connection: target.connection, servers: target.servers.map(s => s.name) });
    return this.view(target.pluginId, await this.load(target.pluginId, this.database, true));
  }
}

function parseRepositories(value: unknown): string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > PLUGIN_REPOSITORY_LIMIT || value.some(item => typeof item !== 'string' || !PLUGIN_REPOSITORY_PATTERN.test(item))) throw new PluginError(400, `repositories must be null or up to ${PLUGIN_REPOSITORY_LIMIT} owner/repo names`);
  const unique = [...new Set(value as string[])];
  return unique.length ? unique : null;
}
