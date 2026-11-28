import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  AUTHORING_PAGE, CATALOG_PAGE, SIDEBAR_FILE, catalogPage, firstSentence, generatePluginDocs, manifestReference, replaceGeneratedBlock, staleFiles,
} from '../scripts/gen-plugin-docs.mjs';
import { MANIFEST_FIELD_DESCRIPTIONS } from '../scripts/plugin-manifest-descriptions.mjs';
import { checkPlugins } from '../scripts/check-plugins.mjs';

const run = promisify(execFile);
const REPOSITORY = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(REPOSITORY, 'scripts/gen-plugin-docs.mjs');
const TSX = join(REPOSITORY, 'node_modules/.bin/tsx');
const scratch = await mkdtemp(join(tmpdir(), 'propr-plugin-docs-'));
after(() => rm(scratch, { recursive: true, force: true }));

let counter = 0;
/** A copy of the docs files the generator reads and writes. */
async function docsCopy() {
  const docs = join(scratch, `docs-${++counter}`);
  await mkdir(join(docs, 'docs/plugins'), { recursive: true });
  await cp(join(REPOSITORY, 'docs/docs/plugins'), join(docs, 'docs/plugins'), { recursive: true });
  await cp(join(REPOSITORY, 'docs', SIDEBAR_FILE), join(docs, SIDEBAR_FILE));
  await cp(join(REPOSITORY, 'docs/static/schemas'), join(docs, 'static/schemas'), { recursive: true });
  return docs;
}

test('the checked-in plugin docs are current', () => {
  // The drift check CI runs (npm run plugins:docs:check): reference, catalog, schema and sidebar.
  const { files, problems } = generatePluginDocs();
  assert.deepEqual(problems, []);
  assert.deepEqual(staleFiles(files).map(file => file.slice(REPOSITORY.length)), [], 'run npm run plugins:docs');
});

test('the check fails on a stale catalog, reference or sidebar and names the file', async () => {
  const docs = await docsCopy();
  const catalog = join(docs, CATALOG_PAGE);
  await writeFile(catalog, (await readFile(catalog, 'utf8')).replace('| Messaging |', '| Chat |'));
  const authoring = join(docs, AUTHORING_PAGE);
  await writeFile(authoring, (await readFile(authoring, 'utf8')).replace('| `manifestVersion` |', '| `manifestVersionX` |'));
  await writeFile(join(docs, SIDEBAR_FILE), '[]\n');
  const failed = await run(TSX, [SCRIPT, '--check', '--docs', docs], { cwd: REPOSITORY }).then(() => null, error => error);
  assert.equal(failed?.code, 1);
  for (const file of [CATALOG_PAGE, AUTHORING_PAGE, SIDEBAR_FILE]) assert.ok(failed.stderr.includes(file), `${file} in ${failed.stderr}`);
  // Writing brings them back, and the check passes again.
  await run(TSX, [SCRIPT, '--docs', docs], { cwd: REPOSITORY });
  const { stdout } = await run(TSX, [SCRIPT, '--check', '--docs', docs], { cwd: REPOSITORY });
  assert.match(stdout, /Plugin docs are current/);
  assert.equal(await readFile(catalog, 'utf8'), await readFile(join(REPOSITORY, 'docs', CATALOG_PAGE), 'utf8'));
});

test('every official plugin needs a docs page', async () => {
  const docs = await docsCopy();
  await rm(join(docs, 'docs/plugins/notion.md'));
  const { problems } = generatePluginDocs({ docs });
  assert.deepEqual(problems, ['notion: the official plugin has no docs page docs/docs/plugins/notion.md (npm run plugins:new creates one)']);
});

test('every manifest field needs a description, and every description a field', () => {
  const saved = MANIFEST_FIELD_DESCRIPTIONS.homepage;
  try {
    delete MANIFEST_FIELD_DESCRIPTIONS.homepage;
    MANIFEST_FIELD_DESCRIPTIONS['contributes.legacy'] = 'Gone.';
    assert.deepEqual(manifestReference().problems, [
      'manifest field homepage has no description in scripts/plugin-manifest-descriptions.mjs',
      'scripts/plugin-manifest-descriptions.mjs describes contributes.legacy, which the manifest schema does not have',
    ]);
  } finally {
    MANIFEST_FIELD_DESCRIPTIONS.homepage = saved;
    delete MANIFEST_FIELD_DESCRIPTIONS['contributes.legacy'];
  }
  assert.deepEqual(manifestReference().problems, []);
});

test('the authoring guide must keep its generated blocks', () => {
  assert.equal(replaceGeneratedBlock('a\n{/* BEGIN GENERATED x: npm run plugins:docs */}\nold\n{/* END GENERATED x: npm run plugins:docs */}\nb', 'x', 'new'),
    'a\n{/* BEGIN GENERATED x: npm run plugins:docs */}\n\nnew\n\n{/* END GENERATED x: npm run plugins:docs */}\nb');
  assert.throws(() => replaceGeneratedBlock('no markers', 'x', 'new'), /the x block .* is missing/);
});

test('the catalog lists official plugins only, with category and a one-line description', () => {
  const { plugins } = checkPlugins();
  const page = catalogPage(plugins);
  assert.match(page, /\| \[Slack\]\(\.\/slack\.md\) \(`slack`\) \| Messaging \| Posts short ProPR notifications/);
  assert.match(page, /\| \[Sentry\]\(\.\/sentry\.md\) \(`sentry`\) \| Observability \| Turns Sentry errors into GitHub issues for ProPR\. \|/);
  assert.doesNotMatch(page, /example-pack/);
  assert.equal(firstSentence('Hands tickets to ProPR. Then more.'), 'Hands tickets to ProPR.');
  assert.equal(firstSentence('Sends events (e.g. merges) to hooks.example.com. Done.'), 'Sends events (e.g. merges) to hooks.example.com.');
  assert.equal(firstSentence('No full stop'), 'No full stop');
});
