import { z } from 'zod';
import { PLUGIN_AUDIT_ACTIONS, PLUGIN_CATEGORIES, PLUGIN_CONNECTION_TYPES, PLUGIN_PERMISSIONS } from '@propr/shared';
import { component } from './schemas.js';

/** OpenAPI schemas of the plugin installation routes. Connection secrets never appear in any response. */
const permission = z.enum(PLUGIN_PERMISSIONS);
const settingValue = z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.record(z.string(), z.string())]);
const PluginManifestSummary = z.object({
  id: z.string(), name: z.string(), description: z.string(), version: z.string(), category: z.enum(PLUGIN_CATEGORIES), homepage: z.string(),
  permissions: z.array(z.object({ name: permission, description: z.string() })),
  connections: z.array(z.object({ type: z.enum(PLUGIN_CONNECTION_TYPES), name: z.string(), label: z.string(), help: z.string(), helpUrl: z.string() }).loose()),
  settings: z.object({ type: z.literal('object'), properties: z.record(z.string(), z.object({}).loose()), required: z.array(z.string()) }).describe('The settings schema: a JSON Schema subset (string, number, boolean, string list, repository map).'),
  outboundHosts: z.array(z.string()),
  contributes: z.object({
    mcpServers: z.array(z.object({}).loose()).describe('Contributed MCP servers without launch arguments or environment values.'),
    skills: z.array(z.string()), automationTemplates: z.array(z.string()),
    commands: z.array(z.object({ name: z.string(), description: z.string() })), subscriptions: z.array(z.string()),
    webhooks: z.array(z.object({ name: z.string(), description: z.string() })),
  }),
}).describe('The public projection of the plugin manifest.');
const acknowledgement = z.object({ actor: z.string(), at: z.number(), package: z.string(), version: z.string(), secretEnv: z.array(z.string()) });
const PluginInstallation = z.object({
  installedVersion: z.string().describe('The manifest version installed or last approved.'),
  enabled: z.boolean(),
  settings: z.record(z.string(), settingValue).describe('Setting values; never secrets, which are connections.'),
  repositories: z.array(z.string()).nullable().describe('Repositories (`owner/repo`) the plugin is limited to; null for all repositories.'),
  grantedPermissions: z.array(permission),
  acknowledgements: z.record(z.string(), acknowledgement).describe('Per package server: who acknowledged that its secret variables are readable inside the task container, and for which package, version and variable names.'),
  installedBy: z.string(), installedAt: z.number(), updatedBy: z.string(), updatedAt: z.number(),
});
const PluginConnectionStatus = z.object({
  name: z.string(), type: z.enum(PLUGIN_CONNECTION_TYPES), label: z.string(),
  state: z.enum(['connected', 'not_connected', 'needs_sign_in']).describe('An `oauth` connection is connected once every managed server using it is signed in through the extension OAuth sign-in, and needs_sign_in after a failed refresh.'),
  required: z.boolean().describe('A `token` connection a contributed MCP server uses; enabling waits for it.'),
  setBy: z.string().optional().describe('Who set the value; for an `oauth` connection, who configured its pre-registered client.'), setAt: z.number().optional(),
});
const managedState = { enabled: z.boolean().describe('The library item\'s own enabled switch.'), active: z.boolean().describe('False while the plugin is disabled or a secret acknowledgement is pending: the item then never applies.') };
const PluginContributions = z.object({
  mcpServers: z.array(z.object({
    name: z.string().describe('The server name in the manifest.'), kind: z.enum(['https', 'package']),
    managed: z.object({ kind: z.literal('server'), name: z.string().describe('The library item name; prefixed with the plugin id after a name collision.'), ...managedState }).nullable(),
    href: z.string().describe('The extension library route that lists and edits the item.'),
  })),
  skills: z.array(z.object({ name: z.string(), managed: z.object({ kind: z.literal('skill'), bundleId: z.string(), ...managedState }).nullable(), href: z.string() })),
  automationTemplates: z.array(z.object({ id: z.string(), catalogId: z.string().describe('The template id in the automation template catalog.'), available: z.boolean().describe('Listed in the catalog: the plugin is enabled.'), href: z.string() })),
}).describe('The managed extension library items and automation templates the plugin contributes; items are null until the plugin is installed.');
const pluginViewShape = {
  id: z.string(),
  available: z.boolean().describe('The plugin is in this ProPR version\'s registry.'),
  manifest: PluginManifestSummary.nullable(),
  state: z.enum(['available', 'installed', 'enabled']),
  installation: PluginInstallation.nullable(),
  connections: z.array(PluginConnectionStatus),
  needsApproval: z.boolean().describe('The current manifest asks for permissions or secret acknowledgements not yet approved; the plugin keeps its old grant.'),
  pendingPermissions: z.array(permission),
  pendingAcknowledgements: z.array(z.object({ server: z.string(), package: z.string(), version: z.string(), secretEnv: z.array(z.string()) })),
  enableBlockers: z.array(z.string()).describe('Why enabling is refused right now; empty when it can be enabled.'),
  contributions: PluginContributions.optional(),
};
export const PluginView = component('PluginView', z.object(pluginViewShape), 'A plugin with its installation state on this instance.');
export const PluginList = component('PluginList', z.object({ plugins: z.array(PluginView) }));
export const PluginDetailResponse = component('PluginDetailResponse', z.object({ plugin: z.object({
  ...pluginViewShape,
  audit: z.array(z.object({ action: z.enum(PLUGIN_AUDIT_ACTIONS), actor: z.string(), at: z.number(), detail: z.object({}).loose() })).describe('The newest 50 management actions, newest first.'),
}) }));
export const PluginResponse = component('PluginResponse', z.object({ plugin: PluginView }));
export const PluginAcknowledgementRequest = component('PluginAcknowledgementRequest', z.strictObject({
  acknowledgements: z.array(z.string()).optional().describe('Package servers whose secret variables the administrator confirms are readable by the agent CLI, its shell tools and repository setup scripts in the task container.'),
}));
export const PluginSettingsRequest = component('PluginSettingsRequest', z.strictObject({ settings: z.record(z.string(), settingValue.nullable()).describe('The complete settings; validated against the manifest\'s settings schema. Null values are removed.') }));
export const PluginRepositoriesRequest = component('PluginRepositoriesRequest', z.strictObject({ repositories: z.array(z.string()).max(256).nullable().describe('owner/repo names; null or an empty list for all repositories.') }));
export const PluginOAuthClientRequest = component('PluginOAuthClientRequest', z.strictObject({
  client: z.strictObject({
    clientId: z.string().regex(/^[\x21-\x7e]{1,512}$/).describe('The client id registered with the provider for this instance.'),
    clientSecret: z.string().max(4096).nullable().optional().describe('The client secret (write-only); leave out for a public client.'),
  }).nullable().describe('The pre-registered client, or null to clear it.'),
}));
export const PluginConnectionRequest = component('PluginConnectionRequest', z.strictObject({ value: z.string().max(4096).nullable().describe('The secret to store (write-only), or null to clear it.') }));
export const PluginEnabledRequest = component('PluginEnabledRequest', z.strictObject({ enabled: z.boolean() }));
export const PluginUninstallRequest = component('PluginUninstallRequest', z.strictObject({ confirm: z.string().describe('Must repeat the plugin id.') }));
export const PluginEmptyRequest = component('PluginEmptyRequest', z.strictObject({}));
export const PluginOAuthCompleteRequest = component('PluginOAuthCompleteRequest', z.strictObject({
  state: z.string().describe('The `state` the provider returned to the redirect URI.'), code: z.string().optional(), error: z.string().optional(), iss: z.string().optional(),
}));
export const PluginOAuthStartResponse = component('PluginOAuthStartResponse', z.object({ authorizationUrl: z.string().describe('Open this URL to sign in; the provider redirects to the extension OAuth callback.'), server: z.string().describe('The managed library server being signed in.') }));
