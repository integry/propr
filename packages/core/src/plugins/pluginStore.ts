import type { Knex } from 'knex';
import {
  PLUGIN_REPOSITORY_LIMIT, PLUGIN_REPOSITORY_PATTERN, PLUGIN_SECRET_PATTERN, defaultPluginSettings, missingRequiredPluginSettings, pluginIdSchema,
  requiredPluginConnections, validatePluginSettings,
  type PluginAuditAction, type PluginAuditEvent, type PluginDetail, type PluginManifest, type PluginView,
} from '@propr/shared';
import logger from '../utils/logger.js';
import { sealExtensionSecrets, unsealExtensionSecrets } from '../extensions/privateSecrets.js';
import { officialPluginCatalog, type PluginCatalogSource } from './pluginCatalog.js';
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

/**
 * Installation state of plugins on this instance. Every method authorizes a
 * current durable instance administrator; connection secrets are sealed with
 * the extension private-secret mechanism and never returned. Every management
 * action is appended to `plugin_audit`.
 */
export class PluginStore {
  constructor(
    readonly database: Knex,
    readonly environment: NodeJS.ProcessEnv = process.env,
    readonly catalog: PluginCatalogSource = officialPluginCatalog,
    readonly now: () => number = Date.now,
  ) {}

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
  private async load(id: string, database: Knex, allowMissing = false): Promise<Loaded> {
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
  private async write(actor: string, id: unknown, change: (trx: Knex.Transaction, loaded: Loaded, pluginId: string) => Promise<{ action: PluginAuditAction; detail?: Record<string, unknown> }>): Promise<PluginView> {
    const pluginId = PluginStore.pluginId(id);
    await this.database.transaction(async trx => {
      await this.authorize(actor, trx);
      const { action, detail } = await change(trx, await this.load(pluginId, trx), pluginId);
      await this.audit(trx, pluginId, action, actor, detail);
    });
    const after = await this.load(pluginId, this.database, true);
    return pluginView(pluginId, after.manifest, after.row, after.secrets);
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
    const views = ids.map(id => pluginView(id, manifests.find(m => m.id === id) ?? null, rows.find(r => r.plugin_id === id), secrets.filter(s => s.plugin_id === id)));
    await this.authorize(actor);
    return views;
  }
  /** One plugin: manifest, state, settings, connection states, pending approvals and its newest audit events. */
  async get(actor: string, id: unknown): Promise<PluginDetail> {
    await this.authorize(actor);
    const pluginId = PluginStore.pluginId(id);
    const { manifest, row, secrets } = await this.load(pluginId, this.database);
    const audit = await this.auditEvents(pluginId);
    await this.authorize(actor);
    return { ...pluginView(pluginId, manifest, row, secrets), audit };
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
      return { action: 'set_repositories', detail: { repositories: limit } };
    });
  }

  /** Set (a string) or clear (`null`) a `token` or `signing_secret` connection. The value is sealed and never returned. */
  async setConnection(actor: string, id: unknown, name: unknown, value: unknown): Promise<PluginView> {
    if (value !== null && (typeof value !== 'string' || !PLUGIN_SECRET_PATTERN.test(value))) throw new PluginError(400, 'A connection secret is 1 to 4096 printable characters without spaces');
    return this.write(actor, id, async (trx, loaded, pluginId) => {
      const row = PluginStore.installed(loaded); const manifest = PluginStore.current(loaded);
      const connection = manifest.connections.find(c => c.name === name);
      if (!connection) throw new PluginError(404, 'Connection not found');
      if (connection.type === 'oauth') throw new PluginError(400, 'OAuth connections are not available yet');
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
      return { action: enabled ? 'enable' : 'disable' };
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
  async connectionSecret(pluginId: string, connection: string): Promise<string | null> {
    const row = await this.database('plugin_secrets').where({ plugin_id: pluginId, connection_name: connection }).first('sealed');
    if (!row) return null;
    return unsealExtensionSecrets(row.sealed, pluginSecretIdentity(await this.instanceId(this.database), pluginId, connection), this.environment).value ?? null;
  }
}

function parseRepositories(value: unknown): string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > PLUGIN_REPOSITORY_LIMIT || value.some(item => typeof item !== 'string' || !PLUGIN_REPOSITORY_PATTERN.test(item))) throw new PluginError(400, `repositories must be null or up to ${PLUGIN_REPOSITORY_LIMIT} owner/repo names`);
  const unique = [...new Set(value as string[])];
  return unique.length ? unique : null;
}
