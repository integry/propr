import { z } from 'zod';
import { EXTENSION_OAUTH_REGISTRATIONS } from './extensionOAuth.js';
import { extensionServerNameSchema, remoteMcpSchema } from './extensionProfiles.js';
import { extensionPackageEnvNameSchema, extensionPackageIntegritySchema, packageServerFields, EXACT_VERSION_PATTERN } from './extensionPackages.js';
import { isRepositoryEventType } from './repositoryEvents.js';
import { BUILT_IN_COMMAND_NAMES, COMMAND_NAME_PATTERN, COMMAND_TARGETS, isBuiltInCommandName, type CommandTarget } from './commands.js';

/** Whether `name` is `<domain>.<type>` of a repository journal event. */
export function isPluginSubscriptionEvent(name: unknown): boolean {
  if (typeof name !== 'string') return false;
  const dot = name.indexOf('.');
  return dot > 0 && isRepositoryEventType(name.slice(0, dot), name.slice(dot + 1));
}

/**
 * Plugins as data. An official plugin is a folder `packages/plugins/<id>/`
 * whose `manifest.json` describes everything ProPR can show without loading
 * the plugin's code: what it is, the permissions and credentials it needs,
 * its settings and what it contributes (MCP servers, skills, automation
 * templates, commands, event subscriptions and webhooks).
 *
 * MCP server contributions reuse the extension library's item shapes, so a
 * plugin can never declare a server the library itself would refuse.
 */
export const PLUGIN_MANIFEST_VERSION = 1 as const;
export const PLUGIN_CATEGORIES = ['messaging', 'issue-tracking', 'observability', 'deployment', 'context', 'other'] as const;
export type PluginCategory = typeof PLUGIN_CATEGORIES[number];

/** What a plugin's handlers may do. A closed set: anything not listed here cannot be requested. */
export const PLUGIN_PERMISSIONS = [
  'events.read',
  'tasks.read', 'tasks.create',
  'issues.read', 'issues.create', 'issues.comment',
  'pull_requests.read', 'pull_requests.comment',
  'labels.write',
  'repositories.read',
  'notifications.send',
] as const;
export type PluginPermission = typeof PLUGIN_PERMISSIONS[number];
export const PLUGIN_PERMISSION_DESCRIPTIONS: Record<PluginPermission, string> = {
  'events.read': 'Receive ProPR task, pull request and automation events',
  'tasks.read': 'Read tasks and their status',
  'tasks.create': 'Start tasks',
  'issues.read': 'Read issues of the repositories it is enabled for',
  'issues.create': 'Create issues',
  'issues.comment': 'Comment on issues',
  'pull_requests.read': 'Read pull requests',
  'pull_requests.comment': 'Comment on pull requests',
  'labels.write': 'Add and remove labels on issues and pull requests',
  'repositories.read': 'List repositories ProPR manages',
  'notifications.send': 'Send ProPR notifications',
};

export const PLUGIN_CONNECTION_TYPES = ['oauth', 'token', 'signing_secret'] as const;
export type PluginConnectionType = typeof PLUGIN_CONNECTION_TYPES[number];
export const PLUGIN_SETTING_TYPES = ['string', 'number', 'boolean', 'array', 'object'] as const;

export const PLUGIN_LIMITS = {
  permissions: PLUGIN_PERMISSIONS.length, connections: 16, settings: 64, outboundHosts: 32,
  mcpServers: 16, skills: 16, automationTemplates: 16, commands: 32, subscriptions: 64, webhooks: 16,
  enumValues: 64, listItems: 256, text: 500,
} as const;

/** Folders of the registry package that can never be plugin ids. */
export const RESERVED_PLUGIN_IDS = ['src', 'dist', 'test', 'testing', 'node_modules', 'propr'] as const;
export const pluginIdSchema = z.string().max(48).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, 'Plugin ids are lowercase slugs such as my-plugin')
  .refine(id => !(RESERVED_PLUGIN_IDS as readonly string[]).includes(id), 'This plugin id is reserved');
/** Names of connections, settings, commands and webhooks inside one plugin. */
const keySchema = z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/, 'Use lowercase letters, digits, _ and -');
/** Setting keys, the property names of the settings object. */
const settingKeySchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,47}$/, 'Use letters, digits and _, starting with a letter');
const textSchema = (max: number = PLUGIN_LIMITS.text) => z.string().trim().min(1).max(max);
const httpsUrlSchema = z.url({ protocol: /^https$/, error: 'Enter an https:// URL' }).max(2048);
/** A file or folder inside the plugin folder: relative, forward slashes, no `.` or `..` segments. */
export const pluginAssetPathSchema = z.string().max(256)
  .regex(/^(?!\/)[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)*$/, 'Use a relative path inside the plugin folder')
  .refine(p => p.split('/').every(segment => segment !== '.' && segment !== '..'), 'Use a relative path inside the plugin folder');
/** A DNS hostname: lowercase labels, at least two, no scheme, port, path, wildcard or IP literal. */
export const pluginHostnameSchema = z.string().max(253)
  .regex(/^(?=.*[a-z])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/, 'Enter a hostname such as api.example.com');

const connectionBase = { name: keySchema, label: textSchema(100), help: textSchema(), helpUrl: httpsUrlSchema };
export const pluginConnectionSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('oauth'), ...connectionBase,
    /** Registration methods allowed, in the order the extension OAuth sign-in tries them. */
    registrations: z.array(z.enum(EXTENSION_OAUTH_REGISTRATIONS)).min(1).max(EXTENSION_OAUTH_REGISTRATIONS.length).default([...EXTENSION_OAUTH_REGISTRATIONS]),
    scopes: remoteMcpSchema.shape.scopes,
  }),
  z.strictObject({ type: z.literal('token'), ...connectionBase }),
  z.strictObject({ type: z.literal('signing_secret'), ...connectionBase }),
]);
export type PluginConnection = z.infer<typeof pluginConnectionSchema>;

const settingBase = { label: textSchema(100), help: textSchema().optional() };
const stringList = z.array(z.string().max(PLUGIN_LIMITS.text)).max(PLUGIN_LIMITS.listItems);
/**
 * One setting, in a JSON Schema subset: a string (optionally an enum), a
 * number, a boolean, a string list (`array` of `string`) or a repository map
 * (`object` with `format: repository-map`, keyed by `owner/repo`).
 */
export const pluginSettingSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('string'), ...settingBase, default: z.string().max(PLUGIN_LIMITS.text).optional(),
    enum: z.array(z.string().min(1).max(100)).min(1).max(PLUGIN_LIMITS.enumValues).optional(),
    maxLength: z.number().int().positive().max(PLUGIN_LIMITS.text).optional(),
  }),
  z.strictObject({
    type: z.literal('number'), ...settingBase, default: z.number().finite().optional(),
    minimum: z.number().finite().optional(), maximum: z.number().finite().optional(), integer: z.boolean().optional(),
  }),
  z.strictObject({ type: z.literal('boolean'), ...settingBase, default: z.boolean().optional() }),
  z.strictObject({
    type: z.literal('array'), ...settingBase, items: z.strictObject({ type: z.literal('string') }),
    default: stringList.optional(), maxItems: z.number().int().positive().max(PLUGIN_LIMITS.listItems).optional(),
  }),
  z.strictObject({
    type: z.literal('object'), ...settingBase, format: z.literal('repository-map'),
    additionalProperties: z.strictObject({ type: z.literal('string') }),
    default: z.record(z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), z.string().max(PLUGIN_LIMITS.text)).optional(),
  }),
]);
export type PluginSetting = z.infer<typeof pluginSettingSchema>;
export const pluginSettingsSchema = z.strictObject({
  type: z.literal('object'),
  properties: z.record(settingKeySchema, pluginSettingSchema),
  required: z.array(settingKeySchema).default([]),
});
export type PluginSettings = z.infer<typeof pluginSettingsSchema>;

/**
 * A remote MCP server: the extension library's remote item without the
 * per-instance fields. Its credential is one of the plugin's connections.
 */
export const pluginRemoteServerSchema = remoteMcpSchema.omit({ enabled: true, scopes: true, clientId: true }).extend({
  url: httpsUrlSchema,
  /** Required unless `authentication` is `none`: a `token` connection for `bearer`, an `oauth` connection for `oauth`. */
  connection: keySchema.optional(),
});
/**
 * A local server from a pinned npm package: the extension library's package
 * item, with the integrity value recorded in the manifest and each secret
 * variable mapped to one of the plugin's `token` connections.
 */
export const pluginPackageServerSchema = z.strictObject({
  name: extensionServerNameSchema, tools: remoteMcpSchema.shape.tools, capability: z.enum(['read', 'write']),
  ...packageServerFields,
  integrity: z.string({ error: issue => (issue.input === undefined ? 'Record the integrity value (sha512-…) of the pinned package version' : undefined) })
    .pipe(extensionPackageIntegritySchema),
  secretEnv: z.array(z.strictObject({ name: extensionPackageEnvNameSchema, connection: keySchema })).max(16).default([]),
});
export const pluginMcpServerSchema = z.discriminatedUnion('kind', [pluginRemoteServerSchema, pluginPackageServerSchema]);
export type PluginMcpServer = z.infer<typeof pluginMcpServerSchema>;
export type PluginPackageServer = z.infer<typeof pluginPackageServerSchema>;

/** A skill bundle source: a folder inside the plugin folder with a `SKILL.md`. */
export const pluginSkillSchema = z.strictObject({ name: keySchema, path: pluginAssetPathSchema });
/** An automation template folder in the shipped template format (`template.json` and `prompt.md`). */
export const pluginAutomationTemplateSchema = z.strictObject({ id: keySchema, path: pluginAssetPathSchema });
/** A plugin command name: lower-case, and never one of ProPR's built-in commands. */
export const pluginCommandNameSchema = z.string().regex(COMMAND_NAME_PATTERN, 'Command names are lower-case letters, digits and -, starting with a letter (at most 32)')
  .refine(name => !isBuiltInCommandName(name), { error: issue => `/${String(issue.input)} is a built-in ProPR command; built-in commands are ${BUILT_IN_COMMAND_NAMES.map(n => `/${n}`).join(', ')}` });
export const PLUGIN_COMMAND_KINDS = ['prompt'] as const;
export type PluginCommandKind = typeof PLUGIN_COMMAND_KINDS[number];
/**
 * A slash command used in issue or pull request comments (`where`). A `prompt`
 * command queues an ordinary one-shot task: a follow-up on a pull request, an
 * implementation task on an issue. Its instruction is `prompt`, with the rest
 * of the command line appended as the person's (untrusted) argument; `skills`
 * and `servers` name this plugin's own contributions to add to that run.
 * Commands with `needsWrite` are refused until write authorization for
 * commands exists.
 */
export const pluginCommandSchema = z.strictObject({
  name: pluginCommandNameSchema,
  description: textSchema(200),
  where: z.array(z.enum(COMMAND_TARGETS)).min(1).max(COMMAND_TARGETS.length),
  kind: z.enum(PLUGIN_COMMAND_KINDS),
  prompt: textSchema(4000),
  skills: z.array(keySchema).max(PLUGIN_LIMITS.skills).default([]),
  servers: z.array(extensionServerNameSchema).max(PLUGIN_LIMITS.mcpServers).default([]),
  needsWrite: z.boolean().default(false),
  permissions: z.array(z.enum(PLUGIN_PERMISSIONS)).max(PLUGIN_LIMITS.permissions).default([]),
});
export type PluginCommand = z.infer<typeof pluginCommandSchema>;
/** A handler name: an exported function of the plugin's `handlers.ts`. */
export const pluginHandlerNameSchema = z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/, 'Use the name of an exported handler function');
/** Event fields a subscription filter can match, besides `payload.<key>`. */
export const PLUGIN_SUBSCRIPTION_FILTER_FIELDS = ['repository', 'entityId', 'prNumber', 'issueNumber', 'planId', 'headSha'] as const;
const isFilterKey = (key: string) => (PLUGIN_SUBSCRIPTION_FILTER_FIELDS as readonly string[]).includes(key) || /^payload\.[A-Za-z][A-Za-z0-9_]{0,47}$/.test(key);
const filterScalarSchema = z.union([z.string().max(PLUGIN_LIMITS.text), z.number().finite(), z.boolean(), z.null()]);
/**
 * Equality filter of a subscription: every key must match. A key is an event
 * field (`repository` compares without letter case) or `payload.<key>`; a list
 * value matches any of its entries.
 */
export const pluginSubscriptionFilterSchema = z.record(z.string(), z.union([filterScalarSchema, z.array(filterScalarSchema).min(1).max(32)]))
  .superRefine((filter, ctx) => {
    const keys = Object.keys(filter);
    if (keys.length > 16) ctx.addIssue({ code: 'custom', message: 'A filter has at most 16 keys' });
    for (const key of keys.filter(k => !isFilterKey(k))) ctx.addIssue({ code: 'custom', path: [key], message: `Filter keys are ${PLUGIN_SUBSCRIPTION_FILTER_FIELDS.join(', ')} or payload.<key>` });
  });
export type PluginSubscriptionFilter = z.infer<typeof pluginSubscriptionFilterSchema>;
/**
 * An event subscription: `on` is `<domain>.<type>` of a repository journal
 * event (for example `pull_request.merged`), `handler` the exported function
 * that receives it and `filter` narrows which events of that type it gets.
 */
export const pluginSubscriptionSchema = z.strictObject({
  on: z.string().refine(isPluginSubscriptionEvent, 'Use a repository event name such as pull_request.merged or task.completed'),
  handler: pluginHandlerNameSchema,
  filter: pluginSubscriptionFilterSchema.optional(),
});
export type PluginSubscription = z.infer<typeof pluginSubscriptionSchema>;
/** An HTTP header name, matched without letter case (stored lower-case). */
export const pluginHeaderNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/, 'Enter an HTTP header name such as x-signature').transform(name => name.toLowerCase());
const headerPrefixSchema = z.string().min(1).max(32).regex(/^[\x20-\x7e]+$/, 'A prefix is printable ASCII');
/** Headers a webhook never names: ProPR or the HTTP layer own them. */
const RESERVED_WEBHOOK_HEADERS = ['host', 'content-length', 'content-type', 'cookie', 'connection', 'transfer-encoding'];
/**
 * HTTP credential headers: a webhook may verify with one (`token-header`), but
 * never names one as its `deliveryIdHeader`, whose value is stored in the
 * delivery record and shown in Activity.
 */
export const PLUGIN_WEBHOOK_CREDENTIAL_HEADERS: readonly string[] = ['authorization', 'proxy-authorization'];
/** Inbound webhook verification schemes; ProPR verifies a request before any plugin code runs. */
export const PLUGIN_WEBHOOK_SCHEMES = ['hmac-sha256', 'slack-v0', 'token-header'] as const;
export type PluginWebhookScheme = typeof PLUGIN_WEBHOOK_SCHEMES[number];
/**
 * How ProPR verifies an inbound webhook, with a `signing_secret` connection:
 * - `hmac-sha256`: `header` carries `prefix` + the HMAC-SHA256 of the raw body (`hex` or `base64`), as GitHub's `X-Hub-Signature-256: sha256=…`.
 * - `slack-v0`: Slack's `X-Slack-Signature: v0=` + HMAC-SHA256 of `v0:<X-Slack-Request-Timestamp>:<body>`; the timestamp must be within 5 minutes.
 * - `token-header`: `header` carries `prefix` + the secret itself, compared in constant time (as GitLab's `X-Gitlab-Token`).
 */
export const pluginWebhookVerificationSchema = z.discriminatedUnion('scheme', [
  z.strictObject({ scheme: z.literal('hmac-sha256'), header: pluginHeaderNameSchema, prefix: headerPrefixSchema.optional(), encoding: z.enum(['hex', 'base64']).default('hex'), connection: keySchema }),
  z.strictObject({ scheme: z.literal('slack-v0'), connection: keySchema }),
  z.strictObject({ scheme: z.literal('token-header'), header: pluginHeaderNameSchema, prefix: headerPrefixSchema.optional(), connection: keySchema }),
]);
export type PluginWebhookVerification = z.infer<typeof pluginWebhookVerificationSchema>;
/**
 * An inbound webhook: `POST /api/plugins/<installation key>/hooks/<name>`.
 * A verified request runs `handler` from the delivery queue. `deliveryIdHeader`
 * names the header carrying the sender's delivery id, used to refuse replays.
 * `respond` names an exported function of `handlers.ts` that may answer the
 * request at once (a challenge echo): it receives the request only, never `ctx`.
 */
export const pluginWebhookSchema = z.strictObject({
  name: keySchema, description: textSchema(200), handler: pluginHandlerNameSchema,
  verification: pluginWebhookVerificationSchema,
  deliveryIdHeader: pluginHeaderNameSchema.optional(),
  respond: pluginHandlerNameSchema.optional(),
});
export type PluginWebhook = z.infer<typeof pluginWebhookSchema>;
/** The headers a webhook's verification reads: never stored, logged or handed to the handler. */
export function pluginWebhookVerificationHeaders(verification: PluginWebhookVerification): string[] {
  return verification.scheme === 'slack-v0' ? ['x-slack-signature', 'x-slack-request-timestamp'] : [verification.header];
}

export const pluginContributesSchema = z.strictObject({
  mcpServers: z.array(pluginMcpServerSchema).max(PLUGIN_LIMITS.mcpServers).default([]),
  skills: z.array(pluginSkillSchema).max(PLUGIN_LIMITS.skills).default([]),
  automationTemplates: z.array(pluginAutomationTemplateSchema).max(PLUGIN_LIMITS.automationTemplates).default([]),
  commands: z.array(pluginCommandSchema).max(PLUGIN_LIMITS.commands).default([]),
  subscriptions: z.array(pluginSubscriptionSchema).max(PLUGIN_LIMITS.subscriptions).default([]),
  webhooks: z.array(pluginWebhookSchema).max(PLUGIN_LIMITS.webhooks).default([]),
});
export type PluginContributes = z.infer<typeof pluginContributesSchema>;

const duplicates = (values: readonly string[]) => [...new Set(values.filter((value, index) => values.indexOf(value) !== index))];
type Issue = (message: string, path: (string | number)[]) => void;

function checkConnectionReferences(manifest: z.infer<typeof pluginManifestObjectSchema>, issue: Issue) {
  const connections = new Map(manifest.connections.map(c => [c.name, c.type]));
  const expect = (name: string | undefined, type: PluginConnectionType, path: (string | number)[], what: string) => {
    if (name === undefined) return issue(`${what} needs a ${type} connection`, path);
    const actual = connections.get(name);
    if (!actual) issue(`${what} references connection ${name}, which the plugin does not declare`, path);
    else if (actual !== type) issue(`${what} references connection ${name}, which is ${actual}, not ${type}`, path);
  };
  manifest.contributes.mcpServers.forEach((server, index) => {
    const at = ['contributes', 'mcpServers', index];
    if (server.kind === 'https') {
      if (server.authentication === 'none') {
        if (server.connection !== undefined) issue(`Server ${server.name} has no authentication and takes no connection`, [...at, 'connection']);
      } else expect(server.connection, server.authentication === 'oauth' ? 'oauth' : 'token', [...at, 'connection'], `Server ${server.name}`);
      return;
    }
    server.secretEnv.forEach((secret, i) => expect(secret.connection, 'token', [...at, 'secretEnv', i, 'connection'], `Variable ${secret.name} of server ${server.name}`));
    const names = [...server.env.map(e => e.name), ...server.secretEnv.map(e => e.name)];
    for (const name of duplicates(names)) issue(`Variable ${name} of server ${server.name} is listed more than once`, [...at, 'env']);
  });
  manifest.contributes.webhooks.forEach((webhook, index) => {
    const at = ['contributes', 'webhooks', index];
    expect(webhook.verification.connection, 'signing_secret', [...at, 'verification', 'connection'], `Webhook ${webhook.name}`);
    const verified = pluginWebhookVerificationHeaders(webhook.verification);
    for (const header of [...verified, ...(webhook.deliveryIdHeader ? [webhook.deliveryIdHeader] : [])].filter(h => RESERVED_WEBHOOK_HEADERS.includes(h))) issue(`Webhook ${webhook.name} cannot use header ${header}`, at);
    if (webhook.deliveryIdHeader && PLUGIN_WEBHOOK_CREDENTIAL_HEADERS.includes(webhook.deliveryIdHeader)) issue(`Webhook ${webhook.name} cannot use the credential header ${webhook.deliveryIdHeader} as its delivery id`, [...at, 'deliveryIdHeader']);
    if (webhook.deliveryIdHeader && verified.includes(webhook.deliveryIdHeader)) issue(`Webhook ${webhook.name} uses ${webhook.deliveryIdHeader} both for verification and as its delivery id`, [...at, 'deliveryIdHeader']);
    if (webhook.respond && webhook.respond === webhook.handler) issue(`Webhook ${webhook.name} needs a respond function other than its handler`, [...at, 'respond']);
  });
}

/** Each command's permissions, targets and the skills and servers it adds: its own plugin's, and read-only unless it needs write access. */
function checkCommands(manifest: z.infer<typeof pluginManifestObjectSchema>, issue: Issue) {
  const { contributes } = manifest;
  contributes.commands.forEach((command, index) => {
    const at = ['contributes', 'commands', index];
    const missing = command.permissions.filter(p => !manifest.permissions.includes(p));
    if (missing.length) issue(`Command ${command.name} uses permissions the plugin does not request: ${missing.join(', ')}`, [...at, 'permissions']);
    for (const target of duplicates(command.where)) issue(`Command ${command.name} lists ${target} more than once`, [...at, 'where']);
    for (const skill of duplicates(command.skills)) issue(`Command ${command.name} lists skill ${skill} more than once`, [...at, 'skills']);
    for (const server of duplicates(command.servers)) issue(`Command ${command.name} lists server ${server} more than once`, [...at, 'servers']);
    for (const skill of command.skills.filter(name => !contributes.skills.some(s => s.name === name))) issue(`Command ${command.name} adds skill ${skill}, which the plugin does not contribute`, [...at, 'skills']);
    for (const name of command.servers) {
      const server = contributes.mcpServers.find(s => s.name === name);
      if (!server) issue(`Command ${command.name} adds server ${name}, which the plugin does not contribute`, [...at, 'servers']);
      else if (server.capability === 'write' && !command.needsWrite) issue(`Command ${command.name} adds the write server ${name}; set needsWrite`, [...at, 'servers']);
    }
  });
}

type SettingProblem = { message: string; field?: string };
type SettingOf<T extends PluginSetting['type']> = Extract<PluginSetting, { type: T }>;
const outOfRange = (value: number, min?: number, max?: number) => (min !== undefined && value < min) || (max !== undefined && value > max);

function stringSettingProblems(key: string, setting: SettingOf<'string'>): SettingProblem[] {
  const problems: SettingProblem[] = [];
  if (setting.enum && duplicates(setting.enum).length) problems.push({ message: `Setting ${key} lists an enum value more than once`, field: 'enum' });
  if (setting.enum && setting.default !== undefined && !setting.enum.includes(setting.default)) problems.push({ message: `Default of setting ${key} is not one of its enum values`, field: 'default' });
  if (setting.maxLength !== undefined && (setting.default?.length ?? 0) > setting.maxLength) problems.push({ message: `Default of setting ${key} is longer than maxLength`, field: 'default' });
  return problems;
}

function numberSettingProblems(key: string, setting: SettingOf<'number'>): SettingProblem[] {
  const problems: SettingProblem[] = [];
  if (setting.minimum !== undefined && setting.maximum !== undefined && setting.minimum > setting.maximum) problems.push({ message: `Setting ${key} has a minimum above its maximum` });
  const value = setting.default;
  if (value !== undefined && (outOfRange(value, setting.minimum, setting.maximum) || (setting.integer && !Number.isInteger(value)))) problems.push({ message: `Default of setting ${key} is outside its range`, field: 'default' });
  return problems;
}

/** Problems of one setting's own constraints and default. */
function settingProblems(key: string, setting: PluginSetting): SettingProblem[] {
  if (setting.type === 'string') return stringSettingProblems(key, setting);
  if (setting.type === 'number') return numberSettingProblems(key, setting);
  if (setting.type === 'array' && setting.maxItems !== undefined && (setting.default?.length ?? 0) > setting.maxItems) return [{ message: `Default of setting ${key} has more than maxItems entries`, field: 'default' }];
  return [];
}

function checkSettings(settings: PluginSettings, issue: Issue) {
  if (Object.keys(settings.properties).length > PLUGIN_LIMITS.settings) issue(`A plugin can define at most ${PLUGIN_LIMITS.settings} settings`, ['settings', 'properties']);
  for (const key of settings.required) if (!Object.hasOwn(settings.properties, key)) issue(`Required setting ${key} is not defined`, ['settings', 'required']);
  for (const key of duplicates(settings.required)) issue(`Setting ${key} is required more than once`, ['settings', 'required']);
  for (const [key, setting] of Object.entries(settings.properties)) {
    for (const { message, field } of settingProblems(key, setting)) issue(message, ['settings', 'properties', key, ...(field ? [field] : [])]);
  }
}

const pluginManifestObjectSchema = z.strictObject({
  manifestVersion: z.literal(PLUGIN_MANIFEST_VERSION),
  id: pluginIdSchema,
  name: textSchema(80),
  description: textSchema(),
  version: z.string().regex(EXACT_VERSION_PATTERN, 'Enter a semantic version such as 1.0.0'),
  category: z.enum(PLUGIN_CATEGORIES),
  homepage: httpsUrlSchema,
  /** An image file in the plugin folder. */
  icon: pluginAssetPathSchema.regex(/\.(svg|png)$/, 'The icon must be an .svg or .png file'),
  permissions: z.array(z.enum(PLUGIN_PERMISSIONS)).max(PLUGIN_LIMITS.permissions).default([]),
  connections: z.array(pluginConnectionSchema).max(PLUGIN_LIMITS.connections).default([]),
  settings: pluginSettingsSchema.default({ type: 'object', properties: {}, required: [] }),
  /** Hostnames the plugin's handlers may call. */
  outboundHosts: z.array(pluginHostnameSchema).max(PLUGIN_LIMITS.outboundHosts).default([]),
  contributes: pluginContributesSchema.default({ mcpServers: [], skills: [], automationTemplates: [], commands: [], subscriptions: [], webhooks: [] }),
});

/** The manifest of one plugin, with every cross-reference checked. */
export const pluginManifestSchema = pluginManifestObjectSchema.superRefine((manifest, ctx) => {
  const issue: Issue = (message, path) => ctx.addIssue({ code: 'custom', message, path });
  const unique = (values: string[], what: string, path: (string | number)[]) => {
    for (const value of duplicates(values)) issue(`Duplicate ${what} ${value}`, path);
  };
  unique(manifest.permissions, 'permission', ['permissions']);
  unique(manifest.connections.map(c => c.name), 'connection name', ['connections']);
  unique(manifest.outboundHosts, 'outbound host', ['outboundHosts']);
  const { contributes } = manifest;
  unique(contributes.mcpServers.map(s => s.name), 'server name', ['contributes', 'mcpServers']);
  unique(contributes.skills.map(s => s.name), 'skill name', ['contributes', 'skills']);
  unique(contributes.automationTemplates.map(t => t.id), 'automation template id', ['contributes', 'automationTemplates']);
  unique(contributes.commands.map(c => c.name), 'command name', ['contributes', 'commands']);
  unique(contributes.subscriptions.map(s => `${s.on} → ${s.handler}`), 'subscription', ['contributes', 'subscriptions']);
  unique(contributes.webhooks.map(w => w.name), 'webhook name', ['contributes', 'webhooks']);
  checkConnectionReferences(manifest, issue);
  checkSettings(manifest.settings, issue);
  checkCommands(manifest, issue);
  if (contributes.subscriptions.length && !manifest.permissions.includes('events.read')) issue('Event subscriptions need the events.read permission', ['contributes', 'subscriptions']);
});
export type PluginManifest = z.infer<typeof pluginManifestSchema>;
export type PluginManifestInput = z.input<typeof pluginManifestSchema>;

/** Readable one-line messages for a failed manifest parse: `path: message`. */
export function formatPluginManifestIssues(error: z.ZodError): string[] {
  return error.issues.map(issue => (issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message));
}

/** Validate a manifest: the parsed value, or readable messages. */
export function parsePluginManifest(value: unknown): { ok: true; manifest: PluginManifest } | { ok: false; errors: string[] } {
  const result = pluginManifestSchema.safeParse(value);
  return result.success ? { ok: true, manifest: result.data } : { ok: false, errors: formatPluginManifestIssues(result.error) };
}

/** What the plugin page and API show about a contributed server: never launch arguments or environment values. */
export type PublicPluginMcpServer =
  | { kind: 'https'; name: string; url: string; tools: string[]; capability: 'read' | 'write'; authentication: 'none' | 'bearer' | 'oauth'; connection?: string }
  | { kind: 'package'; name: string; ecosystem: string; package: string; version: string; tools: string[]; capability: 'read' | 'write'; secretEnv: { name: string; connection: string }[] };
/** What the plugin page and API show about a contributed command: never its prompt text. */
export interface PublicPluginCommand { name: string; description: string; where: CommandTarget[]; kind: PluginCommandKind; skills: string[]; servers: string[]; needsWrite: boolean }
export interface PublicPluginManifest {
  id: string; name: string; description: string; version: string; category: PluginCategory; homepage: string;
  permissions: { name: PluginPermission; description: string }[];
  connections: PluginConnection[];
  settings: PluginSettings;
  outboundHosts: string[];
  contributes: {
    mcpServers: PublicPluginMcpServer[];
    skills: string[];
    automationTemplates: string[];
    commands: PublicPluginCommand[];
    subscriptions: string[];
    webhooks: { name: string; description: string; scheme: PluginWebhookScheme }[];
  };
}

/** The public projection of a manifest: safe to show any signed-in user, independent of the plugin folder layout. */
export function publicPluginManifest(manifest: PluginManifest): PublicPluginManifest {
  const { contributes } = manifest;
  return {
    id: manifest.id, name: manifest.name, description: manifest.description, version: manifest.version, category: manifest.category, homepage: manifest.homepage,
    permissions: manifest.permissions.map(name => ({ name, description: PLUGIN_PERMISSION_DESCRIPTIONS[name] })),
    connections: manifest.connections.map(connection => ({ ...connection })),
    settings: manifest.settings,
    outboundHosts: [...manifest.outboundHosts],
    contributes: {
      mcpServers: contributes.mcpServers.map((server): PublicPluginMcpServer => (server.kind === 'https'
        ? { kind: 'https', name: server.name, url: server.url, tools: [...server.tools], capability: server.capability, authentication: server.authentication, ...(server.connection ? { connection: server.connection } : {}) }
        : { kind: 'package', name: server.name, ecosystem: server.ecosystem, package: server.package, version: server.version, tools: [...server.tools], capability: server.capability, secretEnv: server.secretEnv.map(s => ({ ...s })) })),
      skills: contributes.skills.map(s => s.name),
      automationTemplates: contributes.automationTemplates.map(t => t.id),
      commands: contributes.commands.map(c => ({ name: c.name, description: c.description, where: [...c.where], kind: c.kind, skills: [...c.skills], servers: [...c.servers], needsWrite: c.needsWrite })),
      subscriptions: contributes.subscriptions.map(s => s.on),
      webhooks: contributes.webhooks.map(w => ({ name: w.name, description: w.description, scheme: w.verification.scheme })),
    },
  };
}
