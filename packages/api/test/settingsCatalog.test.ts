import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { closeConnection } from '@propr/core';
import type { McpPrincipal } from '../mcp/policy.js';
import { loadDocsIndex } from '../mcp/docsIndex.js';
import { SETTINGS_CATALOG } from '../mcp/settingsCatalog.js';
import { createToolCatalog, type McpTool, type ToolDeps } from '../mcp/tools.js';
import { renderSettingsLocations } from '../../../scripts/generate-settings-docs.mjs';

after(() => closeConnection());

const deps = {
  db: {} as never,
  taskQueue: {} as never,
  redisClient: {} as never,
  runtimeBuildQueue: {} as never,
  policy: {
    config: { instanceId: 'settings-catalog-test', origin: 'https://instance.example' },
    requireScope: () => undefined,
    requirePermission: () => undefined,
  },
} as unknown as ToolDeps;

const catalog = createToolCatalog(deps);
const principal = {
  user: { id: 'catalog-user', username: 'catalog-user' }, scopes: ['read'],
  authorization: { role: 'member', source: 'local', permissions: [] },
  grant: { id: 'catalog-grant', repositories: [] },
} as unknown as McpPrincipal;

function namedTool(name: string): McpTool {
  const found = catalog.find(tool => tool.name === name);
  assert.ok(found, `${name} is registered`);
  return found;
}

async function findSetting(query: string) {
  const tool = namedTool('find_setting');
  const result = await tool.run({ principal, args: tool.schema.parse({ query }) });
  assert.equal(result.status, 200);
  return result.data as { matches: Array<Record<string, any>> }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

test('settings catalog MCP references and configuration-tool coverage do not drift', () => {
  const toolNames = new Set(catalog.map(tool => tool.name));
  for (const entry of SETTINGS_CATALOG) {
    for (const name of [entry.mcp?.read, entry.mcp?.write].filter(Boolean)) {
      assert.ok(toolNames.has(name!), `${entry.id} references missing tool ${name}`);
    }
  }

  const configurationTool = /^(get|update)_.*(settings|configuration|keywords|labels|label|tag|policy|agent)$/;
  for (const tool of catalog.filter(candidate => configurationTool.test(candidate.name))) {
    assert.ok(
      SETTINGS_CATALOG.some(entry => entry.mcp?.read === tool.name || entry.mcp?.write === tool.name),
      `${tool.name} must appear in SETTINGS_CATALOG`,
    );
  }
});

test('settings catalog documentation paths exist in the bundled docs index', async () => {
  const index = await loadDocsIndex();
  for (const path of new Set(SETTINGS_CATALOG.map(entry => entry.docs).filter(Boolean))) {
    assert.ok(index.byPath.has(path!), `${path} must exist in the docs index`);
  }
});

test('generated settings locations page is current', async () => {
  const committed = await readFile(new URL('../../../docs/docs/operations/settings-locations.md', import.meta.url), 'utf8');
  assert.equal(committed, renderSettingsLocations());
});

test('workflow catalog commands use the CLI additional-config keys', () => {
  const commands = Object.fromEntries(SETTINGS_CATALOG
    .filter(entry => entry.id.startsWith('workflow.'))
    .map(entry => [entry.id, entry.cli]));
  assert.equal(commands['workflow.pr_label'], 'propr setting update pr-label <label>');
  assert.equal(commands['workflow.ai_primary_tag'], 'propr setting update ai-primary-tag <tag>');
  assert.equal(commands['workflow.primary_processing_labels'], 'propr setting update primary-processing-labels <csv>');
  assert.equal(commands['workflow.followup_keywords'], 'propr setting update followup-keywords <csv>');
});

test('find_setting ranks aliases and environment names and explains access', async () => {
  const bots = await findSetting('bot whitelist');
  assert.equal(bots.matches[0].id, 'trigger.bot_allowlist');
  assert.equal(bots.matches[0].mcp.write, 'update_trigger_access_configuration');
  assert.equal(bots.matches[0].ui, 'Settings → Automation → Access');
  assert.match(bots.matches[0].howToChange, /requires instance\.manage_settings/);

  const timeout = await findSetting('CODEX_TIMEOUT_MS');
  assert.equal(timeout.matches[0].id, 'agents.timeouts');
  assert.equal(timeout.matches[0].mcpStatus, 'environment_only');
  assert.equal(timeout.matches[0].restartRequired, true);
  assert.equal(timeout.matches[0].docs, 'operations/configuration-reference');
  assert.equal(timeout.matches[0].howToChange, 'Change CODEX_TIMEOUT_MS in the deployment environment and restart ProPR.');
  assert.doesNotMatch(timeout.matches[0].howToChange, /CLAUDE_TIMEOUT_MS|ANTIGRAVITY_TIMEOUT_MS|OPENCODE_TIMEOUT_MS|VIBE_TIMEOUT_MS/);

  const timeoutGroup = await findSetting('agent task timeouts');
  assert.equal(timeoutGroup.matches[0].id, 'agents.timeouts');
  assert.equal(
    timeoutGroup.matches[0].howToChange,
    'Configure the applicable deployment environment variables separately: CLAUDE_TIMEOUT_MS, CODEX_TIMEOUT_MS, ANTIGRAVITY_TIMEOUT_MS, OPENCODE_TIMEOUT_MS, VIBE_TIMEOUT_MS; then restart ProPR.',
  );
  assert.doesNotMatch(timeoutGroup.matches[0].howToChange, / or /);

  const redisPort = await findSetting('REDIS_PORT');
  assert.equal(redisPort.matches[0].id, 'queue.redis');
  assert.equal(redisPort.matches[0].howToChange, 'Change REDIS_PORT in the deployment environment and restart ProPR.');
  assert.doesNotMatch(redisPort.matches[0].howToChange, /REDIS_HOST/);

  const redisGroup = await findSetting('Redis queue connection');
  assert.equal(redisGroup.matches[0].id, 'queue.redis');
  assert.equal(
    redisGroup.matches[0].howToChange,
    'Configure the applicable deployment environment variables separately: REDIS_HOST, REDIS_PORT; then restart ProPR.',
  );

  const preview = await findSetting('visual preview token');
  assert.equal(preview.matches[0].id, 'credentials.visual_preview_token');
  assert.equal(preview.matches[0].mcpStatus, 'browser_only');
  assert.match(preview.matches[0].howToChange, /credential entry/);
  assert.match(preview.matches[0].howToChange, /Settings → Integrations → Visual previews/);

  const directAgent = await findSetting('direct agents');
  assert.equal(directAgent.matches[0].id, 'agents.configuration');
  assert.equal(directAgent.matches[0].mcp.write, 'update_agent_configuration');

  const syntheticAgent = await findSetting('synthetic agents');
  assert.equal(syntheticAgent.matches[0].id, 'agents.synthetic_configuration');
  assert.equal(syntheticAgent.matches[0].mcp.write, 'update_synthetic_agent');
  assert.match(syntheticAgent.matches[0].howToChange, /with update_synthetic_agent/);

  const followupKeywords = await findSetting('follow-up keywords');
  assert.equal(followupKeywords.matches[0].id, 'workflow.followup_keywords');
  assert.match(followupKeywords.matches[0].howToChange, /`propr setting update followup-keywords <csv>`/);
});
