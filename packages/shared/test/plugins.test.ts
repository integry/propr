import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  PLUGIN_PERMISSIONS, parsePluginManifest, pluginManifestSchema, publicPluginManifest,
  type PluginManifestInput,
} from '../src/plugins.js';

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
    commands: [{ name: 'notify', description: 'Post a message', permissions: ['pull_requests.read'] }],
    subscriptions: [{ event: 'task.completed' }],
    webhooks: [{ name: 'events', description: 'Acme event callbacks', connection: 'events-secret' }],
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
  rejects(variant(m => { m.contributes.webhooks[0].connection = 'bot-token'; }), /Webhook events references connection bot-token, which is token, not signing_secret/);
  rejects(variant(m => { m.contributes.mcpServers[2].secretEnv[0].connection = 'nowhere'; }), /Variable ACME_TOKEN of server acme-local references connection nowhere/);
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
  rejects(variant(m => { m.contributes.commands.push({ name: 'notify', description: 'Again' }); }), /Duplicate command name notify/);
  rejects(variant(m => { m.contributes.webhooks.push({ ...m.contributes.webhooks[0] }); }), /Duplicate webhook name events/);
  rejects(variant(m => { m.contributes.subscriptions.push({ event: 'task.completed' }); }), /Duplicate subscription task\.completed/);
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
  assert.deepEqual(projection.contributes.commands, [{ name: 'notify', description: 'Post a message' }]);
});
