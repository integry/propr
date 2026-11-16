import { pluginIdSchema, readPluginSettingOptions, type PluginSettingOption } from '@propr/shared';
import { officialPluginCatalog } from './pluginCatalog.js';
import { runPluginHandler, type RunPluginHandlerOptions } from './pluginHandlerRunner.js';
import { PluginError, installationRecord, type PluginInstallationRow } from './pluginState.js';

/**
 * The choices of an `optionsFrom` select setting, for the configure form:
 * the handler the manifest names runs with a `setting_options` input and the
 * installation's saved settings and connections, reading the service through
 * `ctx.http` (the manifest's outbound hosts only, the connection's credential
 * injected by ProPR). The plugin must be installed; it need not be enabled
 * yet, since it is configured first, but `ctx.propr` stays unavailable until
 * it is. The callers (the settings-options route) admit administrators only.
 *
 * Refusals are `PluginError`s: 404 for an unknown plugin or a setting without
 * `optionsFrom`, 409 when the plugin is not installed or the handler says the
 * connection is not made (its message tells what to set), 502 when the
 * handler failed or answered something that is not a list of choices.
 */
export type PluginSettingOptionsDeps = Omit<RunPluginHandlerOptions, 'allowDisabled'>;

const SETTING_KEY = /^[A-Za-z][A-Za-z0-9_]{0,47}$/;

export async function loadPluginSettingOptions(deps: PluginSettingOptionsDeps, pluginId: unknown, setting: unknown): Promise<{ options: PluginSettingOption[] }> {
  const id = pluginIdSchema.safeParse(pluginId);
  if (!id.success) throw new PluginError(404, 'Plugin not found');
  const manifest = (await (deps.catalog ?? officialPluginCatalog)()).find(m => m.id === id.data);
  if (!manifest) throw new PluginError(404, 'Plugin not found');
  const key = typeof setting === 'string' && SETTING_KEY.test(setting) ? setting : null;
  const definition = key && Object.hasOwn(manifest.settings.properties, key) ? manifest.settings.properties[key] : undefined;
  const handler = definition && (definition.type === 'string' || definition.type === 'object') ? definition.optionsFrom : undefined;
  if (!key || !handler) throw new PluginError(404, 'This setting has no choices to load');
  const row = await deps.database('plugin_installations').where({ plugin_id: id.data }).first() as PluginInstallationRow | undefined;
  if (!row) throw new PluginError(409, 'Install the plugin before loading the choices of its settings');

  const run = await runPluginHandler({ pluginId: id.data, manifest, record: installationRecord(row) }, handler, { kind: 'setting_options', setting: key }, { ...deps, allowDisabled: true });
  if (run.outcome === 'failed') throw new PluginError(502, `Loading the choices of ${key} failed${run.timedOut ? ' (timed out)' : ''}: ${run.error ?? 'the handler failed'}`);
  const result = readPluginSettingOptions(run.result);
  if (!result) throw new PluginError(502, `The plugin did not answer with a list of choices for ${key}`);
  if ('notConnected' in result) throw new PluginError(409, result.notConnected);
  return result;
}
