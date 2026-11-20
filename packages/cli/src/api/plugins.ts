/**
 * Plugin API
 *
 * Read-only wrappers over the plugin installation routes
 * (`/api/instance/plugins/v1`). Every route needs an instance administrator
 * with `instance.manage_settings`; responses never carry connection secrets.
 */

import { PLUGIN_API_BASE, type PluginDetail, type PluginView } from "@propr/shared";
import { createApiClient, type ApiClient } from "./client.js";

export interface PluginApiOptions {
  /** Injected in tests; the configured client otherwise. */
  client?: ApiClient;
}

/** The route of one plugin, with its id encoded. */
export function pluginPath(id: string): string {
  return `${PLUGIN_API_BASE}/${encodeURIComponent(id)}`;
}

/** Every plugin of the registry, and installed plugins the registry no longer has, in catalog order. */
export async function listPlugins(options: PluginApiOptions = {}): Promise<PluginView[]> {
  const client = options.client ?? await createApiClient();
  return (await client.get<{ plugins: PluginView[] }>(PLUGIN_API_BASE)).data.plugins;
}

/** One plugin with its installation, connections, commands and audit trail. */
export async function getPlugin(id: string, options: PluginApiOptions = {}): Promise<PluginDetail> {
  const client = options.client ?? await createApiClient();
  return (await client.get<{ plugin: PluginDetail }>(pluginPath(id))).data.plugin;
}
