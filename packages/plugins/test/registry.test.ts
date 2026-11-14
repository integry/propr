import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  PLUGIN_DEVELOPMENT_FLAG, PLUGINS_ROOT, getOfficialPlugin, officialPlugins, pluginDevelopmentEnabled, readPluginRegistryIndex,
} from '../src/index.js';

const scratch = await mkdtemp(path.join(tmpdir(), 'propr-plugins-registry-'));
after(() => rm(scratch, { recursive: true, force: true }));

test('the registry root is the package folder', () => {
  assert.equal(PLUGINS_ROOT, path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
  assert.deepEqual(readPluginRegistryIndex(), [{ id: 'example-pack', development: true }]);
});

test('example-pack is exported only when the development flag is set', () => {
  assert.deepEqual(officialPlugins({ includeDevelopment: false }).map(p => p.manifest.id), []);
  assert.equal(getOfficialPlugin('example-pack', { includeDevelopment: false }), undefined);
  const example = getOfficialPlugin('example-pack', { includeDevelopment: true });
  assert.ok(example);
  assert.equal(example.development, true);
  assert.equal(example.manifest.name, 'Example pack');
});

test('the development flag is read from the environment', () => {
  assert.equal(pluginDevelopmentEnabled({}), false);
  assert.equal(pluginDevelopmentEnabled({ [PLUGIN_DEVELOPMENT_FLAG]: '0' }), false);
  assert.equal(pluginDevelopmentEnabled({ [PLUGIN_DEVELOPMENT_FLAG]: '1' }), true);
  assert.equal(pluginDevelopmentEnabled({ [PLUGIN_DEVELOPMENT_FLAG]: 'TRUE' }), true);
  const previous = process.env[PLUGIN_DEVELOPMENT_FLAG];
  try {
    process.env[PLUGIN_DEVELOPMENT_FLAG] = '1';
    assert.deepEqual(officialPlugins().map(p => p.manifest.id), ['example-pack']);
    delete process.env[PLUGIN_DEVELOPMENT_FLAG];
    assert.deepEqual(officialPlugins(), []);
  } finally {
    if (previous === undefined) delete process.env[PLUGIN_DEVELOPMENT_FLAG];
    else process.env[PLUGIN_DEVELOPMENT_FLAG] = previous;
  }
});

test('example-pack assets resolve to files in its folder', () => {
  const { assets, directory, manifest } = getOfficialPlugin('example-pack', { includeDevelopment: true })!;
  assert.equal(directory, path.join(PLUGINS_ROOT, 'example-pack'));
  for (const file of [assets.manifest, assets.readme, assets.icon]) assert.ok(existsSync(file), file);
  assert.deepEqual(assets.skills.map(s => s.name), ['example-notes']);
  assert.ok(existsSync(path.join(assets.skills[0].path, 'SKILL.md')));
  assert.ok(existsSync(path.join(assets.automationTemplates[0].path, 'template.json')));
  const kinds = manifest.contributes.mcpServers.map(s => s.kind).sort();
  assert.deepEqual(kinds, ['https', 'package']);
  const local = manifest.contributes.mcpServers.find(s => s.kind === 'package');
  assert.equal(local?.kind === 'package' && `${local.package}@${local.version}`, 'propr-fixture-mcp@1.0.0');
});

test('released plugins are listed in registry order and an invalid manifest throws', async () => {
  const root = path.join(scratch, 'root');
  await cp(path.join(PLUGINS_ROOT, 'example-pack'), path.join(root, 'example-pack'), { recursive: true });
  await writeFile(path.join(root, 'registry.json'), JSON.stringify({ version: 1, plugins: [{ id: 'example-pack' }] }));
  assert.deepEqual(officialPlugins({ root, includeDevelopment: false }).map(p => p.manifest.id), ['example-pack']);

  const broken = path.join(scratch, 'broken');
  await cp(root, broken, { recursive: true });
  await writeFile(path.join(broken, 'example-pack', 'manifest.json'), JSON.stringify({ manifestVersion: 1, id: 'example-pack' }));
  assert.throws(() => officialPlugins({ root: broken }), /example-pack\/manifest\.json: name:/);
});
