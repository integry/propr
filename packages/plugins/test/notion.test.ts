import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { PLUGINS_ROOT, getOfficialPlugin } from '../src/index.js';

/**
 * The Notion plugin is a context integration only: a read-only MCP server and
 * a skill. Its tool allow-list is checked against Notion's documented tool
 * list, captured in `notion/fixtures/tools.json` with each tool's access.
 */

interface DocumentedTool { name: string; access: 'read' | 'write'; source: string }
const DOCUMENTED = JSON.parse(readFileSync(path.join(PLUGINS_ROOT, 'notion', 'fixtures', 'tools.json'), 'utf8')) as { capturedAt: string; index: string; tools: DocumentedTool[] };
const plugin = () => getOfficialPlugin('notion', { includeDevelopment: false })!;

test('the Notion plugin contributes one read-only OAuth server and one skill, and nothing that runs code', () => {
  const { manifest, assets } = plugin();
  assert.equal(manifest.category, 'context');
  assert.equal(assets.handlers, null, 'no handlers module');
  assert.deepEqual(manifest.permissions, []);
  assert.deepEqual(Object.keys(manifest.settings.properties), [], 'no settings beyond the connection');
  assert.deepEqual(manifest.outboundHosts, []);
  assert.deepEqual(manifest.connections.map(c => [c.type, c.name]), [['oauth', 'notion-account']]);
  const { mcpServers, skills, commands, subscriptions, webhooks, automationTemplates } = manifest.contributes;
  assert.deepEqual([commands, subscriptions, webhooks, automationTemplates], [[], [], [], []]);
  assert.equal(mcpServers.length, 1);
  const [server] = mcpServers;
  assert.deepEqual(server.kind === 'https' ? [server.name, server.url, server.capability, server.authentication, server.connection] : null,
    ['notion', 'https://mcp.notion.com/mcp', 'read', 'oauth', 'notion-account']);
  assert.deepEqual(skills.map(s => s.name), ['notion-context']);
});

test('the tool allow-list names documented read tools only, and no write tool', () => {
  const [server] = plugin().manifest.contributes.mcpServers;
  const documented = new Map(DOCUMENTED.tools.map(t => [t.name, t]));
  assert.equal(documented.size, DOCUMENTED.tools.length, 'each documented tool is listed once');
  assert.ok(DOCUMENTED.tools.every(t => t.source.startsWith('https://developers.notion.com/')), 'every entry cites Notion\'s documentation');
  const writes = DOCUMENTED.tools.filter(t => t.access === 'write').map(t => t.name);
  assert.ok(writes.length > 0 && writes.includes('notion-update-page') && writes.includes('notion-create-comment'), 'the fixture records the write tools');
  assert.ok(server.tools.length > 0, 'an explicit allow-list, never "all tools"');
  for (const tool of server.tools) {
    assert.ok(documented.has(tool), `${tool} is a documented Notion MCP tool`);
    assert.equal(documented.get(tool)!.access, 'read', `${tool} is a read tool`);
  }
  assert.deepEqual(server.tools.filter(tool => writes.includes(tool)), []);
  // What the agent needs to open a linked specification.
  for (const tool of ['notion-fetch', 'notion-search']) assert.ok(server.tools.includes(tool), tool);
  // Read tools that reach personal data or other apps are left out too.
  for (const tool of ['notion-connector-search', 'notion-list-private-pages', 'notion-list-recent-pages', 'notion-memory-search', 'notion-calendar-list-events', 'notion-get-users']) {
    assert.ok(!server.tools.includes(tool), `${tool} is not offered`);
  }
});

test('the skill opens the linked page first, quotes what it uses, never writes back and treats content as reference', () => {
  const { assets } = plugin();
  const skill = readFileSync(path.join(assets.skills.find(s => s.name === 'notion-context')!.path, 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: notion-context\ndescription: \S/);
  assert.match(skill, /Open the linked page first/);
  assert.match(skill, /`notion-fetch`/);
  assert.match(skill, /Quote what you use/);
  assert.match(skill, /Never write back/);
  assert.match(skill, /reference material/);
  // Every tool the skill names is on the allow-list.
  const [server] = plugin().manifest.contributes.mcpServers;
  for (const [, tool] of skill.matchAll(/`(notion-[a-z-]+)`/g)) assert.ok(server.tools.includes(tool), `${tool} named by the skill is allowed`);
});
