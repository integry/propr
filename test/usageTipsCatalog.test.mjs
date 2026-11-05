import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { CATALOG_PATH, DOCS_ORIGIN, DOCS_ROUTE_BASE, generateUsageTips, headingAnchors, verifyBuiltDocTarget,
  verifyDocTarget } from '../scripts/generate-usage-tips.mjs';

const scratch = await mkdtemp(join(tmpdir(), 'propr-usage-tips-'));
after(() => rm(scratch, { recursive: true, force: true }));
const catalog = JSON.parse(await readFile(CATALOG_PATH, 'utf8'));

test('committed catalog matches the generator output', async () => {
  assert.deepEqual(await generateUsageTips(), catalog);
});

test('every tip links to an existing docs page and heading under the /docs route base', () => {
  assert.equal(`${DOCS_ORIGIN}${DOCS_ROUTE_BASE}`, 'https://docs.propr.dev/docs/');
  for (const tip of catalog) {
    assert.ok(tip.docUrl.startsWith('https://docs.propr.dev/docs/'), tip.docUrl);
    assert.doesNotThrow(() => verifyDocTarget(tip.docUrl), tip.id);
  }
  const urls = Object.fromEntries(catalog.map(tip => [tip.id, tip.docUrl]));
  assert.equal(urls['planner-studio'], 'https://docs.propr.dev/docs/features/planning');
  assert.equal(urls['pr-review'], 'https://docs.propr.dev/docs/features/pr-commands#review');
  assert.equal(urls['mcp-access'], 'https://docs.propr.dev/docs/features/web-ui#mcp-access-log');
});

test('rejects routes without the docs base, missing pages and missing headings', () => {
  assert.throws(() => verifyDocTarget('https://docs.propr.dev/features/planning'), /Not a docs route/);
  assert.throws(() => verifyDocTarget('https://propr.dev/docs/features/planning'), /Not a docs route/);
  assert.throws(() => verifyDocTarget('https://docs.propr.dev/docs/features/no-such-page'), /Missing docs page/);
  assert.throws(() => verifyDocTarget('https://docs.propr.dev/docs/features/planning#no-such-heading'), /Missing heading/);
});

test('heading anchors follow Docusaurus slugging', () => {
  const anchors = headingAnchors([
    '---', 'title: Ignored', '---', '# Page', '### `/review`', '## Goals & Launch Strategies',
    '## Custom {#custom-id}', '## Repeat', '## Repeat', '```md', '## Not A Heading', '```',
  ].join('\n'));
  assert.deepEqual([...anchors], ['page', 'review', 'goals--launch-strategies', 'custom-id', 'repeat', 'repeat-1']);
});

test('built-site verification checks routes, sitemap entries and rendered heading IDs', async () => {
  const site = join(scratch, 'site');
  await mkdir(join(site, 'docs', 'features', 'planning'), { recursive: true });
  await writeFile(join(site, 'docs', 'features', 'planning', 'index.html'), '<h2 class=anchor id=running-from-a-plan>x</h2><p id="quoted">');
  await writeFile(join(site, 'sitemap.xml'), '<url><loc>https://docs.propr.dev/docs/features/planning</loc></url>');
  verifyBuiltDocTarget('https://docs.propr.dev/docs/features/planning#running-from-a-plan', site);
  verifyBuiltDocTarget('https://docs.propr.dev/docs/features/planning#quoted', site);
  assert.throws(() => verifyBuiltDocTarget('https://docs.propr.dev/docs/features/planning#running', site), /has no #running/);
  assert.throws(() => verifyBuiltDocTarget('https://docs.propr.dev/features/planning', site), /no route/);
  await writeFile(join(site, 'sitemap.xml'), '<urlset></urlset>');
  assert.throws(() => verifyBuiltDocTarget('https://docs.propr.dev/docs/features/planning', site), /sitemap omits/);
});
