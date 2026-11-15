import type { z } from 'zod';
import {
  PluginAcknowledgementRequest, PluginConnectionRequest, PluginDetailResponse, PluginEnabledRequest, PluginList, PluginRepositoriesRequest, PluginResponse,
  PluginSettingsRequest, PluginUninstallRequest, PluginEmptyRequest, PluginOAuthClientRequest, PluginOAuthCompleteRequest, PluginOAuthStartResponse,
  PluginActivityResponse, PluginDeliveryResponse, PluginHealthResponse, PluginWebhooksResponse,
} from './schemasPlugins.js';
import { JsonObject } from './schemas.js';
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
  [`PUT ${BASE}/:pluginId/connections/:connectionName/oauth/client`]: mutation('setPluginOAuthClient', 'Configure or clear the pre-registered OAuth client of an `oauth` connection whose `registrations` permit `preregistered` (409 otherwise). The client id becomes the managed MCP servers\' client id and the secret is sealed and write-only; changing the client discards their OAuth connections.', PluginOAuthClientRequest, { pathParams: oauthParams }),
  [`POST ${BASE}/:pluginId/connections/:connectionName/oauth/start`]: mutation('startPluginOAuth', 'Start the extension OAuth sign-in of an `oauth` connection for its managed MCP server, bound to this browser session. ProPR identifies itself as it does for library servers.', PluginEmptyRequest, {
    pathParams: oauthParams, responses: { 200: { description: 'The authorization URL to open.', schema: PluginOAuthStartResponse } },
  }),
  [`POST ${BASE}/:pluginId/connections/:connectionName/oauth/complete`]: mutation('completePluginOAuth', 'Complete a sign-in of this connection with the state and code the provider returned, in the session that started it. The extension OAuth callback completes it too.', PluginOAuthCompleteRequest, { pathParams: oauthParams }),
  [`GET ${BASE}/:pluginId/activity`]: {
    operationId: 'getPluginActivity', summary: 'Read the plugin\'s event delivery health (healthy, degraded or paused, with the last error) and its newest delivery records: time, event id and type, handler, outcome, duration, attempt, redacted error and log lines. Records are kept for 14 days.', description, tags: ['Configuration'],
    pathParams: pluginId, responses: { 200: { description: 'Health and delivery records, newest first.', schema: PluginActivityResponse } },
  },
  [`POST ${BASE}/:pluginId/activity/:deliveryId/retry`]: mutation('retryPluginDelivery', 'Retry a failed event delivery: it gets one more attempt, with the same delivery id, the next time the dispatcher runs (after Resume while deliveries are paused). Refused (409) for a delivery that has not failed.', PluginEmptyRequest, {
    pathParams: { ...pluginId, deliveryId: 'The activity record id (`id` of a delivery).' }, responses: { 200: { description: 'The delivery, pending again.', schema: PluginDeliveryResponse } },
  }),
  [`POST ${BASE}/:pluginId/resume`]: mutation('resumePluginDeliveries', 'Resume event deliveries paused after repeated failures: the failure count starts over, Degraded clears and waiting retries are due at once. Refused (409) when deliveries are not paused.', PluginEmptyRequest, {
    responses: { 200: { description: 'The new delivery health.', schema: PluginHealthResponse } },
  }),
  [`GET ${BASE}/:pluginId/webhooks`]: {
    operationId: 'getPluginWebhooks', summary: 'Read the installed plugin\'s inbound webhook URLs (one per declared webhook, with its verification scheme) and the count of requests refused because they failed verification. Refused (409) when the plugin is not installed.', description, tags: ['Configuration'],
    pathParams: pluginId, responses: { 200: { description: 'The webhook URLs.', schema: PluginWebhooksResponse } },
  },
  [`POST ${BASE}/:pluginId/webhooks/regenerate`]: mutation('regeneratePluginWebhookKey', 'Replace the plugin\'s installation key: every webhook URL changes and the old URLs answer 404 at once. Update the URL at each sending service afterwards.', PluginEmptyRequest, {
    responses: { 200: { description: 'The new webhook URLs.', schema: PluginWebhooksResponse } },
  }),
  'POST /api/plugins/:installationKey/hooks/:webhookName': {
    operationId: 'receivePluginWebhook',
    summary: 'Receive an inbound webhook request for a plugin',
    description: 'Public. ProPR verifies the request with the webhook\'s scheme (`hmac-sha256`, `slack-v0` or `token-header`) and the plugin\'s signing secret before any plugin code runs, then queues the plugin\'s handler as a delivery of kind `webhook`. The body is read raw, up to 256 KiB; the webhook rate limiter applies. Bodies and signature headers are never stored or logged.',
    tags: ['Webhooks'],
    pathParams: { installationKey: 'The unguessable installation key from the Plugins page.', webhookName: 'A webhook name from the plugin manifest.' },
    requestBody: { schema: JsonObject, description: 'Any body, read raw: JSON, form-encoded or text, as the sending service signs it.' },
    responses: {
      200: { description: 'The webhook\'s respond function answered at once (a challenge echo); the handler does not run.', contentType: 'text/plain' },
      202: { description: 'Verified and queued: `{ accepted: true, deliveryId }`.', schema: JsonObject },
      400: { description: 'The delivery id header is malformed.' },
      401: { description: 'Verification failed: missing or wrong signature or token, a stale timestamp, or no signing secret set. Counted on the installation.' },
      404: { description: 'Unknown or regenerated installation key, a disabled or uninstalled plugin, or an undeclared webhook.' },
      409: { description: 'The delivery id was already received (a replay).' },
      413: { description: 'The body is larger than 256 KiB.' },
      429: { description: 'Rate limited.' },
      503: { description: 'Deliveries of the plugin are paused, or too many deliveries are waiting; retry after `Retry-After`.' },
    },
  },
  [`POST ${BASE}/:pluginId/connections/:connectionName/oauth/disconnect`]: mutation('disconnectPluginOAuth', 'Disconnect an `oauth` connection: its managed servers\' tokens are revoked where possible and deleted, and later runs leave the servers out.', PluginEmptyRequest, { pathParams: oauthParams }),
};
