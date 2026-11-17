import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ESLint } from 'eslint';
import { checkPlugins } from '../scripts/check-plugins.mjs';
import { generatePluginDocs, staleFiles } from '../scripts/gen-plugin-docs.mjs';
import { EXAMPLE_HANDLER, parseArguments, registerPlugin, scaffoldPlugin, serializeRegistry, titleCase } from '../scripts/new-plugin.mjs';

const run = promisify(execFile);
const REPOSITORY = fileURLToPath(new URL('..', import.meta.url));
const PLUGINS = join(REPOSITORY, 'packages/plugins');
const BIN = join(REPOSITORY, 'node_modules/.bin');
// Inside the repository (so `@propr/shared` and the test kit resolve as they do for real plugins) but under
// node_modules, which the test runner and lint never walk.
const CACHE = join(REPOSITORY, 'node_modules/.cache');
let scratch;
let counter = 0;

before(async () => {
  await mkdir(CACHE, { recursive: true });
  scratch = await mkdtemp(join(CACHE, 'propr-new-plugin-'));
});
after(() => rm(scratch, { recursive: true, force: true }));

/** A registry root with one development plugin and the real test kit, and a docs folder with the authoring guide. */
async function workspace() {
  const base = join(scratch, `w${++counter}`);
  const root = join(base, 'plugins');
  const docs = join(base, 'docs');
  await mkdir(root, { recursive: true });
  await cp(join(PLUGINS, 'example-pack'), join(root, 'example-pack'), { recursive: true });
  await symlink(join(PLUGINS, 'testing'), join(root, 'testing'), 'dir');
  // As in packages/plugins, whose package.json makes .ts files ES modules.
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module', private: true }));
  await writeFile(join(root, 'registry.json'), serializeRegistry({ version: 1, plugins: [{ id: 'example-pack', development: true }] }));
  await mkdir(join(docs, 'docs/plugins'), { recursive: true });
  await cp(join(REPOSITORY, 'docs/docs/plugins/authoring.md'), join(docs, 'docs/plugins/authoring.md'));
  return { root, docs };
}

test('registry.json keeps its checked-in layout, and a new plugin goes before the development plugins', async () => {
  const text = await readFile(join(PLUGINS, 'registry.json'), 'utf8');
  assert.equal(serializeRegistry(JSON.parse(text)), text);
  const registered = registerPlugin({ version: 1, plugins: [{ id: 'a' }, { id: 'dev', development: true }] }, 'b');
  assert.deepEqual(registered.plugins, [{ id: 'a' }, { id: 'b' }, { id: 'dev', development: true }]);
  assert.deepEqual(registerPlugin({ version: 1, plugins: [{ id: 'a' }] }, 'b').plugins, [{ id: 'a' }, { id: 'b' }]);
  assert.equal(titleCase('acme-chat'), 'Acme Chat');
});

test('the arguments are an id and options', () => {
  assert.deepEqual(parseArguments(['acme', '--name', 'Acme', '--category', 'messaging']).id, 'acme');
  assert.throws(() => parseArguments([]), /Usage: npm run plugins:new/);
  assert.throws(() => parseArguments(['a', 'b']), /one plugin id/);
  assert.throws(() => parseArguments(['a', '--bogus']), /Unknown option --bogus/);
});

test('the scaffold passes plugins:check, lint, typecheck, the docs check and its own test without edits', async () => {
  const { root, docs } = await workspace();
  const written = scaffoldPlugin({ id: 'acme-chat', name: 'Acme Chat', category: 'messaging', root, docs });
  for (const file of ['acme-chat/manifest.json', 'acme-chat/README.md', 'acme-chat/icon.svg', 'acme-chat/handlers.ts', 'test/acme-chat.test.ts', 'registry.json']) {
    assert.ok(written.includes(join(root, file)), file);
  }
  assert.ok(written.includes(join(docs, 'docs/plugins/acme-chat.md')));
  assert.ok(written.includes(join(docs, 'docs/plugins/catalog.md')), 'the catalog is regenerated');

  // plugins:check
  const { errors, plugins } = checkPlugins({ root });
  assert.deepEqual(errors, []);
  assert.deepEqual(plugins.map(p => p.id), ['acme-chat', 'example-pack']);
  const { manifest } = plugins[0];
  assert.equal(manifest.category, 'messaging');
  assert.deepEqual(manifest.contributes.subscriptions, [{ on: 'pull_request.merged', handler: EXAMPLE_HANDLER }]);

  // The README template has the sections the issue asks for.
  const readme = await readFile(join(root, 'acme-chat/README.md'), 'utf8');
  for (const heading of ['## Setup', '## Permissions', '## Smoke-test checklist', '## Documentation']) assert.ok(readme.includes(heading), heading);

  // The docs are current: catalog, sidebar and reference include the new plugin.
  const generated = generatePluginDocs({ root, docs });
  assert.deepEqual(generated.problems, []);
  assert.deepEqual(staleFiles(generated.files), []);
  assert.match(await readFile(join(docs, 'docs/plugins/catalog.md'), 'utf8'), /\[Acme Chat\]\(\.\/acme-chat\.md\) \(`acme-chat`\) \| Messaging \|/);
  assert.deepEqual(JSON.parse(await readFile(join(docs, 'plugin-pages.json'), 'utf8')), ['plugins/acme-chat']);

  // Lint, with the configuration of a real plugin folder.
  const eslint = new ESLint({ cwd: REPOSITORY });
  const lint = async (file, as) => (await eslint.lintText(await readFile(file, 'utf8'), { filePath: join(REPOSITORY, as) }))[0];
  for (const [file, as] of [[join(root, 'acme-chat/handlers.ts'), 'packages/plugins/acme-chat/handlers.ts'], [join(root, 'test/acme-chat.test.ts'), 'packages/plugins/test/acme-chat.test.ts']]) {
    const result = await lint(file, as);
    assert.equal(result.errorCount + result.warningCount, 0, `${as}: ${JSON.stringify(result.messages)}`);
  }
  // The lint configuration does apply to that path: a core import is refused.
  const refused = (await eslint.lintText("import { db } from '@propr/core';\nexport const x = db;\n", { filePath: join(REPOSITORY, 'packages/plugins/acme-chat/handlers.ts') }))[0];
  assert.ok(refused.messages.some(message => message.ruleId === 'no-restricted-imports'), JSON.stringify(refused.messages));

  // Typecheck the handlers and the test as the plugins package does.
  const tsconfig = join(root, 'tsconfig.json');
  await writeFile(tsconfig, JSON.stringify({
    extends: join(PLUGINS, 'tsconfig.json'),
    compilerOptions: { noEmit: true, rootDir: root, types: ['node'] },
    include: [],
    files: [join(root, 'acme-chat/handlers.ts'), join(root, 'test/acme-chat.test.ts')],
  }));
  await run(join(BIN, 'tsc'), ['-p', tsconfig], { cwd: REPOSITORY, timeout: 120_000 }).catch(error => assert.fail(`tsc: ${error.stdout}${error.stderr}`));

  // The generated test passes. Run as a script: `--test` skips files under node_modules.
  // Without the parent runner's NODE_TEST_CONTEXT, the child reports in plain TAP.
  const { NODE_TEST_CONTEXT: _parent, ...env } = process.env;
  const { stdout } = await run(join(BIN, 'tsx'), ['--test-reporter=tap', join(root, 'test/acme-chat.test.ts')], { cwd: REPOSITORY, env, timeout: 120_000 })
    .catch(error => assert.fail(`generated test failed:\n${error.stdout}${error.stderr}`));
  assert.match(stdout, /# pass 3\n# fail 0/);
});

test('the scaffold refuses ids that are taken, reserved or malformed, and unknown categories', async () => {
  const { root, docs } = await workspace();
  assert.throws(() => scaffoldPlugin({ id: 'example-pack', root, docs }), /already listed in registry\.json/);
  assert.throws(() => scaffoldPlugin({ id: 'Acme', root, docs }), /not a plugin id/);
  assert.throws(() => scaffoldPlugin({ id: 'testing', root, docs }), /reserved/);
  assert.throws(() => scaffoldPlugin({ id: '_shared', root, docs }), /not a plugin id|reserved/);
  assert.throws(() => scaffoldPlugin({ id: 'acme', category: 'chat', root, docs }), /--category must be one of/);
  await mkdir(join(root, 'stray'));
  assert.throws(() => scaffoldPlugin({ id: 'stray', root, docs }), /already exists/);
  // Nothing was registered by a refused run.
  assert.deepEqual(JSON.parse(await readFile(join(root, 'registry.json'), 'utf8')).plugins, [{ id: 'example-pack', development: true }]);
});

test('npm run plugins:new prints what it wrote', async () => {
  const { root, docs } = await workspace();
  const { stdout } = await run(join(BIN, 'tsx'), [join(REPOSITORY, 'scripts/new-plugin.mjs'), 'status-board', '--root', root, '--docs', docs, '--category', 'deployment'], { cwd: REPOSITORY, timeout: 60_000 });
  assert.match(stdout, /wrote .*status-board\/manifest\.json/);
  assert.match(stdout, /Next: edit the manifest/);
  assert.equal(JSON.parse(await readFile(join(root, 'status-board/manifest.json'), 'utf8')).name, 'Status Board');
  const failed = await run(join(BIN, 'tsx'), [join(REPOSITORY, 'scripts/new-plugin.mjs'), 'status-board', '--root', root, '--docs', docs], { cwd: REPOSITORY, timeout: 60_000 }).then(() => null, error => error);
  assert.equal(failed?.code, 1);
  assert.match(failed.stderr, /plugins:new: status-board is already listed/);
});
