import { z } from 'zod';
import { EXTENSION_OAUTH_REGISTRATIONS } from './extensionOAuth.js';
import { extensionServerNameSchema, remoteMcpSchema } from './extensionProfiles.js';
import { extensionPackageEnvNameSchema, extensionPackageIntegritySchema, packageServerFields, EXACT_VERSION_PATTERN } from './extensionPackages.js';
import { isRepositoryEventType } from './repositoryEvents.js';
import { BUILT_IN_COMMAND_NAMES, COMMAND_NAME_PATTERN, COMMAND_TARGETS, isBuiltInCommandName, pluginCommandInstruction, type CommandTarget } from './commands.js';

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
/** The folder of code shared by several official plugins (`packages/plugins/_shared/`); never a plugin. */
export const PLUGIN_SHARED_FOLDER = '_shared' as const;
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
export const PLUGIN_HOSTNAME_PATTERN = /^(?=.*[a-z])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const pluginHostnameSchema = z.string().max(253).regex(PLUGIN_HOSTNAME_PATTERN, 'Enter a hostname such as api.example.com');
/** Names that always mean this host, the local network or cloud metadata, whatever DNS says (as the extension endpoint policy treats them). */
export function isLocalPluginHostname(host: string): boolean {
  return /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home\.arpa)$/i.test(host);
}

/** The string setting formats: `https-url` is an `https://` URL to a public host name. */
export const PLUGIN_STRING_SETTING_FORMATS = ['https-url'] as const;
export type PluginStringSettingFormat = typeof PLUGIN_STRING_SETTING_FORMATS[number];
/**
 * Why `value` is not an acceptable `https-url` setting value, or null. The URL
 * must be `https://`, on the default port, without credentials or a fragment,
 * and name a public host: a DNS name (never an IP address, so no private or
 * loopback address can be written down) that is not a local name. Whether the
 * name resolves to public addresses only is checked when the settings are
 * saved and again on every request.
 */
export function pluginHttpsUrlProblem(value: string): string | null {
  let url: URL;
  try { url = new URL(value); } catch { return 'must be an https:// URL'; }
  if (url.protocol !== 'https:') return `must be an https:// URL, not ${url.protocol.replace(/:$/, '')}`;
  if (url.username || url.password) return 'must not carry a user name or password';
  if (url.port && url.port !== '443') return 'must use the default HTTPS port';
  if (url.hash) return 'must not have a #fragment';
  const host = url.hostname.toLowerCase();
  if (!PLUGIN_HOSTNAME_PATTERN.test(host)) return `must name a public host such as hooks.example.com, not ${/^[\d.]+$|^\[/.test(host) ? 'an IP address' : host}`;
  if (isLocalPluginHostname(host)) return `must name a public host, not the local name ${host}`;
  return null;
}
/** The lower-case host name of an acceptable `https-url` value, or null. */
export function pluginHttpsUrlHost(value: unknown): string | null {
  return typeof value === 'string' && value && !pluginHttpsUrlProblem(value) ? new URL(value).hostname.toLowerCase() : null;
}

const connectionBase = { name: keySchema, label: textSchema(100), help: textSchema(), helpUrl: httpsUrlSchema };

/**
 * A host pattern of a secret URL connection: a hostname, or `*.` and a
 * hostname for any name ending in `.<hostname>` (at least one label more).
 */
export const PLUGIN_SECRET_URL_HOST_PATTERN = /^(?:\*\.)?(?=.*[a-z])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/**
 * A `token` connection whose value is a secret URL (a chat service's incoming
 * webhook URL, whose path carries the credential): the value must be an
 * `https://` URL on one of `hosts` and, with `pathPrefixes`, under one of them.
 * The handler never sees it: `ctx.http(<connection>)(PLUGIN_CONNECTION_URL)`
 * sends to the stored URL, and only to it.
 */
export const pluginSecretUrlSchema = z.strictObject({
  hosts: z.array(z.string().max(253).regex(PLUGIN_SECRET_URL_HOST_PATTERN, 'Enter a hostname such as hooks.example.com, or *.example.com')).min(1).max(8),
  pathPrefixes: z.array(z.string().max(200).regex(/^\/[A-Za-z0-9_.~/-]*$/, 'Enter a path such as /services/')).min(1).max(8).optional(),
});
export type PluginSecretUrl = z.infer<typeof pluginSecretUrlSchema>;

/** Whether `host` (lower case) matches one of the secret URL host patterns. */
export function pluginSecretUrlHostAllowed(hosts: readonly string[], host: string): boolean {
  const name = host.toLowerCase();
  return hosts.some(pattern => (pattern.startsWith('*.') ? name.endsWith(pattern.slice(1)) && name.length > pattern.length - 1 : name === pattern));
}

/**
 * Why `value` is not an acceptable value of a secret URL connection, or null:
 * an `https://` URL to a public host name (as `pluginHttpsUrlProblem` requires)
 * that one of the connection's host patterns takes, under one of its path
 * prefixes. The message never repeats the value: it is a secret.
 */
export function pluginSecretUrlProblem(secretUrl: PluginSecretUrl, value: string): string | null {
  const problem = pluginHttpsUrlProblem(value);
  if (problem) return `The URL ${problem.replace(/, not .*$/, '')}`;
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  const hosts = secretUrl.hosts.join(', ');
  if (!pluginSecretUrlHostAllowed(secretUrl.hosts, host)) return `The URL must be on ${secretUrl.hosts.length === 1 ? hosts : `one of ${hosts}`}, not ${host}`;
  const prefixes = secretUrl.pathPrefixes;
  if (prefixes && !prefixes.some(prefix => url.pathname.startsWith(prefix))) return `The URL's path must start with ${prefixes.join(' or ')}`;
  return null;
}

/**
 * Why `value` is not acceptable for an `https-url` string setting, or null:
 * `pluginHttpsUrlProblem`, and with `hosts`, a host one of them takes.
 */
export function pluginHttpsUrlSettingProblem(setting: { hosts?: readonly string[] }, value: string): string | null {
  const problem = pluginHttpsUrlProblem(value);
  if (problem || !setting.hosts) return problem;
  const host = new URL(value).hostname.toLowerCase();
  if (pluginSecretUrlHostAllowed(setting.hosts, host)) return null;
  return `must be on ${setting.hosts.length === 1 ? setting.hosts[0] : `one of ${setting.hosts.join(', ')}`}, not ${host}`;
}

/** How a `token` connection's credential is written in the `Authorization` header of `ctx.http` requests. */
export const PLUGIN_TOKEN_AUTHORIZATIONS = ['bearer', 'raw', 'basic'] as const;
export type PluginTokenAuthorization = typeof PLUGIN_TOKEN_AUTHORIZATIONS[number];
/** The URL a handler passes to `ctx.http(<secret URL connection>)`: ProPR sends to the connection's stored URL instead. */
export const PLUGIN_CONNECTION_URL = 'propr-connection:url' as const;
export const pluginConnectionSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('oauth'), ...connectionBase,
    /** Registration methods allowed, in the order the extension OAuth sign-in tries them. */
    registrations: z.array(z.enum(EXTENSION_OAUTH_REGISTRATIONS)).min(1).max(EXTENSION_OAUTH_REGISTRATIONS.length).default([...EXTENSION_OAUTH_REGISTRATIONS]),
    scopes: remoteMcpSchema.shape.scopes,
  }),
  z.strictObject({
    type: z.literal('token'), ...connectionBase,
    /** The token is a secret URL (an incoming webhook URL) on these hosts: see `pluginSecretUrlSchema`. */
    secretUrl: pluginSecretUrlSchema.optional(),
    /**
     * How `ctx.http(<connection>)` sends the token: `bearer` (the default) as
     * `Authorization: Bearer <token>`, `raw` as `Authorization: <token>`, for
     * services whose API keys take no scheme (Linear's personal API keys),
     * `basic` as `Authorization: Basic <base64 of the token>`, for services
     * that take a user name and an API token as HTTP Basic credentials (Jira
     * Cloud's account email and API token): the token is stored as
     * `<user>:<secret>`, and a value without that shape is refused when set.
     * MCP servers using the connection always receive it as Bearer.
     */
    authorization: z.enum(PLUGIN_TOKEN_AUTHORIZATIONS).optional(),
  }),
  z.strictObject({ type: z.literal('signing_secret'), ...connectionBase }),
]);
export type PluginConnection = z.infer<typeof pluginConnectionSchema>;

const settingBase = { label: textSchema(100), help: textSchema().optional() };
/**
 * `optionsFrom` names an exported handler of the plugin that lists the
 * setting's choices from the service (Linear's teams, a workflow's states):
 * the configure form loads them through the settings options route and offers
 * them in a select. Saved values are still plain strings, validated like any
 * other; the handler runs with outbound HTTP only (see `PluginSettingOptionsInput`).
 */
const optionsFromSchema = z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/, 'Use the name of an exported handler function');
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
    /** `https-url`: an `https://` URL to a public host (see `pluginHttpsUrlProblem`). */
    format: z.enum(PLUGIN_STRING_SETTING_FORMATS).optional(),
    /**
     * With `format: https-url`: the hosts the URL must be on, as host names or
     * `*.` patterns (`*.atlassian.net`), checked when the settings are saved
     * and again when the handlers' outbound hosts are derived from them.
     */
    hosts: z.array(z.string().max(253).regex(PLUGIN_SECRET_URL_HOST_PATTERN, 'Enter a hostname such as hooks.example.com, or *.example.com')).min(1).max(8).optional(),
    /** The handler that lists the choices of this select; see `optionsFromSchema`. */
    optionsFrom: optionsFromSchema.optional(),
  }),
  z.strictObject({
    type: z.literal('number'), ...settingBase, default: z.number().finite().optional(),
    minimum: z.number().finite().optional(), maximum: z.number().finite().optional(), integer: z.boolean().optional(),
  }),
  z.strictObject({ type: z.literal('boolean'), ...settingBase, default: z.boolean().optional() }),
  z.strictObject({
    type: z.literal('array'), ...settingBase,
    /** With `enum`, every entry is one of a fixed list of values (a multiple choice). */
    items: z.strictObject({ type: z.literal('string'), enum: z.array(z.string().min(1).max(100)).min(1).max(PLUGIN_LIMITS.enumValues).optional() }),
    default: stringList.optional(), maxItems: z.number().int().positive().max(PLUGIN_LIMITS.listItems).optional(),
  }),
  z.strictObject({
    type: z.literal('object'), ...settingBase, format: z.literal('repository-map'),
    additionalProperties: z.strictObject({ type: z.literal('string') }),
    /** The handler that lists the choices of each repository's value; see `optionsFromSchema`. */
    optionsFrom: optionsFromSchema.optional(),
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
/**
 * Whether the managed library item starts with automatic apply on (the
 * default). A write server a command adds explicitly sets it to false, so it
 * never reaches a run the command did not authorize; administrators may still
 * change it in the library.
 */
const serverAutoApplySchema = z.boolean().default(true);
export const pluginRemoteServerSchema = remoteMcpSchema.omit({ enabled: true, scopes: true, clientId: true }).extend({
  url: httpsUrlSchema,
  /** Required unless `authentication` is `none`: a `token` connection for `bearer`, an `oauth` connection for `oauth`. */
  connection: keySchema.optional(),
  autoApply: serverAutoApplySchema,
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
  autoApply: serverAutoApplySchema,
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
export const PLUGIN_COMMAND_KINDS = ['prompt', 'handler'] as const;
export type PluginCommandKind = typeof PLUGIN_COMMAND_KINDS[number];
/**
 * A plugin setting a `prompt` command states in its task's instruction, as an
 * administrator saved it (or its default): a string, number or list as its
 * value, a repository map as the entry of the comment's repository. A boolean
 * setting may give the sentence the instruction states for each value (`on`,
 * `off`), such as the deploy target a command may use; without them it
 * states on or off. The comment's argument can never change these lines.
 */
export const pluginCommandSettingSchema = z.strictObject({
  setting: settingKeySchema,
  on: textSchema().optional(),
  off: textSchema().optional(),
});
export type PluginCommandSetting = z.infer<typeof pluginCommandSettingSchema>;
/**
 * A slash command used in issue or pull request comments (`where`).
 *
 * A `prompt` command queues an ordinary one-shot task: a follow-up on a pull
 * request, an implementation task on an issue. Its instruction is `prompt`,
 * with the rest of the command line appended as the person's (untrusted)
 * argument; `skills` and `servers` name this plugin's own contributions to add
 * to that run. A command with `needsWrite` may add the plugin's write servers:
 * it runs only when an administrator allowed it write access on the Plugins
 * page and the commenter has write permission on the repository, and the
 * write servers reach that one run only.
 *
 * A `handler` command calls `handler`, an exported function of the plugin's
 * `handlers.ts`, with the comment context as a delivery of kind `command`.
 *
 * A `shared` command name (for example `/deploy`) may be offered by several
 * plugins; each such plugin names in `specific` its own commands that perform
 * the same operation under a name of their own (not shared, of the same kind,
 * usable wherever the shared name is, and for a handler command calling the
 * same handler). When several enabled plugins offer it for one
 * repository, an instance setting chooses which one the plain name runs.
 */
export const pluginCommandSchema = z.strictObject({
  name: pluginCommandNameSchema,
  description: textSchema(200),
  where: z.array(z.enum(COMMAND_TARGETS)).min(1).max(COMMAND_TARGETS.length),
  kind: z.enum(PLUGIN_COMMAND_KINDS),
  /** The instruction of a `prompt` command. */
  prompt: textSchema(4000).optional(),
  /** The handler a `handler` command calls. */
  handler: z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/, 'Use the name of an exported handler function').optional(),
  skills: z.array(keySchema).max(PLUGIN_LIMITS.skills).default([]),
  servers: z.array(extensionServerNameSchema).max(PLUGIN_LIMITS.mcpServers).default([]),
  needsWrite: z.boolean().default(false),
  shared: z.boolean().default(false),
  /** Of a `shared` command: this plugin's commands that perform the same operation under their own name. */
  specific: z.array(pluginCommandNameSchema).max(PLUGIN_LIMITS.commands).default([]),
  permissions: z.array(z.enum(PLUGIN_PERMISSIONS)).max(PLUGIN_LIMITS.permissions).default([]),
  /** Of a `prompt` command: plugin settings whose current values the task instruction states; see `pluginCommandSettingSchema`. */
  promptSettings: z.array(pluginCommandSettingSchema).max(16).default([]),
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
  const secretUrls = new Set(manifest.connections.flatMap(c => (c.type === 'token' && c.secretUrl ? [c.name] : [])));
  const expect = (name: string | undefined, type: PluginConnectionType, path: (string | number)[], what: string) => {
    if (name === undefined) return issue(`${what} needs a ${type} connection`, path);
    const actual = connections.get(name);
    if (!actual) issue(`${what} references connection ${name}, which the plugin does not declare`, path);
    else if (actual !== type) issue(`${what} references connection ${name}, which is ${actual}, not ${type}`, path);
    else if (secretUrls.has(name)) issue(`${what} references connection ${name}, whose value is a secret URL, not a token`, path);
  };
  manifest.connections.forEach((connection, index) => {
    if (connection.type === 'token' && connection.secretUrl && connection.authorization) issue(`Connection ${connection.name} is a secret URL; it sends no Authorization header, so it takes no authorization`, ['connections', index, 'authorization']);
  });
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
    checkCommandKind(command, issue, at);
    checkSharedCommand(command, contributes.commands, issue, at);
    checkPromptSettings(command, manifest.settings, issue, at);
  });
}

/** Each setting a command states is a defined setting, named once; only a boolean setting has `on` and `off` sentences. */
function checkPromptSettings(command: PluginCommand, settings: PluginSettings, issue: Issue, at: (string | number)[]) {
  if (command.promptSettings.length && command.kind !== 'prompt') issue(`Command ${command.name} is a handler command; only prompt commands state settings`, [...at, 'promptSettings']);
  for (const key of duplicates(command.promptSettings.map(s => s.setting))) issue(`Command ${command.name} states setting ${key} more than once`, [...at, 'promptSettings']);
  command.promptSettings.forEach((entry, index) => {
    const setting = Object.hasOwn(settings.properties, entry.setting) ? settings.properties[entry.setting] : undefined;
    if (!setting) issue(`Command ${command.name} states setting ${entry.setting}, which the plugin does not define`, [...at, 'promptSettings', index, 'setting']);
    else if (setting.type !== 'boolean' && (entry.on !== undefined || entry.off !== undefined)) issue(`Command ${command.name} gives on and off sentences for setting ${entry.setting}, which is not a boolean setting`, [...at, 'promptSettings', index]);
  });
}

/**
 * The lines a `prompt` command's instruction states for its `promptSettings`,
 * from the installation's saved values (a missing value falls back to the
 * manifest default): `<label>: <value>` with the value as a JSON literal, a
 * repository map's entry for `repository` (compared without letter case),
 * and a boolean's `on` or `off` sentence when the manifest gives one.
 */
export function pluginCommandSettingLines(manifest: Pick<PluginManifest, 'settings'>, command: Pick<PluginCommand, 'promptSettings'>, values: Readonly<Record<string, unknown>>, repository: string): string[] {
  return command.promptSettings.flatMap(entry => {
    const setting = Object.hasOwn(manifest.settings.properties, entry.setting) ? manifest.settings.properties[entry.setting] : undefined;
    if (!setting) return [];
    const value = Object.hasOwn(values, entry.setting) ? values[entry.setting] : setting.default;
    const notSet = `${setting.label}: not set`;
    if (setting.type === 'boolean') {
      const on = value === true;
      return [(on ? entry.on : entry.off) ?? `${setting.label}: ${on ? 'on' : 'off'}`];
    }
    if (setting.type === 'object') {
      const map = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
      const key = Object.keys(map).find(name => name.toLowerCase() === repository.toLowerCase());
      const entryValue = key === undefined ? undefined : map[key];
      return [typeof entryValue === 'string' && entryValue ? `${setting.label} for ${repository}: ${JSON.stringify(entryValue)}` : `${setting.label} for ${repository}: not set`];
    }
    if (value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length)) return [notSet];
    return [`${setting.label}: ${JSON.stringify(value)}`];
  });
}

/**
 * The task instruction of a `prompt` command run, as ProPR queues it: the
 * manifest prompt, the lines of its `promptSettings` from the installation's
 * `settings` for the comment's `repository`, then the delimited argument.
 */
export function pluginCommandTaskInstruction(
  manifest: Pick<PluginManifest, 'name' | 'settings'>, command: Pick<PluginCommand, 'name' | 'prompt' | 'promptSettings'>,
  input: { argument: string; author?: string; settings: Readonly<Record<string, unknown>>; repository: string },
): string {
  return pluginCommandInstruction({
    pluginName: manifest.name, command: command.name, prompt: command.prompt ?? '', argument: input.argument, author: input.author,
    settings: pluginCommandSettingLines(manifest, command, input.settings, input.repository),
  });
}

/**
 * A `shared` command names at least one specific command of its plugin, and
 * each one it names performs the same operation: not shared, of the same kind,
 * usable wherever the shared name is, and calling the same handler. Only a
 * shared command names specific commands.
 */
function checkSharedCommand(command: PluginCommand, commands: readonly PluginCommand[], issue: Issue, at: (string | number)[]) {
  if (!command.shared) {
    if (command.specific.length) issue(`Command ${command.name} is not shared; only a shared command names specific commands`, [...at, 'specific']);
    return;
  }
  if (!command.specific.length) {
    issue(`Shared command ${command.name} needs a specific command of this plugin, named in specific: one that is not shared, of kind ${command.kind}, usable wherever /${command.name} is`, [...at, 'specific']);
    return;
  }
  for (const name of duplicates(command.specific)) issue(`Shared command ${command.name} lists specific command ${name} more than once`, [...at, 'specific']);
  for (const name of new Set(command.specific)) {
    const other = commands.find(c => c.name === name);
    const problem = !other ? 'which the plugin does not contribute' : specificCommandProblem(command, other);
    if (problem) issue(`Shared command ${command.name} names specific command ${name}, ${problem}`, [...at, 'specific']);
  }
}

/** Why `other` cannot stand in for the shared `command`, or null when it performs the same operation. */
function specificCommandProblem(command: PluginCommand, other: PluginCommand): string | null {
  if (other.name === command.name || other.shared) return 'which is shared itself';
  if (other.kind !== command.kind) return `which is not of kind ${command.kind}`;
  if (!command.where.every(target => other.where.includes(target))) return `which is not usable wherever /${command.name} is`;
  if (command.kind === 'handler' && other.handler !== command.handler) return `which calls a different handler than ${command.handler}`;
  return null;
}

/** A `prompt` command has a prompt and no handler; a `handler` command has a handler and adds no skills or servers. */
function checkCommandKind(command: PluginCommand, issue: Issue, at: (string | number)[]) {
  if (command.kind === 'prompt') {
    if (command.prompt === undefined) issue(`Command ${command.name} is a prompt command and needs a prompt`, [...at, 'prompt']);
    if (command.handler !== undefined) issue(`Command ${command.name} is a prompt command; only handler commands name a handler`, [...at, 'handler']);
    return;
  }
  if (command.handler === undefined) issue(`Command ${command.name} is a handler command and needs a handler`, [...at, 'handler']);
  if (command.prompt !== undefined) issue(`Command ${command.name} is a handler command; only prompt commands have a prompt`, [...at, 'prompt']);
  if (command.skills.length || command.servers.length) issue(`Command ${command.name} is a handler command; it adds no skills or servers to a run`, [...at, command.skills.length ? 'skills' : 'servers']);
  if (command.needsWrite) issue(`Command ${command.name} is a handler command; needsWrite applies to prompt commands`, [...at, 'needsWrite']);
}

/**
 * The specific commands that stand in for a `shared` command of the same
 * plugin: the ones it names in `specific`, in that order, that perform the
 * same operation. Empty for a command that is not shared.
 */
export function pluginSharedCommandSiblings(commands: readonly PluginCommand[], command: PluginCommand): PluginCommand[] {
  if (!command.shared) return [];
  return [...new Set(command.specific)].flatMap(name => {
    const other = commands.find(c => c.name === name);
    return other && !specificCommandProblem(command, other) ? [other] : [];
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
  if (setting.format && setting.enum) problems.push({ message: `Setting ${key} has a format and an enum; use one`, field: 'format' });
  if (setting.optionsFrom && (setting.enum || setting.format)) problems.push({ message: `Setting ${key} has optionsFrom and ${setting.enum ? 'an enum' : 'a format'}; use one`, field: 'optionsFrom' });
  if (setting.hosts && setting.format !== 'https-url') problems.push({ message: `Setting ${key} lists hosts but is not an https-url setting`, field: 'hosts' });
  if (setting.format === 'https-url' && setting.default !== undefined && setting.default !== '') {
    const problem = pluginHttpsUrlSettingProblem(setting, setting.default);
    if (problem) problems.push({ message: `Default of setting ${key} ${problem}`, field: 'default' });
  }
  return problems;
}

function numberSettingProblems(key: string, setting: SettingOf<'number'>): SettingProblem[] {
  const problems: SettingProblem[] = [];
  if (setting.minimum !== undefined && setting.maximum !== undefined && setting.minimum > setting.maximum) problems.push({ message: `Setting ${key} has a minimum above its maximum` });
  const value = setting.default;
  if (value !== undefined && (outOfRange(value, setting.minimum, setting.maximum) || (setting.integer && !Number.isInteger(value)))) problems.push({ message: `Default of setting ${key} is outside its range`, field: 'default' });
  return problems;
}

function arraySettingProblems(key: string, setting: SettingOf<'array'>): SettingProblem[] {
  const problems: SettingProblem[] = [];
  if (setting.maxItems !== undefined && (setting.default?.length ?? 0) > setting.maxItems) problems.push({ message: `Default of setting ${key} has more than maxItems entries`, field: 'default' });
  const choices = setting.items.enum;
  if (choices && duplicates(choices).length) problems.push({ message: `Setting ${key} lists an enum value more than once`, field: 'items' });
  if (choices && setting.default?.some(value => !choices.includes(value))) problems.push({ message: `Default of setting ${key} has an entry that is not one of its enum values`, field: 'default' });
  return problems;
}

/** Problems of one setting's own constraints and default. */
function settingProblems(key: string, setting: PluginSetting): SettingProblem[] {
  if (setting.type === 'string') return stringSettingProblems(key, setting);
  if (setting.type === 'number') return numberSettingProblems(key, setting);
  if (setting.type === 'array') return arraySettingProblems(key, setting);
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

/** Each setting `outboundHostsFromSettings` names is a defined `https-url` string setting, named once. */
function checkOutboundHostsFromSettings(manifest: z.infer<typeof pluginManifestObjectSchema>, issue: Issue) {
  const at = ['outboundHostsFromSettings'];
  for (const key of duplicates(manifest.outboundHostsFromSettings)) issue(`Setting ${key} is listed more than once`, at);
  manifest.outboundHostsFromSettings.forEach((key, index) => {
    const setting = Object.hasOwn(manifest.settings.properties, key) ? manifest.settings.properties[key] : undefined;
    if (!setting) issue(`outboundHostsFromSettings names setting ${key}, which the plugin does not define`, [...at, index]);
    else if (setting.type !== 'string' || setting.format !== 'https-url') issue(`outboundHostsFromSettings names setting ${key}, which is not a string setting with format https-url`, [...at, index]);
  });
}

/**
 * The hostnames a plugin's handlers may call with these settings: the
 * manifest's `outboundHosts` and the host of each `outboundHostsFromSettings`
 * URL that is set and acceptable. Lower case, each once.
 */
export function pluginOutboundHosts(manifest: Pick<PluginManifest, 'outboundHosts' | 'outboundHostsFromSettings'> & { settings?: Pick<PluginManifest['settings'], 'properties'> }, settings: Readonly<Record<string, unknown>>): string[] {
  const fromSettings = manifest.outboundHostsFromSettings.map(key => {
    if (!Object.hasOwn(settings, key)) return null;
    // A URL off the setting's hosts (saved before they were declared) adds no host.
    const setting = manifest.settings && Object.hasOwn(manifest.settings.properties, key) ? manifest.settings.properties[key] : undefined;
    const value = settings[key];
    if (setting?.type === 'string' && typeof value === 'string' && pluginHttpsUrlSettingProblem(setting, value)) return null;
    return pluginHttpsUrlHost(value);
  });
  return [...new Set([...manifest.outboundHosts, ...fromSettings.filter((host): host is string => host !== null)])];
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
  /**
   * Settings (string settings of `format: https-url`) whose URL's host the
   * handlers may also call, as the administrator saved it: for user-entered
   * targets such as outbound webhook URLs.
   */
  outboundHostsFromSettings: z.array(settingKeySchema).max(PLUGIN_LIMITS.settings).default([]),
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
  checkOutboundHostsFromSettings(manifest, issue);
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
export interface PublicPluginCommand {
  name: string; description: string; where: CommandTarget[]; kind: PluginCommandKind; skills: string[]; servers: string[]; needsWrite: boolean;
  /** Several plugins may offer this name; `specific` names this plugin's own commands that stand in for it. */
  shared: boolean; specific: string[];
}
export interface PublicPluginManifest {
  id: string; name: string; description: string; version: string; category: PluginCategory; homepage: string;
  permissions: { name: PluginPermission; description: string }[];
  connections: PluginConnection[];
  settings: PluginSettings;
  outboundHosts: string[];
  /** Settings whose URL host the handlers may also call. */
  outboundHostsFromSettings: string[];
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
    outboundHostsFromSettings: [...manifest.outboundHostsFromSettings],
    contributes: {
      mcpServers: contributes.mcpServers.map((server): PublicPluginMcpServer => (server.kind === 'https'
        ? { kind: 'https', name: server.name, url: server.url, tools: [...server.tools], capability: server.capability, authentication: server.authentication, ...(server.connection ? { connection: server.connection } : {}) }
        : { kind: 'package', name: server.name, ecosystem: server.ecosystem, package: server.package, version: server.version, tools: [...server.tools], capability: server.capability, secretEnv: server.secretEnv.map(s => ({ ...s })) })),
      skills: contributes.skills.map(s => s.name),
      automationTemplates: contributes.automationTemplates.map(t => t.id),
      commands: contributes.commands.map(c => ({
        name: c.name, description: c.description, where: [...c.where], kind: c.kind, skills: [...c.skills], servers: [...c.servers], needsWrite: c.needsWrite,
        shared: c.shared, specific: pluginSharedCommandSiblings(contributes.commands, c).map(s => s.name),
      })),
      subscriptions: contributes.subscriptions.map(s => s.on),
      webhooks: contributes.webhooks.map(w => ({ name: w.name, description: w.description, scheme: w.verification.scheme })),
    },
  };
}
