import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { DOCKERFILE_PATH, SERVE_CONFIG_PATH, describeHtml, parseDocsServeCommand }
  from '../scripts/check-docs-static-serving.mjs';

test('docs image serves Docusaurus routes as static files, not as a single-page app', async () => {
  const dockerfile = await readFile(DOCKERFILE_PATH, 'utf8');
  const { version, args } = parseDocsServeCommand(dockerfile);
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(args, ['build', '--config', '../serve.json', '-l', 'tcp://0.0.0.0:3000']);
  assert.match(dockerfile, /^COPY serve\.json \/app\/serve\.json$/m);
  const config = JSON.parse(await readFile(SERVE_CONFIG_PATH, 'utf8'));
  assert.deepEqual(config, { cleanUrls: true, directoryListing: false });
});

test('rejects single-page mode and unpinned serve installs', () => {
  const pinned = 'RUN npm install -g serve@14.2.6\n';
  assert.throws(() => parseDocsServeCommand(`${pinned}CMD ["serve", "-s", "build", "-l", "tcp://0.0.0.0:3000"]`), /single-page mode/);
  assert.throws(() => parseDocsServeCommand(`${pinned}CMD ["serve", "--single", "build", "-l", "tcp://0.0.0.0:3000"]`), /single-page mode/);
  assert.throws(() => parseDocsServeCommand('RUN npm install -g serve\nCMD ["serve", "build", "-l", "tcp://0.0.0.0:3000"]'), /exact serve/);
  assert.throws(() => parseDocsServeCommand(`${pinned}CMD serve build`), /exec-form CMD/);
});

test('reads title, canonical URL and IDs from minified Docusaurus HTML', () => {
  const page = describeHtml('<title data-rh=true>Planning Before Execution | ProPR</title>'
    + '<link data-rh=true rel=canonical href=https://docs.propr.dev/docs/features/planning>'
    + '<h2 class="anchor" id=running-from-a-plan>x</h2><div id="__docusaurus">');
  assert.equal(page.title, 'Planning Before Execution | ProPR');
  assert.equal(page.canonical, 'https://docs.propr.dev/docs/features/planning');
  assert.deepEqual([...page.ids], ['running-from-a-plan', '__docusaurus']);
  assert.equal(describeHtml('<link rel="canonical" href="https://docs.propr.dev/">').canonical, 'https://docs.propr.dev/');
});
