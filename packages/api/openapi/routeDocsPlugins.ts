import type { z } from 'zod';
import {
  PluginAcknowledgementRequest, PluginConnectionRequest, PluginDetailResponse, PluginEnabledRequest, PluginList, PluginRepositoriesRequest, PluginResponse,
  PluginSettingsRequest, PluginUninstallRequest, PluginEmptyRequest, PluginOAuthCompleteRequest, PluginOAuthStartResponse,
} from './schemasPlugins.js';
import type { RouteDoc } from './types.js';

/** Plugin installation routes (docs/features/plugins#installing-a-plugin). */
const BASE = '/api/instance/plugins/v1';
const description = 'Durable instance administrator with instance.manage_settings required. Mutations require application/json and X-ProPR-Plugins: 1, and are recorded in the plugin audit trail. Connection secrets are never returned.';
const headers = [{ name: 'X-ProPR-Plugins', description: 'Must equal 1; browser calls require an authorized CORS preflight.', required: true }];
const pluginId = { pluginId: 'Plugin id, for example `example-pack`.' };
const oauthParams = { ...pluginId, connectionName: 'An `oauth` connection name from the manifest.' };
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
  [`PUT ${BASE}/:pluginId/enabled`]: mutation('setPluginEnabled', 'Enable or disable. Enabling is refused (409, with the reasons) while a required setting, a required token connection or a secret acknowledgement is missing. Enabling activates the plugin\'s managed extension library items and lists its automation templates; disabling deactivates and hides them and keeps settings and connections.', PluginEnabledRequest),
  [`POST ${BASE}/:pluginId/approve`]: mutation('approvePlugin', 'Approve the permission set of the current manifest after an upgrade, with the secret acknowledgements it needs again.', PluginAcknowledgementRequest),
  [`POST ${BASE}/:pluginId/uninstall`]: mutation('uninstallPlugin', 'Uninstall: deletes the installation, its settings, its connections and its managed extension library items. Refused (409, naming them) while an automation adds a managed item explicitly. The audit trail stays.', PluginUninstallRequest),
  [`POST ${BASE}/:pluginId/connections/:connectionName/oauth/start`]: mutation('startPluginOAuth', 'Start the extension OAuth sign-in of an `oauth` connection for its managed MCP server, bound to this browser session. ProPR identifies itself as it does for library servers.', PluginEmptyRequest, {
    pathParams: oauthParams, responses: { 200: { description: 'The authorization URL to open.', schema: PluginOAuthStartResponse } },
  }),
  [`POST ${BASE}/:pluginId/connections/:connectionName/oauth/complete`]: mutation('completePluginOAuth', 'Complete a sign-in of this connection with the state and code the provider returned, in the session that started it. The extension OAuth callback completes it too.', PluginOAuthCompleteRequest, { pathParams: oauthParams }),
  [`POST ${BASE}/:pluginId/connections/:connectionName/oauth/disconnect`]: mutation('disconnectPluginOAuth', 'Disconnect an `oauth` connection: its managed servers\' tokens are revoked where possible and deleted, and later runs leave the servers out.', PluginEmptyRequest, { pathParams: oauthParams }),
};
