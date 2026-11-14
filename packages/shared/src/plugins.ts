import { z } from 'zod';
import { EXTENSION_OAUTH_REGISTRATIONS } from './extensionOAuth.js';
import { extensionServerNameSchema, remoteMcpSchema } from './extensionProfiles.js';
import { extensionPackageEnvNameSchema, extensionPackageIntegritySchema, packageServerFields, EXACT_VERSION_PATTERN } from './extensionPackages.js';

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
export const RESERVED_PLUGIN_IDS = ['src', 'dist', 'test', 'node_modules', 'propr'] as const;
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
/** Accepted and validated now; ignored at runtime until commands land. */
export const pluginCommandSchema = z.strictObject({ name: keySchema, description: textSchema(200), permissions: z.array(z.enum(PLUGIN_PERMISSIONS)).max(PLUGIN_LIMITS.permissions).default([]) });
/** Accepted and validated now; ignored at runtime until subscriptions land. */
export const pluginSubscriptionSchema = z.strictObject({ event: z.string().regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/, 'Use a dotted event name such as task.completed') });
/** Accepted and validated now; ignored at runtime until webhooks land. Each webhook is verified with a `signing_secret` connection. */
export const pluginWebhookSchema = z.strictObject({ name: keySchema, description: textSchema(200), connection: keySchema });

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
  manifest.contributes.webhooks.forEach((webhook, index) => expect(webhook.connection, 'signing_secret', ['contributes', 'webhooks', index, 'connection'], `Webhook ${webhook.name}`));
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
  unique(contributes.subscriptions.map(s => s.event), 'subscription', ['contributes', 'subscriptions']);
  unique(contributes.webhooks.map(w => w.name), 'webhook name', ['contributes', 'webhooks']);
  checkConnectionReferences(manifest, issue);
  checkSettings(manifest.settings, issue);
  contributes.commands.forEach((command, index) => {
    const missing = command.permissions.filter(p => !manifest.permissions.includes(p));
    if (missing.length) issue(`Command ${command.name} uses permissions the plugin does not request: ${missing.join(', ')}`, ['contributes', 'commands', index, 'permissions']);
  });
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
    commands: { name: string; description: string }[];
    subscriptions: string[];
    webhooks: { name: string; description: string }[];
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
      commands: contributes.commands.map(c => ({ name: c.name, description: c.description })),
      subscriptions: contributes.subscriptions.map(s => s.event),
      webhooks: contributes.webhooks.map(w => ({ name: w.name, description: w.description })),
    },
  };
}
