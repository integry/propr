import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { checkPackageIntegrity, checkPlugins, parseArguments } from '../scripts/check-plugins.mjs';

const run = promisify(execFile);
const FIXTURES = fileURLToPath(new URL('./fixtures/plugins-check/', import.meta.url));
const SCRIPT = fileURLToPath(new URL('../scripts/check-plugins.mjs', import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), 'propr-plugins-check-'));
after(() => rm(scratch, { recursive: true, force: true }));

let counter = 0;
/** A fresh copy of the valid fixture registry, optionally changed. */
async function fixtureRoot(change = async () => {}) {
  const root = join(scratch, `root-${++counter}`);
  await cp(join(FIXTURES, 'valid'), root, { recursive: true });
  await change(root, join(root, 'fixture-pack'));
  return root;
}
const manifestPath = plugin => join(plugin, 'manifest.json');
const editManifest = async (plugin, edit) => {
  const manifest = JSON.parse(await readFile(manifestPath(plugin), 'utf8'));
  edit(manifest);
  await writeFile(manifestPath(plugin), JSON.stringify(manifest));
};
const expectError = (root, pattern) => {
  const { errors } = checkPlugins({ root });
  assert.ok(errors.some(error => pattern.test(error)), `expected ${pattern} in ${JSON.stringify(errors)}`);
};

test('the official registry passes', () => {
  const { errors, plugins } = checkPlugins();
  assert.deepEqual(errors, []);
  assert.ok(plugins.some(plugin => plugin.id === 'example-pack' && plugin.development));
});

test('the valid fixture registry passes', async () => {
  assert.deepEqual(checkPlugins({ root: await fixtureRoot() }).errors, []);
});

const MANIFEST_CASES = {
  'bad-id': /fixture-pack\/manifest\.json: id: Plugin ids are lowercase slugs/,
  'unknown-permission': /fixture-pack\/manifest\.json: permissions\.1: /,
  'missing-connection': /Server remote references connection nowhere, which the plugin does not declare/,
  'duplicate-server-name': /Duplicate server name remote/,
  'host-not-hostname': /outboundHosts\.0: Enter a hostname such as api\.example\.com/,
  'package-range': /contributes\.mcpServers\.1\.version: Enter an exact version such as 1\.2\.3; ranges and tags are not accepted/,
  'package-tag': /contributes\.mcpServers\.1\.version: Enter an exact version/,
  'package-missing-integrity': /contributes\.mcpServers\.1\.integrity: Record the integrity value/,
  'package-path': /contributes\.mcpServers\.1\.package: Enter an npm package name/,
  'package-command': /contributes\.mcpServers\.1: .*command/,
  'secret-env-not-token': /Variable FIXTURE_TOKEN of server local references connection account, which is oauth, not token/,
};

test('every broken fixture manifest has an expected message', async () => {
  const files = (await readdir(join(FIXTURES, 'manifests'))).map(file => file.replace(/\.json$/, '')).sort();
  assert.deepEqual(files, Object.keys(MANIFEST_CASES).sort());
});

for (const [name, pattern] of Object.entries(MANIFEST_CASES)) {
  test(`broken manifest ${name} fails with a clear message`, async () => {
    const root = await fixtureRoot((_, plugin) => cp(join(FIXTURES, 'manifests', `${name}.json`), manifestPath(plugin)));
    expectError(root, pattern);
  });
}

test('missing README, icon, skill and template files are reported', async () => {
  expectError(await fixtureRoot((_, plugin) => rm(join(plugin, 'README.md'))), /^fixture-pack: README\.md is missing or empty$/);
  expectError(await fixtureRoot((_, plugin) => rm(join(plugin, 'icon.svg'))), /^fixture-pack: icon icon\.svg does not exist in the plugin folder$/);
  expectError(await fixtureRoot((_, plugin) => rm(join(plugin, 'skills'), { recursive: true })), /skill fixture-skill: folder skills\/fixture-skill does not exist/);
  expectError(await fixtureRoot((_, plugin) => rm(join(plugin, 'skills/fixture-skill/SKILL.md'))), /skills\/fixture-skill\/SKILL\.md does not exist/);
  expectError(await fixtureRoot((_, plugin) => writeFile(join(plugin, 'skills/fixture-skill/SKILL.md'), '---\nname: other\ndescription: x\n---\n')), /skill fixture-skill: SKILL\.md is named other/);
  expectError(await fixtureRoot((_, plugin) => rm(join(plugin, 'templates/fixture-report/prompt.md'))), /automation template fixture-report: templates\/fixture-report needs template\.json and prompt\.md/);
  expectError(await fixtureRoot(async (_, plugin) => {
    const file = join(plugin, 'templates/fixture-report/template.json');
    await writeFile(file, (await readFile(file, 'utf8')).replace('"dry_run"', '"auto"'));
  }), /automation template fixture-report: fixture-report: autonomy must be dry_run/);
});

test('registry and folder mismatches are reported', async () => {
  expectError(await fixtureRoot(root => cp(join(root, 'fixture-pack'), join(root, 'stray-pack'), { recursive: true })), /^stray-pack: folder is not listed in registry\.json$/);
  expectError(await fixtureRoot(root => writeFile(join(root, 'registry.json'), JSON.stringify({ version: 1, plugins: [{ id: 'fixture-pack' }, { id: 'absent' }] }))), /^absent: manifest\.json does not exist$/);
  expectError(await fixtureRoot(root => writeFile(join(root, 'registry.json'), JSON.stringify({ version: 1, plugins: [{ id: 'fixture-pack' }, { id: 'fixture-pack' }] }))), /plugin fixture-pack is listed more than once/);
  expectError(await fixtureRoot(root => writeFile(join(root, 'registry.json'), JSON.stringify({ version: 1, plugins: [{ id: 'fixture-pack', hidden: true }] }))), /plugins\.0 must be/);
  expectError(await fixtureRoot((_, plugin) => editManifest(plugin, m => { m.id = 'other-pack'; })), /id other-pack must match the folder name fixture-pack/);
});

test('command names must be unique across plugins', async () => {
  const root = await fixtureRoot(async root => {
    await cp(join(root, 'fixture-pack'), join(root, 'second-pack'), { recursive: true });
    await editManifest(join(root, 'second-pack'), m => { m.id = 'second-pack'; });
    await writeFile(join(root, 'registry.json'), JSON.stringify({ version: 1, plugins: [{ id: 'fixture-pack' }, { id: 'second-pack' }] }));
  });
  expectError(root, /^second-pack: command status is also contributed by fixture-pack$/);
});

test('the command line exits 0 on success and 1 with every problem listed', async () => {
  const ok = await run(process.execPath, ['--import', 'tsx', SCRIPT, '--root', await fixtureRoot()]);
  assert.match(ok.stdout, /1 plugin checked/);
  const broken = await fixtureRoot(async (_, plugin) => {
    await rm(join(plugin, 'README.md'));
    await cp(join(FIXTURES, 'manifests', 'package-range.json'), manifestPath(plugin));
  });
  await assert.rejects(run(process.execPath, ['--import', 'tsx', SCRIPT, '--root', broken]), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /Plugin check failed \(2 problems\)/);
    assert.match(error.stderr, /fixture-pack: README\.md is missing or empty/);
    assert.match(error.stderr, /ranges and tags are not accepted/);
    return true;
  });
});

test('--online compares recorded integrity values with the registry', async () => {
  const { plugins } = checkPlugins({ root: await fixtureRoot() });
  const recorded = plugins[0].manifest.contributes.mcpServers[1].integrity;
  const requests = [];
  const registry = answers => async url => {
    requests.push(url);
    const answer = answers.shift();
    return new Response(answer === 404 ? '{}' : JSON.stringify({ dist: { integrity: answer } }), { status: answer === 404 ? 404 : 200 });
  };
  assert.deepEqual(await checkPackageIntegrity(plugins, { registry: 'https://registry.test/', fetch: registry([recorded]) }), []);
  assert.deepEqual(requests, ['https://registry.test/propr-fixture-mcp/1.0.0']);
  const [mismatch] = await checkPackageIntegrity(plugins, { registry: 'https://registry.test', fetch: registry([`sha512-${'B'.repeat(86)}==`]) });
  assert.match(mismatch, /^fixture-pack: server local \(propr-fixture-mcp@1\.0\.0\): recorded integrity does not match the registry/);
  const [missing] = await checkPackageIntegrity(plugins, { registry: 'https://registry.test', fetch: registry([404]) });
  assert.match(missing, /not found on https:\/\/registry\.test/);
});

test('arguments', () => {
  assert.equal(parseArguments(['--online']).online, true);
  assert.equal(parseArguments(['--registry', 'https://r.test']).registry, 'https://r.test');
  assert.throws(() => parseArguments(['--bogus']), /Unknown option --bogus/);
  assert.throws(() => parseArguments(['--root']), /--root needs a value/);
});
