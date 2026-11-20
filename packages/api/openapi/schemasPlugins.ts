import { z } from 'zod';
import {
  COMMAND_TARGETS, PLUGIN_AUDIT_ACTIONS, PLUGIN_CATEGORIES, PLUGIN_COMMAND_KINDS, PLUGIN_CONNECTION_TYPES, PLUGIN_DELIVERY_KINDS, PLUGIN_DELIVERY_STATUSES, PLUGIN_HEALTH_STATES, PLUGIN_PERMISSIONS, PLUGIN_WEBHOOK_SCHEMES,
} from '@propr/shared';
import { component } from './schemas.js';

/** OpenAPI schemas of the plugin installation routes. Connection secrets never appear in any response. */
const permission = z.enum(PLUGIN_PERMISSIONS);
const settingValue = z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.record(z.string(), z.string())]);
const PluginManifestSummary = z.object({
  id: z.string(), name: z.string(), description: z.string(), version: z.string(), category: z.enum(PLUGIN_CATEGORIES), homepage: z.string(),
  permissions: z.array(z.object({ name: permission, description: z.string() })),
  connections: z.array(z.object({
    type: z.enum(PLUGIN_CONNECTION_TYPES), name: z.string(), label: z.string(), help: z.string(), helpUrl: z.string(),
    secretUrl: z.object({ hosts: z.array(z.string()), pathPrefixes: z.array(z.string()).optional() }).optional()
      .describe('A token connection whose value is a secret URL (an incoming webhook URL): accepted only on these hosts (`*.` for any subdomain) and paths. Never returned once stored.'),
    required: z.boolean().optional().describe('true on a token or signing_secret connection: enabling waits for it. false on an oauth connection: an optional sign-in. Absent: a token is required when a contributed MCP server uses it, an oauth connection is needed when a contributed server signs in with it.'),
    authorization: z.enum(['bearer', 'raw', 'basic']).optional().describe('How the plugin\'s handlers send a token connection: `Authorization: Bearer <token>` (bearer, the default), `Authorization: <token>` (raw) or `Authorization: Basic <base64 of token>` (basic, with the token entered as `<user>:<secret>`).'),
  }).loose()),
  settings: z.object({ type: z.literal('object'), properties: z.record(z.string(), z.object({}).loose()), required: z.array(z.string()) }).describe('The settings schema: a JSON Schema subset (string, optionally an enum, an https-url format (optionally limited to `hosts`) or choices loaded through `optionsFrom`; number; boolean; string list, optionally of enum values; repository map, optionally with values loaded through `optionsFrom`).'),
  outboundHosts: z.array(z.string()),
  outboundHostsFromSettings: z.array(z.string()).describe('Settings (https-url strings) whose URL host the plugin\'s handlers may also call, as saved.'),
  contributes: z.object({
    mcpServers: z.array(z.object({}).loose()).describe('Contributed MCP servers without launch arguments or environment values.'),
    skills: z.array(z.string()), automationTemplates: z.array(z.string()),
    commands: z.array(z.object({
      name: z.string().describe('Used as /<name> in a comment.'), description: z.string(),
      where: z.array(z.enum(COMMAND_TARGETS)).describe('Where the command can be used: pull request comments, issue comments or both.'),
      kind: z.enum(PLUGIN_COMMAND_KINDS).describe('prompt: queues an ordinary one-shot task (a follow-up on a pull request, an implementation task on an issue). handler: calls a handler of the plugin with the comment context, as a delivery of kind command.'),
      skills: z.array(z.string()).describe('Skills of this plugin the command adds to its run.'), servers: z.array(z.string()).describe('MCP servers of this plugin the command adds to its run.'),
      needsWrite: z.boolean().describe('The command may use the plugin\'s write servers: it runs only when an administrator allowed it write access and the commenter has write permission on the repository.'),
      shared: z.boolean().describe('Several plugins may offer this name; when several enabled plugins do, the shared command owner setting chooses which one it runs.'),
      specific: z.array(z.string()).describe('This plugin\'s own commands that stand in for a shared name.'),
    })).describe('Slash commands the plugin adds; never their prompt text.'), subscriptions: z.array(z.string()),
    webhooks: z.array(z.object({ name: z.string(), description: z.string(), scheme: z.enum(PLUGIN_WEBHOOK_SCHEMES).describe('How ProPR verifies the webhook\'s requests.') })),
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
  required: z.boolean().describe('Enabling waits for it: a `token` connection a contributed MCP server uses, or a `token` or `signing_secret` connection the manifest marks required.'),
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
  commands: z.array(z.object({
    name: z.string(), needsWrite: z.boolean(),
    writeAllowed: z.boolean().describe('"Allow this command to use write access" is on. Off until an administrator switches it on.'),
    writeChangedBy: z.string().optional(), writeChangedAt: z.number().optional(),
    sharedOwner: z.object({
      owner: z.string().nullable().describe('The plugin the shared name runs when several enabled plugins offer it; null when none was chosen.'),
      setBy: z.string().optional(), setAt: z.number().optional(),
      candidates: z.array(z.object({ pluginId: z.string(), pluginName: z.string(), specific: z.array(z.string()), enabled: z.boolean() })).describe('Every installed plugin offering the name.'),
    }).optional().describe('Present for a shared command.'),
  })).optional().describe('Instance settings of the plugin\'s commands.'),
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
export const PluginCommandWriteRequest = component('PluginCommandWriteRequest', z.strictObject({ allowed: z.boolean().describe('Allow this command to use write access.') }));
export const PluginSharedCommandOwnerRequest = component('PluginSharedCommandOwnerRequest', z.strictObject({ owner: z.string().nullable().describe('An installed plugin that offers the shared name, or null to clear the choice.') }));
export const PluginOAuthCompleteRequest = component('PluginOAuthCompleteRequest', z.strictObject({
  state: z.string().describe('The `state` the provider returned to the redirect URI.'), code: z.string().optional(), error: z.string().optional(), iss: z.string().optional(),
}));
export const PluginOAuthStartResponse = component('PluginOAuthStartResponse', z.object({ authorizationUrl: z.string().describe('Open this URL to sign in; the provider redirects to the extension OAuth callback.'), server: z.string().describe('The managed library server being signed in.') }));

const PluginLogLine = z.object({ level: z.enum(['debug', 'info', 'warn', 'error']), message: z.string(), fields: z.record(z.string(), z.unknown()).optional(), at: z.number() });
export const PluginDelivery = component('PluginDelivery', z.object({
  id: z.number().int().describe('The activity record id, used by the retry route.'),
  deliveryId: z.string().describe('The stable delivery id the handler receives (`evt-<seq>-<handler>`, `whk-<webhook>:<id>` or `whk-<webhook>/<uuid>` for a webhook, `cmd-issue-<comment id>` or `cmd-review-<comment id>` for a command run from an issue comment or a pull request review comment); the same on every attempt.'),
  kind: z.enum(PLUGIN_DELIVERY_KINDS).describe('`event`: one journal event to one handler. `gap`: journal retention removed events before they were delivered. `webhook`: one verified inbound webhook request to its handler. `command`: one handler slash command to its handler.'),
  repository: z.string().describe('The event\'s or command\'s repository; empty for a webhook delivery.'),
  eventSeq: z.number().int().describe('The journal `seq` of the event; for a gap, the first `seq` that may be missing; 0 for a webhook delivery; the issue or pull request number for a command.'),
  eventType: z.string().nullable().describe('`<domain>.<type>`; `webhook.<name>` for a webhook delivery; `command.<name>` for a command; null for a gap.'),
  handler: z.string().nullable(),
  status: z.enum(PLUGIN_DELIVERY_STATUSES),
  attempt: z.number().int().describe('Attempts made so far.'),
  nextAttemptAt: z.number().nullable().describe('When the next attempt is due, while pending or retrying.'),
  createdAt: z.number(), startedAt: z.number().nullable(), finishedAt: z.number().nullable(), durationMs: z.number().nullable(),
  timedOut: z.boolean(),
  error: z.string().nullable().describe('The latest attempt\'s redacted error message.'),
  logs: z.array(PluginLogLine).describe('The latest attempt\'s redacted log lines.'),
}), 'One event delivery to a plugin handler, or a recorded gap. Holds the event id and type only: never the event payload or a credential.');
export const PluginHealth = component('PluginHealth', z.object({
  state: z.enum(PLUGIN_HEALTH_STATES).describe('`degraded` after repeated consecutive failures; `paused` after the configured number of them, until an administrator resumes deliveries.'),
  consecutiveFailures: z.number().int(), pauseAfterFailures: z.number().int(),
  lastError: z.string().nullable(), lastErrorAt: z.number().nullable(), degradedAt: z.number().nullable(), pausedAt: z.number().nullable(),
}), 'Delivery health of a plugin installation.');
export const PluginActivityResponse = component('PluginActivityResponse', z.object({ health: PluginHealth, deliveries: z.array(PluginDelivery).describe('The newest 100 delivery records, newest first.') }));
export const PluginDeliveryResponse = component('PluginDeliveryResponse', z.object({ delivery: PluginDelivery }));
export const PluginHealthResponse = component('PluginHealthResponse', z.object({ health: PluginHealth }));

const PluginWebhookEndpoint = z.object({
  name: z.string(), description: z.string(), scheme: z.enum(PLUGIN_WEBHOOK_SCHEMES),
  path: z.string().describe('`/api/plugins/<installation key>/hooks/<name>`. The key is unguessable: treat the URL as a secret.'),
  url: z.string().nullable().describe('The full URL; null when the instance has no public base URL.'),
});
export const PluginWebhooksResponse = component('PluginWebhooksResponse', z.object({
  webhooks: z.array(PluginWebhookEndpoint).describe('One URL per webhook the plugin declares.'),
  rejected: z.object({ count: z.number().int(), lastAt: z.number().nullable(), lastReason: z.string().nullable() }).describe('Requests refused because they failed verification. Their bodies and headers are never stored.'),
  keyCreatedAt: z.number().nullable(), keyCreatedBy: z.string().nullable().describe('The administrator who last regenerated the key, or `system`.'),
}), 'The inbound webhook URLs of an installed plugin.');

export const PluginSettingOptionsResponse = component('PluginSettingOptionsResponse', z.object({
  options: z.array(z.object({ value: z.string().describe('The value saved.'), label: z.string().describe('The label shown.') })).describe('At most 250 choices.'),
}), 'The choices of a plugin setting, loaded from the service by the plugin\'s optionsFrom handler.');
