import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  PLUGIN_PERMISSIONS, parsePluginManifest, pluginHttpsUrlHost, pluginSecretUrlHostAllowed, pluginSecretUrlProblem, pluginManifestSchema, pluginOutboundHosts, pluginSharedCommandSiblings, publicPluginManifest,
  type PluginManifestInput,
} from '../src/plugins.js';
import { pluginSettingProblem, validatePluginSettings } from '../src/pluginInstallations.js';
import { PLUGIN_SETTING_OPTIONS_LIMITS, parsePluginSettingOptions } from '../src/pluginSdk.js';

const INTEGRITY = `sha512-${'A'.repeat(86)}==`;
const valid = (): PluginManifestInput => ({
  manifestVersion: 1, id: 'acme-chat', name: 'Acme Chat', description: 'Posts ProPR updates to Acme Chat.', version: '1.2.0',
  category: 'messaging', homepage: 'https://acme.example.com/propr', icon: 'icon.svg',
  permissions: ['events.read', 'pull_requests.read'],
  connections: [
    { type: 'oauth', name: 'workspace', label: 'Acme workspace', help: 'Sign in to the workspace.', helpUrl: 'https://acme.example.com/oauth' },
    { type: 'token', name: 'bot-token', label: 'Bot token', help: 'Create a bot token.', helpUrl: 'https://acme.example.com/tokens' },
    { type: 'signing_secret', name: 'events-secret', label: 'Signing secret', help: 'Copy the signing secret.', helpUrl: 'https://acme.example.com/apps' },
  ],
  settings: {
    type: 'object',
    properties: {
      channel: { type: 'string', label: 'Channel', default: 'general' },
      mode: { type: 'string', label: 'Mode', enum: ['all', 'failures'], default: 'all' },
      limit: { type: 'number', label: 'Limit', minimum: 1, maximum: 10, default: 5 },
      quiet: { type: 'boolean', label: 'Quiet', default: false },
      labels: { type: 'array', items: { type: 'string' }, label: 'Labels', default: ['bug'] },
      channels: { type: 'object', format: 'repository-map', additionalProperties: { type: 'string' }, label: 'Channels', default: { 'team/repo': 'dev' } },
    },
    required: ['channel'],
  },
  outboundHosts: ['api.acme.example.com'],
  contributes: {
    mcpServers: [
      { kind: 'https', name: 'acme', url: 'https://mcp.acme.example.com/mcp', tools: ['search'], capability: 'read', authentication: 'oauth', connection: 'workspace' },
      { kind: 'https', name: 'acme-public', url: 'https://mcp.acme.example.com/public', tools: [], capability: 'read', authentication: 'none' },
      { kind: 'package', name: 'acme-local', ecosystem: 'npm', package: '@acme/mcp', version: '2.0.1', integrity: INTEGRITY, tools: ['post'], capability: 'write',
        env: [{ name: 'ACME_REGION', value: 'eu' }], secretEnv: [{ name: 'ACME_TOKEN', connection: 'bot-token' }] },
    ],
    skills: [{ name: 'acme-style', path: 'skills/acme-style' }],
    automationTemplates: [{ id: 'acme-digest', path: 'templates/acme-digest' }],
    commands: [{ name: 'notify', description: 'Post a message', where: ['pull_request'], kind: 'prompt', prompt: 'Summarise the pull request for the team.', skills: ['acme-style'], servers: ['acme'], permissions: ['pull_requests.read'] }],
    subscriptions: [{ on: 'task.completed', handler: 'onTask' }],
    webhooks: [{ name: 'events', description: 'Acme event callbacks', handler: 'onAcmeEvent', verification: { scheme: 'hmac-sha256', header: 'X-Acme-Signature', prefix: 'sha256=', connection: 'events-secret' }, deliveryIdHeader: 'x-acme-delivery' }],
  },
});
type Mutable = Record<string, any>;
const variant = (change: (manifest: Mutable) => void) => { const manifest = structuredClone(valid()) as Mutable; change(manifest); return manifest; };
const errors = (value: unknown) => { const result = parsePluginManifest(value); return result.ok ? [] : result.errors; };
const rejects = (value: unknown, pattern: RegExp) => {
  const messages = errors(value);
  assert.ok(messages.some(m => pattern.test(m)), `expected ${pattern} in ${JSON.stringify(messages)}`);
};

test('a complete manifest parses, with defaults for omitted sections', () => {
  const result = parsePluginManifest(valid());
  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(result.manifest.connections[0].type === 'oauth' && result.manifest.connections[0].registrations, ['metadata_document', 'dynamic', 'preregistered']);
  const minimal = pluginManifestSchema.parse({ manifestVersion: 1, id: 'tiny', name: 'Tiny', description: 'Nothing.', version: '0.1.0', category: 'other', homepage: 'https://example.com', icon: 'icon.png' });
  assert.deepEqual(minimal.permissions, []);
  assert.deepEqual(minimal.contributes.mcpServers, []);
  assert.deepEqual(minimal.settings, { type: 'object', properties: {}, required: [] });
});

test('the example-pack manifest in the registry parses', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../plugins/example-pack/manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(errors(manifest), []);
});

test('bad ids, versions, categories and unknown fields are refused', () => {
  for (const id of ['Acme', 'acme_chat', '-acme', 'acme--chat', 'a'.repeat(49), 'src', 'dist', '']) rejects(variant(m => { m.id = id; }), /^id:/);
  rejects(variant(m => { m.version = '1.0'; }), /^version:/);
  rejects(variant(m => { m.manifestVersion = 2; }), /^manifestVersion:/);
  rejects(variant(m => { m.category = 'chat'; }), /^category:/);
  rejects(variant(m => { m.homepage = 'http://acme.example.com'; }), /^homepage:/);
  rejects(variant(m => { m.icon = '../icon.svg'; }), /^icon:/);
  rejects(variant(m => { m.icon = 'icon.exe'; }), /^icon:/);
  rejects(variant(m => { m.extra = true; }), /extra/);
});

test('permissions come from the closed list and are unique', () => {
  assert.ok(PLUGIN_PERMISSIONS.includes('tasks.create'));
  rejects(variant(m => { m.permissions.push('repositories.delete'); }), /^permissions\.2:/);
  rejects(variant(m => { m.permissions.push('events.read'); }), /Duplicate permission events\.read/);
  rejects(variant(m => { m.contributes.commands[0].permissions = ['issues.create']; }), /Command notify uses permissions the plugin does not request: issues\.create/);
  rejects(variant(m => { m.permissions = ['pull_requests.read']; }), /Event subscriptions need the events\.read permission/);
});

test('contributions must reference declared connections of the right type', () => {
  rejects(variant(m => { m.contributes.mcpServers[0].connection = 'missing'; }), /Server acme references connection missing, which the plugin does not declare/);
  rejects(variant(m => { delete m.contributes.mcpServers[0].connection; }), /Server acme needs a oauth connection/);
  rejects(variant(m => { m.contributes.mcpServers[0].connection = 'bot-token'; }), /which is token, not oauth/);
  rejects(variant(m => { m.contributes.mcpServers[0].authentication = 'bearer'; }), /which is oauth, not token/);
  rejects(variant(m => { m.contributes.mcpServers[1].connection = 'bot-token'; }), /no authentication and takes no connection/);
  rejects(variant(m => { m.contributes.webhooks[0].verification.connection = 'bot-token'; }), /Webhook events references connection bot-token, which is token, not signing_secret/);
  rejects(variant(m => { m.contributes.mcpServers[2].secretEnv[0].connection = 'nowhere'; }), /Variable ACME_TOKEN of server acme-local references connection nowhere/);
});

test('webhooks declare a handler and a built-in verification scheme', () => {
  const parsed = parsePluginManifest(valid());
  assert.ok(parsed.ok);
  const [webhook] = parsed.manifest.contributes.webhooks;
  assert.deepEqual(webhook.verification, { scheme: 'hmac-sha256', header: 'x-acme-signature', prefix: 'sha256=', encoding: 'hex', connection: 'events-secret' }, 'header names are lower-cased; hex is the default encoding');
  for (const verification of [{ scheme: 'slack-v0', connection: 'events-secret' }, { scheme: 'token-header', header: 'x-gitlab-token', connection: 'events-secret' }]) {
    assert.deepEqual(errors(variant(m => { m.contributes.webhooks[0].verification = verification; })), []);
  }
  rejects(variant(m => { m.contributes.webhooks[0].verification = { scheme: 'md5', header: 'x-sig', connection: 'events-secret' }; }), /scheme/);
  rejects(variant(m => { delete m.contributes.webhooks[0].handler; }), /handler/);
  rejects(variant(m => { delete m.contributes.webhooks[0].verification.header; }), /header/);
  rejects(variant(m => { m.contributes.webhooks[0].verification.header = 'x sig'; }), /HTTP header name/);
  rejects(variant(m => { m.contributes.webhooks[0].verification.header = 'Cookie'; }), /Webhook events cannot use header cookie/);
  rejects(variant(m => { m.contributes.webhooks[0].deliveryIdHeader = 'X-Acme-Signature'; }), /both for verification and as its delivery id/);
  rejects(variant(m => { m.contributes.webhooks[0].deliveryIdHeader = 'Authorization'; }), /Webhook events cannot use the credential header authorization as its delivery id/);
  rejects(variant(m => { m.contributes.webhooks[0].deliveryIdHeader = 'proxy-authorization'; }), /Webhook events cannot use the credential header proxy-authorization as its delivery id/);
  rejects(variant(m => { m.contributes.webhooks[0].verification = { scheme: 'token-header', header: 'x-hook-token', connection: 'events-secret' }; m.contributes.webhooks[0].deliveryIdHeader = 'authorization'; }), /credential header authorization/,
    'even when another header verifies the request');
  assert.deepEqual(errors(variant(m => { m.contributes.webhooks[0].verification = { scheme: 'token-header', header: 'Authorization', prefix: 'Bearer ', connection: 'events-secret' }; })), [], 'authorization still verifies a request');
  rejects(variant(m => { m.contributes.webhooks[0].respond = 'onAcmeEvent'; }), /respond function other than its handler/);
  rejects(variant(m => { m.contributes.webhooks[0].connection = 'events-secret'; }), /connection/);
});

test('secretEnv must map to a token connection', () => {
  rejects(variant(m => { m.contributes.mcpServers[2].secretEnv[0].connection = 'workspace'; }), /Variable ACME_TOKEN of server acme-local references connection workspace, which is oauth, not token/);
  rejects(variant(m => { m.contributes.mcpServers[2].secretEnv[0].connection = 'events-secret'; }), /which is signing_secret, not token/);
  rejects(variant(m => { m.contributes.mcpServers[2].secretEnv = ['ACME_TOKEN']; }), /secretEnv/);
  rejects(variant(m => { m.contributes.mcpServers[2].secretEnv.push({ name: 'ACME_REGION', connection: 'bot-token' }); }), /Variable ACME_REGION of server acme-local is listed more than once/);
});

test('duplicate names are refused in every section', () => {
  rejects(variant(m => { m.connections.push({ ...m.connections[1] }); }), /Duplicate connection name bot-token/);
  rejects(variant(m => { m.contributes.mcpServers[1].name = 'acme'; }), /Duplicate server name acme/);
  rejects(variant(m => { m.contributes.skills.push({ name: 'acme-style', path: 'skills/other' }); }), /Duplicate skill name acme-style/);
  rejects(variant(m => { m.contributes.automationTemplates.push({ id: 'acme-digest', path: 'x' }); }), /Duplicate automation template id acme-digest/);
  rejects(variant(m => { m.contributes.commands.push({ ...m.contributes.commands[0], description: 'Again' }); }), /Duplicate command name notify/);
  rejects(variant(m => { m.contributes.webhooks.push({ ...m.contributes.webhooks[0] }); }), /Duplicate webhook name events/);
  rejects(variant(m => { m.contributes.subscriptions.push({ on: 'task.completed', handler: 'onTask' }); }), /Duplicate subscription task\.completed → onTask/);
  rejects(variant(m => { m.outboundHosts.push('api.acme.example.com'); }), /Duplicate outbound host/);
});

test('outbound hosts must be hostnames', () => {
  for (const host of ['https://api.acme.example.com', 'api.acme.example.com:443', 'api.acme.example.com/path', '*.acme.example.com', '10.0.0.1', 'localhost', 'API.example.com', 'a..b.com', '-a.example.com']) {
    rejects(variant(m => { m.outboundHosts = [host]; }), /^outboundHosts\.0: Enter a hostname/);
  }
});

test('package servers need an exact version and a recorded integrity value', () => {
  const pkg = (change: (server: Mutable) => void) => variant(m => change(m.contributes.mcpServers[2]));
  for (const version of ['^2.0.0', '~2.0.1', '2.x', '>=2.0.0', '2.0.1 - 2.1.0', '*']) rejects(pkg(s => { s.version = version; }), /^contributes\.mcpServers\.2\.version: Enter an exact version/);
  for (const version of ['latest', 'next', 'beta']) rejects(pkg(s => { s.version = version; }), /^contributes\.mcpServers\.2\.version: Enter an exact version/);
  rejects(pkg(s => { delete s.integrity; }), /^contributes\.mcpServers\.2\.integrity: Record the integrity value/);
  rejects(pkg(s => { s.integrity = 'sha1-abc'; }), /^contributes\.mcpServers\.2\.integrity:/);
  for (const name of ['./server', '../mcp', '/opt/mcp', 'file:mcp.tgz', 'git+https://example.com/mcp.git', 'https://example.com/mcp.tgz']) rejects(pkg(s => { s.package = name; }), /^contributes\.mcpServers\.2\.package: Enter an npm package name/);
  rejects(pkg(s => { s.command = 'node server.js'; }), /command/);
  rejects(pkg(s => { s.path = '/opt/server'; }), /path/);
  rejects(pkg(s => { s.image = 'acme/mcp:latest'; }), /image/);
  rejects(pkg(s => { s.ecosystem = 'pypi'; }), /^contributes\.mcpServers\.2\.ecosystem:/);
  rejects(pkg(s => { s.env = [{ name: 'PATH', value: '/tmp' }]; }), /reserved/);
});

test('remote servers need an https endpoint', () => {
  rejects(variant(m => { m.contributes.mcpServers[0].url = 'http://mcp.acme.example.com/mcp'; }), /^contributes\.mcpServers\.0\.url: Enter an https:\/\/ URL/);
  rejects(variant(m => { m.contributes.mcpServers[0].kind = 'catalog'; }), /^contributes\.mcpServers\.0/);
});

test('settings follow the JSON Schema subset', () => {
  rejects(variant(m => { m.settings.required.push('missing'); }), /Required setting missing is not defined/);
  rejects(variant(m => { m.settings.properties.mode.default = 'some'; }), /Default of setting mode is not one of its enum values/);
  rejects(variant(m => { m.settings.properties.limit.default = 11; }), /Default of setting limit is outside its range/);
  rejects(variant(m => { m.settings.properties.limit.minimum = 20; }), /minimum above its maximum/);
  rejects(variant(m => { m.settings.properties.quiet.default = 'no'; }), /settings\.properties\.quiet\.default/);
  rejects(variant(m => { m.settings.properties.labels.items = { type: 'number' }; }), /settings\.properties\.labels\.items/);
  rejects(variant(m => { m.settings.properties.channels.default = { 'not a repo': 'x' }; }), /settings\.properties\.channels\.default/);
  rejects(variant(m => { m.settings.properties.when = { type: 'date', label: 'When' }; }), /settings\.properties\.when/);
});

test('the public projection leaves out package launch details', () => {
  const projection = publicPluginManifest(pluginManifestSchema.parse(valid()));
  assert.deepEqual(projection.permissions.map(p => p.name), ['events.read', 'pull_requests.read']);
  assert.ok(projection.permissions.every(p => p.description.length > 0));
  const local = projection.contributes.mcpServers.find(s => s.name === 'acme-local')!;
  assert.deepEqual(local, { kind: 'package', name: 'acme-local', ecosystem: 'npm', package: '@acme/mcp', version: '2.0.1', tools: ['post'], capability: 'write', secretEnv: [{ name: 'ACME_TOKEN', connection: 'bot-token' }] });
  assert.equal(JSON.stringify(projection).includes(INTEGRITY), false);
  assert.equal(JSON.stringify(projection).includes('ACME_REGION'), false);
  assert.deepEqual(projection.contributes.skills, ['acme-style']);
  assert.deepEqual(projection.contributes.commands, [{ name: 'notify', description: 'Post a message', where: ['pull_request'], kind: 'prompt', skills: ['acme-style'], servers: ['acme'], needsWrite: false, shared: false, specific: [] }]);
  assert.equal(JSON.stringify(projection).includes('Summarise the pull request'), false, 'the prompt text is not public');
});

test('commands are lower-case, never shadow a built-in command and add only their own read contributions', () => {
  const parsed = pluginManifestSchema.parse(valid());
  assert.equal(parsed.contributes.commands[0].needsWrite, false);
  for (const name of ['review', 'fix', 'merge', 'switch', 'use', 'ultrafix']) {
    rejects(variant(m => { m.contributes.commands[0].name = name; }), new RegExp(`contributes\\.commands\\.0\\.name: /${name} is a built-in ProPR command`));
  }
  rejects(variant(m => { m.contributes.commands[0].name = 'Deploy'; }), /contributes\.commands\.0\.name: Command names are lower-case/);
  rejects(variant(m => { m.contributes.commands[0].name = 'de_ploy'; }), /Command names are lower-case/);
  rejects(variant(m => { m.contributes.commands[0].where = []; }), /contributes\.commands\.0\.where/);
  rejects(variant(m => { m.contributes.commands[0].where = ['discussion']; }), /contributes\.commands\.0\.where\.0/);
  rejects(variant(m => { m.contributes.commands[0].where = ['issue', 'issue']; }), /Command notify lists issue more than once/);
  rejects(variant(m => { m.contributes.commands[0].kind = 'script'; }), /contributes\.commands\.0\.kind/);
  rejects(variant(m => { delete m.contributes.commands[0].prompt; }), /contributes\.commands\.0\.prompt/);
  rejects(variant(m => { m.contributes.commands[0].skills = ['other-skill']; }), /Command notify adds skill other-skill, which the plugin does not contribute/);
  rejects(variant(m => { m.contributes.commands[0].servers = ['elsewhere']; }), /Command notify adds server elsewhere, which the plugin does not contribute/);
  rejects(variant(m => { m.contributes.commands[0].servers = ['acme-local']; }), /Command notify adds the write server acme-local; set needsWrite/);
  assert.ok(parsePluginManifest(variant(m => { m.contributes.commands[0].servers = ['acme-local']; m.contributes.commands[0].needsWrite = true; })).ok);
});

test('subscriptions name a journal event, a handler and an optional equality filter', () => {
  const ok = variant(m => { m.contributes.subscriptions = [{ on: 'pull_request.merged', handler: 'onMerged', filter: { repository: 'Owner/Repo', 'payload.kind': ['implementation', 'review'] } }]; });
  const parsed = pluginManifestSchema.safeParse(ok);
  assert.ok(parsed.success, parsed.success ? '' : parsed.error.message);
  rejects(variant(m => { m.contributes.subscriptions = [{ on: 'pull_request.exploded', handler: 'onMerged' }]; }), /repository event name/);
  rejects(variant(m => { m.contributes.subscriptions = [{ on: 'task', handler: 'onTask' }]; }), /repository event name/);
  rejects(variant(m => { m.contributes.subscriptions = [{ on: 'task.completed', handler: 'not-an-identifier' }]; }), /exported handler/);
  rejects(variant(m => { m.contributes.subscriptions = [{ on: 'task.completed', handler: 'onTask', filter: { body: 'x' } }]; }), /Filter keys/);
  rejects(variant(m => { m.contributes.subscriptions = [{ on: 'task.completed', handler: 'onTask', filter: { 'payload.kind': { nested: true } } }]; }), /filter/);
  rejects(variant(m => { m.contributes.subscriptions = [{ event: 'task.completed' }]; }), /subscriptions/);
});

test('a handler command names an exported handler instead of a prompt and adds no skills or servers', () => {
  const handler = { name: 'status', description: 'Report the status', where: ['pull_request', 'issue'], kind: 'handler', handler: 'reportStatus' };
  const parsed = parsePluginManifest(variant(m => { m.contributes.commands.push(handler); }));
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.errors.join('; '));
  if (parsed.ok) assert.equal(parsed.manifest.contributes.commands[1].handler, 'reportStatus');
  rejects(variant(m => { m.contributes.commands.push({ ...handler, handler: undefined }); }), /Command status is a handler command and needs a handler/);
  rejects(variant(m => { m.contributes.commands.push({ ...handler, handler: 'not-an-identifier' }); }), /contributes\.commands\.1\.handler: Use the name of an exported handler function/);
  rejects(variant(m => { m.contributes.commands.push({ ...handler, prompt: 'Do it.' }); }), /Command status is a handler command; only prompt commands have a prompt/);
  rejects(variant(m => { m.contributes.commands.push({ ...handler, skills: ['acme-style'] }); }), /Command status is a handler command; it adds no skills or servers to a run/);
  rejects(variant(m => { m.contributes.commands.push({ ...handler, needsWrite: true }); }), /needsWrite applies to prompt commands/);
  rejects(variant(m => { m.contributes.commands[0].handler = 'notify'; }), /Command notify is a prompt command; only handler commands name a handler/);
});

test('a shared command names the specific commands of its plugin that perform the same operation', () => {
  const shared = { name: 'deploy', description: 'Deploy', where: ['pull_request'], kind: 'prompt', prompt: 'Deploy the branch.', shared: true, specific: ['acme-deploy'] };
  const specific = { name: 'acme-deploy', description: 'Deploy with Acme', where: ['pull_request', 'issue'], kind: 'prompt', prompt: 'Deploy the branch with Acme.' };
  const parsed = parsePluginManifest(variant(m => { m.contributes.commands.push(shared, specific); }));
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.errors.join('; '));
  if (!parsed.ok) return;
  // notify is a prompt command for pull requests too, but deploy does not name it: it is not an alternative.
  assert.deepEqual(pluginSharedCommandSiblings(parsed.manifest.contributes.commands, parsed.manifest.contributes.commands[1]).map(c => c.name), ['acme-deploy']);
  const deploy = publicPluginManifest(parsed.manifest).contributes.commands.find(c => c.name === 'deploy')!;
  assert.equal(deploy.shared, true);
  assert.deepEqual(deploy.specific, ['acme-deploy']);
  assert.deepEqual(publicPluginManifest(parsed.manifest).contributes.commands.find(c => c.name === 'acme-deploy')!.specific, []);
  // Naming no specific command, or one that is missing, shared, of another kind or not covering every target: refused.
  rejects(variant(m => { m.contributes.commands = [shared]; }), /Shared command deploy names specific command acme-deploy, which the plugin does not contribute/);
  rejects(variant(m => { m.contributes.commands = [{ ...shared, specific: [] }, specific]; }), /Shared command deploy needs a specific command of this plugin, named in specific/);
  rejects(variant(m => { m.contributes.commands = [{ ...shared, where: ['pull_request', 'issue'] }, { ...specific, where: ['pull_request'] }]; }), /names specific command acme-deploy, which is not usable wherever \/deploy is/);
  rejects(variant(m => { m.contributes.commands = [shared, { ...specific, kind: 'handler', prompt: undefined, handler: 'deploy' }]; }), /names specific command acme-deploy, which is not of kind prompt/);
  rejects(variant(m => { m.contributes.commands = [shared, { ...specific, shared: true, specific: ['deploy'] }]; }), /names specific command acme-deploy, which is shared itself/);
  rejects(variant(m => { m.contributes.commands = [{ ...shared, specific: ['acme-deploy', 'acme-deploy'] }, specific]; }), /lists specific command acme-deploy more than once/);
  rejects(variant(m => { m.contributes.commands = [shared, { ...specific, specific: ['deploy'] }]; }), /Command acme-deploy is not shared; only a shared command names specific commands/);
});

test('an unrelated command of the same kind cannot stand in for a shared handler command', () => {
  const deploy = { name: 'deploy', description: 'Deploy', where: ['pull_request'], kind: 'handler', handler: 'deploy', shared: true };
  const status = { name: 'status', description: 'Report the status', where: ['pull_request'], kind: 'handler', handler: 'reportStatus' };
  // Same kind and targets, but deploy does not name it: refused, so a plugin cannot ship /deploy without a specific deployment command.
  rejects(variant(m => { m.contributes.commands = [deploy, status]; }), /Shared command deploy needs a specific command of this plugin/);
  // Naming it anyway is refused too: it calls another handler, so it is not the same operation.
  rejects(variant(m => { m.contributes.commands = [{ ...deploy, specific: ['status'] }, status]; }), /names specific command status, which calls a different handler than deploy/);
  const parsed = parsePluginManifest(variant(m => { m.contributes.commands = [{ ...deploy, specific: ['acme-deploy'] }, status, { ...deploy, name: 'acme-deploy', shared: false }]; }));
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.errors.join('; '));
  if (parsed.ok) assert.deepEqual(pluginSharedCommandSiblings(parsed.manifest.contributes.commands, parsed.manifest.contributes.commands[0]).map(c => c.name), ['acme-deploy']);
});

test('URL settings and multiple-choice lists: format https-url and items.enum', () => {
  const withUrl = (change: (manifest: Mutable) => void = () => undefined) => variant(m => {
    m.settings.properties.hook = { type: 'string', format: 'https-url', label: 'Hook URL' };
    m.settings.properties.events = { type: 'array', items: { type: 'string', enum: ['task.completed', 'task.failed'] }, label: 'Events', default: ['task.completed'] };
    m.outboundHostsFromSettings = ['hook'];
    change(m);
  });
  const parsed = parsePluginManifest(withUrl());
  assert.ok(parsed.ok, JSON.stringify(parsed));
  assert.deepEqual(publicPluginManifest(parsed.manifest).outboundHostsFromSettings, ['hook']);
  assert.deepEqual(pluginManifestSchema.parse(valid()).outboundHostsFromSettings, [], 'none by default');

  rejects(withUrl(m => { m.outboundHostsFromSettings = ['missing']; }), /^outboundHostsFromSettings\.0: outboundHostsFromSettings names setting missing, which the plugin does not define$/);
  rejects(withUrl(m => { m.outboundHostsFromSettings = ['channel']; }), /names setting channel, which is not a string setting with format https-url/);
  rejects(withUrl(m => { m.outboundHostsFromSettings = ['hook', 'hook']; }), /Setting hook is listed more than once/);
  rejects(withUrl(m => { m.settings.properties.hook.default = 'http://hooks.example.com'; }), /Default of setting hook must be an https:\/\/ URL, not http/);
  rejects(withUrl(m => { m.settings.properties.hook.enum = ['https://a.example.com']; }), /Setting hook has a format and an enum; use one/);
  rejects(withUrl(m => { m.settings.properties.hook.format = 'url'; }), /settings\.properties\.hook\.format/);
  rejects(withUrl(m => { m.settings.properties.events.default = ['task.queued']; }), /Default of setting events has an entry that is not one of its enum values/);
  rejects(withUrl(m => { m.settings.properties.events.items.enum = ['a', 'a']; }), /Setting events lists an enum value more than once/);

  const { settings } = parsed.ok ? parsed.manifest : (null as never);
  assert.deepEqual(validatePluginSettings(settings, { hook: 'https://Hooks.Example.com/in?x=1', events: ['task.failed'] }), { ok: true, settings: { hook: 'https://Hooks.Example.com/in?x=1', events: ['task.failed'] } });
  for (const [hook, message] of [
    ['http://hooks.example.com/in', 'hook must be an https:// URL, not http'],
    ['https://192.168.1.10/in', 'hook must name a public host such as hooks.example.com, not an IP address'],
    ['https://[fd00::1]/in', 'hook must name a public host such as hooks.example.com, not an IP address'],
    ['https://intranet/in', 'hook must name a public host such as hooks.example.com, not intranet'],
    ['https://box.home.arpa/in', 'hook must name a public host, not the local name box.home.arpa'],
    ['https://hooks.example.com/in#x', 'hook must not have a #fragment'],
  ]) assert.deepEqual(validatePluginSettings(settings, { hook }), { ok: false, errors: [message] }, hook);
  assert.deepEqual(validatePluginSettings(settings, { events: ['task.queued'] }), { ok: false, errors: ['events has task.queued, which is not one of task.completed, task.failed'] });

  assert.equal(pluginHttpsUrlHost('https://Hooks.Example.com:443/x'), 'hooks.example.com');
  assert.equal(pluginHttpsUrlHost('http://hooks.example.com/x'), null);
  assert.deepEqual(pluginOutboundHosts(parsed.manifest, { hook: 'https://Hooks.Example.com/in' }), ['api.acme.example.com', 'hooks.example.com']);
  assert.deepEqual(pluginOutboundHosts(parsed.manifest, { hook: 'http://plain.example.com/in' }), ['api.acme.example.com'], 'an unacceptable URL gives no host');
  assert.deepEqual(pluginOutboundHosts(parsed.manifest, { channel: 'https://not.named.example.com' }), ['api.acme.example.com'], 'only the named settings count');
});

test('a token connection may be a secret URL on declared host patterns; it is never a token for servers', () => {
  const webhook = { type: 'token' as const, name: 'webhook', label: 'Webhook URL', help: 'Paste the webhook URL.', helpUrl: 'https://acme.example.com/hooks', secretUrl: { hosts: ['hooks.acme.example', '*.region.acme.example'], pathPrefixes: ['/services/'] } };
  const parsed = parsePluginManifest(variant(m => { m.connections.push(webhook); }));
  assert.ok(parsed.ok, JSON.stringify(parsed));
  rejects(variant(m => { m.connections.push({ ...webhook, secretUrl: { hosts: ['https://hooks.acme.example'] } }); }), /Enter a hostname such as hooks\.example\.com, or \*\.example\.com/);
  rejects(variant(m => { m.connections.push({ ...webhook, secretUrl: { hosts: ['*'] } }); }), /Enter a hostname/);
  rejects(variant(m => { m.connections.push({ ...webhook, secretUrl: { hosts: [] } }); }), /secretUrl/);
  rejects(variant(m => { m.connections.push({ ...webhook, type: 'signing_secret' } as never); }), /secretUrl/);
  rejects(variant(m => { m.connections.push(webhook); m.contributes.mcpServers[2].secretEnv[0].connection = 'webhook'; }), /Variable ACME_TOKEN of server acme-local references connection webhook, whose value is a secret URL, not a token/);

  const { secretUrl } = webhook;
  assert.equal(pluginSecretUrlProblem(secretUrl, 'https://hooks.acme.example/services/T/B/x'), null);
  assert.equal(pluginSecretUrlProblem(secretUrl, 'https://eu.region.acme.example:443/services/x?sig=1'), null);
  assert.equal(pluginSecretUrlProblem(secretUrl, 'https://region.acme.example/services/x'), 'The URL must be on one of hooks.acme.example, *.region.acme.example, not region.acme.example');
  assert.equal(pluginSecretUrlProblem(secretUrl, 'https://evilregion.acme.example/services/x'), 'The URL must be on one of hooks.acme.example, *.region.acme.example, not evilregion.acme.example');
  assert.equal(pluginSecretUrlProblem(secretUrl, 'https://hooks.acme.example/other/x'), 'The URL\'s path must start with /services/');
  assert.equal(pluginSecretUrlProblem(secretUrl, 'http://hooks.acme.example/services/x'), 'The URL must be an https:// URL');
  assert.equal(pluginSecretUrlProblem(secretUrl, 'https://user:pw@hooks.acme.example/services/x'), 'The URL must not carry a user name or password');
  assert.equal(pluginSecretUrlProblem(secretUrl, 'not a url'), 'The URL must be an https:// URL');
  assert.equal(pluginSecretUrlHostAllowed(['*.acme.example'], 'a.b.acme.example'), true);
  assert.equal(pluginSecretUrlHostAllowed(['*.acme.example'], 'acme.example'), false);
});

test('optionsFrom: a string or repository map setting names the handler that loads its choices, and never also an enum or a format', () => {
  const withSettings = (properties: Record<string, unknown>) => {
    const manifest = valid() as unknown as Record<string, unknown>;
    return parsePluginManifest({ ...manifest, settings: { type: 'object', properties, required: [] } });
  };
  const ok = withSettings({
    team: { type: 'string', label: 'Team', optionsFrom: 'teamOptions' },
    teams: { type: 'object', format: 'repository-map', additionalProperties: { type: 'string' }, label: 'Teams', optionsFrom: 'teamOptions' },
  });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.deepEqual(withSettings({ team: { type: 'string', label: 'Team', optionsFrom: 'teamOptions', enum: ['a'] } }), { ok: false, errors: ['settings.properties.team.optionsFrom: Setting team has optionsFrom and an enum; use one'] });
  assert.deepEqual(withSettings({ site: { type: 'string', label: 'Site', optionsFrom: 'sites', format: 'https-url' } }), { ok: false, errors: ['settings.properties.site.optionsFrom: Setting site has optionsFrom and a format; use one'] });
  assert.equal(withSettings({ team: { type: 'string', label: 'Team', optionsFrom: 'not a handler' } }).ok, false);
  assert.equal(withSettings({ on: { type: 'boolean', label: 'On', optionsFrom: 'x' } }).ok, false, 'only string and repository map settings load choices');
  // Saved values are plain strings, validated like any other.
  assert.deepEqual(validatePluginSettings({ type: 'object', properties: { team: { type: 'string', label: 'Team', optionsFrom: 'teamOptions' } }, required: [] }, { team: 'ENG' }), { ok: true, settings: { team: 'ENG' } });
});

test('a token connection may send its token raw or as Basic credentials, but a secret URL takes no authorization', () => {
  const manifest = valid();
  const connections = (extra: Record<string, unknown>) => parsePluginManifest({ ...manifest, connections: [...manifest.connections!, { type: 'token', name: 'api-key', label: 'API key', help: 'Paste it.', helpUrl: 'https://acme.example.com/keys', ...extra }] });
  assert.equal(connections({ authorization: 'raw' }).ok, true);
  assert.equal(connections({ authorization: 'basic' }).ok, true);
  assert.equal(connections({ authorization: 'digest' }).ok, false);
  assert.deepEqual(connections({ authorization: 'raw', secretUrl: { hosts: ['hooks.acme.example.com'] } }), { ok: false, errors: ['connections.3.authorization: Connection api-key is a secret URL; it sends no Authorization header, so it takes no authorization'] });
});

test('an https-url setting may limit its hosts: checked when saved, and a URL off them adds no outbound host', () => {
  const manifest = valid();
  const withSite = (setting: Record<string, unknown>) => parsePluginManifest({ ...manifest, settings: { type: 'object', properties: { site: { type: 'string', label: 'Site', ...setting } }, required: [] }, outboundHostsFromSettings: ['site'] });
  const parsed = withSite({ format: 'https-url', hosts: ['*.atlassian.net', 'jira.acme.example.com'] });
  assert.ok(parsed.ok);
  const site = parsed.manifest.settings.properties.site;
  assert.equal(pluginSettingProblem('site', site, 'https://acme.atlassian.net'), null);
  assert.equal(pluginSettingProblem('site', site, 'https://jira.acme.example.com/x'), null);
  assert.equal(pluginSettingProblem('site', site, 'https://atlassian.net'), 'site must be on one of *.atlassian.net, jira.acme.example.com, not atlassian.net');
  assert.equal(pluginSettingProblem('site', site, 'https://x.acme.example.com'), 'site must be on one of *.atlassian.net, jira.acme.example.com, not x.acme.example.com');
  assert.equal(pluginSettingProblem('site', site, ''), null, 'empty is unset');
  assert.deepEqual(pluginOutboundHosts(parsed.manifest, { site: 'https://evil.example.com' }), [...parsed.manifest.outboundHosts]);
  assert.deepEqual(pluginOutboundHosts(parsed.manifest, { site: 'https://acme.atlassian.net' }), [...parsed.manifest.outboundHosts, 'acme.atlassian.net']);
  const plain = withSite({ hosts: ['*.atlassian.net'] });
  assert.ok(!plain.ok && plain.errors.includes('settings.properties.site.hosts: Setting site lists hosts but is not an https-url setting'));
  assert.equal(withSite({ format: 'https-url', hosts: ['*.atlassian.net'], default: 'https://jira.example.com' }).ok, false, 'a default off the hosts');
  assert.equal(withSite({ format: 'https-url', hosts: ['https://bad'] }).ok, false);
});

test('parsePluginSettingOptions keeps well-formed choices, each value once, within the limits', () => {
  assert.deepEqual(parsePluginSettingOptions({ options: [{ value: 'a', label: ' A ' }, { value: 'a', label: 'again' }, { value: 'b', label: 'B' }] }), [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]);
  assert.equal(parsePluginSettingOptions({ options: [{ value: '', label: 'empty' }] }), null);
  assert.equal(parsePluginSettingOptions({ options: [{ value: 'a' }] }), null);
  assert.equal(parsePluginSettingOptions([]), null);
  assert.equal(parsePluginSettingOptions({ options: Array.from({ length: 300 }, (_, i) => ({ value: `v${i}`, label: `L${i}` })) })!.length, PLUGIN_SETTING_OPTIONS_LIMITS.options);
});
