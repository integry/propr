import type { z } from 'zod';
import {
  PluginAcknowledgementRequest, PluginConnectionRequest, PluginDetailResponse, PluginEnabledRequest, PluginList, PluginRepositoriesRequest, PluginResponse,
  PluginSettingsRequest, PluginUninstallRequest,
} from './schemasPlugins.js';
import type { RouteDoc } from './types.js';

/** Plugin installation routes (docs/features/plugins#installing-a-plugin). */
const BASE = '/api/instance/plugins/v1';
const description = 'Durable instance administrator with instance.manage_settings required. Mutations require application/json and X-ProPR-Plugins: 1, and are recorded in the plugin audit trail. Connection secrets are never returned.';
const headers = [{ name: 'X-ProPR-Plugins', description: 'Must equal 1; browser calls require an authorized CORS preflight.', required: true }];
const pluginId = { pluginId: 'Plugin id, for example `example-pack`.' };
const changed = { 200: { description: 'The plugin\'s new state.', schema: PluginResponse } };
const mutation = (operationId: string, summary: string, schema: z.ZodType, extra: Partial<RouteDoc> = {}): RouteDoc => ({
  operationId, summary, description, tags: ['Configuration'], pathParams: pluginId, headers, requestBody: { schema }, responses: changed, ...extra,
});

export const PLUGIN_ROUTE_DOCS: Record<string, RouteDoc> = {
  [`GET ${BASE}`]: {
    operationId: 'listPlugins', summary: 'List the plugins of this ProPR\'s registry, and installed plugins an upgrade removed from it, with their installation state.', description, tags: ['Configuration'],
    responses: { 200: { description: 'Plugins in catalog order.', schema: PluginList } },
  },
  [`GET ${BASE}/:pluginId`]: {
    operationId: 'getPlugin', summary: 'Read one plugin: manifest, settings, connection states, pending approvals and acknowledgements, and its newest audit events.', description, tags: ['Configuration'],
    pathParams: pluginId, responses: { 200: { description: 'The plugin.', schema: PluginDetailResponse } },
  },
  [`POST ${BASE}/:pluginId/install`]: mutation('installPlugin', 'Install a registry plugin, disabled, with its default settings; grants the manifest\'s permissions. A package server with secret variables must be acknowledged.', PluginAcknowledgementRequest),
  [`PUT ${BASE}/:pluginId/settings`]: mutation('updatePluginSettings', 'Replace the settings, validated against the manifest\'s settings schema. Required settings cannot be removed while the plugin is enabled.', PluginSettingsRequest),
  [`PUT ${BASE}/:pluginId/repositories`]: mutation('setPluginRepositories', 'Limit the plugin to repositories, or clear the limit (all repositories).', PluginRepositoriesRequest),
  [`PUT ${BASE}/:pluginId/connections/:connectionName`]: mutation('setPluginConnection', 'Set or clear a `token` or `signing_secret` connection. The secret is sealed and write-only.', PluginConnectionRequest, {
    pathParams: { ...pluginId, connectionName: 'Connection name from the manifest.' },
  }),
  [`PUT ${BASE}/:pluginId/enabled`]: mutation('setPluginEnabled', 'Enable or disable. Enabling is refused (409, with the reasons) while a required setting, a required token connection or a secret acknowledgement is missing. Disabling keeps settings and connections.', PluginEnabledRequest),
  [`POST ${BASE}/:pluginId/approve`]: mutation('approvePlugin', 'Approve the permission set of the current manifest after an upgrade, with the secret acknowledgements it needs again.', PluginAcknowledgementRequest),
  [`POST ${BASE}/:pluginId/uninstall`]: mutation('uninstallPlugin', 'Uninstall: deletes the installation, its settings and its connections. The audit trail stays.', PluginUninstallRequest),
};
