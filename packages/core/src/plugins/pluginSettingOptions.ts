import type { Knex } from 'knex';
import { parsePluginSettingOptions, pluginIdSchema, type PluginSettingOption } from '@propr/shared';
import { officialPluginCatalog } from './pluginCatalog.js';
import { runPluginHandler, type RunPluginHandlerOptions } from './pluginHandlerRunner.js';
import { PluginError, installationRecord, type PluginInstallationRow } from './pluginState.js';

/**
 * The choices of a setting whose manifest entry names an `optionsFrom`
 * handler, for the configure form: the handler runs once, now, with a
 * `setting_options` input. It may run while the plugin is disabled (it is
 * being configured), with outbound HTTP to the manifest's hosts and the
 * plugin's state, but no `ctx.propr` permission at all, whatever was granted.
 * Its failure (typically: the service is not connected yet) is the refusal's
 * message, redacted like every handler error. Nothing is recorded as a
 * delivery; the route that calls this is for administrators only.
 */
export async function loadPluginSettingOptions(database: Knex, pluginId: string, settingKey: string, options: Omit<RunPluginHandlerOptions, 'database'> = {}): Promise<{ options: PluginSettingOption[] }> {
  if (!pluginIdSchema.safeParse(pluginId).success) throw new PluginError(404, 'Plugin not found');
  const manifest = (await (options.catalog ?? officialPluginCatalog)()).find(m => m.id === pluginId);
  if (!manifest) throw new PluginError(404, 'Plugin not found');
  const setting = Object.hasOwn(manifest.settings.properties, settingKey) ? manifest.settings.properties[settingKey] : undefined;
  const handler = setting && (setting.type === 'string' || setting.type === 'object') ? setting.optionsFrom : undefined;
  if (!handler) throw new PluginError(404, `Setting ${settingKey.slice(0, 48)} has no choices to load`);
  const row = await database('plugin_installations').where({ plugin_id: pluginId }).first() as PluginInstallationRow | undefined;
  if (!row) throw new PluginError(409, 'Install the plugin first');
  // No ctx.propr permission: listing choices only reads the service, through ctx.http.
  const record = { ...installationRecord(row), grantedPermissions: [] };
  const run = await runPluginHandler({ pluginId, manifest, record }, handler, { kind: 'setting_options', setting: settingKey }, { ...options, database, allowDisabled: true });
  if (run.outcome === 'failed') throw new PluginError(409, run.error ?? 'The choices could not be loaded');
  const parsed = parsePluginSettingOptions(run.result);
  if (!parsed) throw new PluginError(502, 'The plugin returned choices ProPR cannot show');
  return { options: parsed };
}
